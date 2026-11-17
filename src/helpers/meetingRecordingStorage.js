// FORK: stored meeting audio (specs/meeting-audio-recording/design.md §2.3-2.6).
//
// Owns userData/audio/meetings/: the per-session recorders while a meeting
// records (.partial/<sessionId>/), the encoded stereo WebM/Opus files (left =
// mic, right = system) and their note_recordings rows. Dictation audio lives
// one level up and its code reads that folder without recursion, so the two
// never see each other's files.
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const {
  createMeetingAudioRecorder,
  readMeetingRecordingMeta,
  padMeetingPcmToEqualLength,
  MEETING_RECORDING_SAMPLE_RATE,
} = require("./meetingAudioRecorder");

const { segmentBySilence, mergeSpeakerTurns } = require("./meetingRetranscribeChunks");

const PARTIAL_DIR = ".partial";
const JOB_PREFIX = "ow-retx-";
const JOB_STALE_MS = 24 * 60 * 60 * 1000;
const RETRANSCRIBE_SAMPLE_RATE = 16000;
const ENCODING_FILE = "encoding.webm";
const MIN_RECORDING_MS = 1000;
// A .partial folder that never got a usable meta.json (crash during setup) is
// only removed once it is clearly stale, never while a session could own it.
const STALE_PARTIAL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Records only where dictation would keep its audio (audioManager.js): local
// history on, an audio retention period set, and the settings actually synced
// from the renderer -- before that they are defaults, not the user's choice.
function meetingAudioRecordingAllowed(settings, synced) {
  return Boolean(
    synced &&
    settings?.dataRetentionEnabled !== false &&
    Number(settings?.audioRetentionDays) > 0 &&
    settings?.saveMeetingAudio !== false
  );
}

const safeSessionId = (sessionId) => String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");

// The PCM16 payload of a WAV file (the "data" chunk), wherever it sits.
function readPcm16WavSamples(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const start = offset + 8;
      const end = Math.min(buffer.length, start + size);
      const data = buffer.subarray(start, end - ((end - start) % 2));
      // Copy into an aligned buffer: Int16Array needs an even byte offset.
      const aligned = Buffer.from(data);
      return new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

function buildRecordingFileName(sessionId, startedAt) {
  const d = new Date(startedAt);
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `OpenWhispr-Meeting-${date}-${time}-${safeSessionId(sessionId)}.webm`;
}

class MeetingRecordingStorage {
  constructor({
    baseDir,
    getDatabase,
    encode = (...args) => require("./ffmpegUtils").encodeStereoPcmToOpus(...args),
    extractChannel = (...args) => require("./ffmpegUtils").extractChannelToWav(...args),
    getTempDir = () => require("./safeTempDir").getSafeTempDir(),
    onChanged = () => {},
    now = Date.now,
  }) {
    this.baseDir = baseDir;
    this.partialRoot = path.join(baseDir, PARTIAL_DIR);
    this.getDatabase = getDatabase;
    this.encode = encode;
    this.extractChannel = extractChannel;
    this.getTempDir = getTempDir;
    this.onChanged = onChanged;
    this.now = now;
    // Session ids with a live recorder or a finalize in flight; recovery skips them.
    this.busySessions = new Set();
  }

  _ensureDirs() {
    fs.mkdirSync(this.partialRoot, { recursive: true });
  }

  // Returns a recorder for the session, or null when recording is not allowed
  // or the session can't be tied to a note.
  startSession({ sessionId, noteId, startedAt, allowed }) {
    if (!allowed || !sessionId || noteId == null) return null;
    try {
      this._ensureDirs();
      const recorder = createMeetingAudioRecorder({
        dir: path.join(this.partialRoot, safeSessionId(sessionId)),
        sessionId: String(sessionId),
        noteId,
        startedAt,
      });
      this.busySessions.add(recorder.sessionId);
      debugLogger.info("Meeting audio recording started", { sessionId, noteId }, "meeting-audio");
      return recorder;
    } catch (error) {
      debugLogger.error(
        "Failed to start meeting audio recording",
        { sessionId, error: error.message },
        "meeting-audio"
      );
      return null;
    }
  }

  async discardSession(recorder) {
    if (!recorder) return;
    try {
      await recorder.discard();
    } catch (error) {
      debugLogger.warn(
        "Failed to discard meeting audio",
        { sessionId: recorder.sessionId, error: error.message },
        "meeting-audio"
      );
    } finally {
      this.busySessions.delete(recorder.sessionId);
    }
  }

  // Stops the recorder and encodes its audio; resolves with the saved row or
  // null. Never rejects: a failed encode keeps the raw audio for the next
  // start's recovery.
  async finalizeSession(recorder) {
    if (!recorder) return null;
    try {
      const { failed } = await recorder.close();
      if (failed) {
        debugLogger.warn(
          "Meeting audio write failed during recording",
          { sessionId: recorder.sessionId, error: failed.message },
          "meeting-audio"
        );
      }
      return await this._finalizePartial(recorder.dir);
    } catch (error) {
      debugLogger.error(
        "Failed to finalize meeting audio",
        { sessionId: recorder.sessionId, error: error.message },
        "meeting-audio"
      );
      return null;
    } finally {
      this.busySessions.delete(recorder.sessionId);
    }
  }

  async _finalizePartial(dir) {
    const meta = readMeetingRecordingMeta(dir);
    if (!meta) throw new Error(`No meeting recording metadata in ${dir}`);

    const { micPath, systemPath, samples } = await padMeetingPcmToEqualLength(dir);
    const durationMs = Math.round((samples * 1000) / MEETING_RECORDING_SAMPLE_RATE);
    if (durationMs < MIN_RECORDING_MS) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return null;
    }

    const encodingPath = path.join(dir, ENCODING_FILE);
    await this.encode(micPath, systemPath, encodingPath);

    const fileName = buildRecordingFileName(meta.sessionId, meta.startedAt);
    const filePath = path.join(this.baseDir, fileName);
    await fs.promises.rename(encodingPath, filePath);
    const sizeBytes = (await fs.promises.stat(filePath)).size;

    let row;
    try {
      row = this.getDatabase().addNoteRecording({
        id: meta.sessionId,
        noteId: meta.noteId,
        fileName,
        startedAt: meta.startedAt,
        durationMs,
        sizeBytes,
      });
    } catch (error) {
      // The note is gone (deleted while recording): nothing to attach it to.
      debugLogger.warn(
        "Dropping meeting audio with no note to attach to",
        { sessionId: meta.sessionId, noteId: meta.noteId, error: error.message },
        "meeting-audio"
      );
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rm(dir, { recursive: true, force: true });
      return null;
    }

    await fs.promises.rm(dir, { recursive: true, force: true });
    debugLogger.info(
      "Meeting audio saved",
      { sessionId: meta.sessionId, noteId: meta.noteId, durationMs, sizeBytes },
      "meeting-audio"
    );
    this.onChanged(meta.noteId);
    return row;
  }

  // Encodes sessions a crash or quit left in .partial. Runs at startup.
  async recoverPartials() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.partialRoot, { withFileTypes: true });
    } catch {
      return { recovered: 0 };
    }
    let recovered = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || this.busySessions.has(entry.name)) continue;
      const dir = path.join(this.partialRoot, entry.name);
      const meta = readMeetingRecordingMeta(dir);
      if (!meta) {
        await this._removeIfStale(dir);
        continue;
      }
      if (this.busySessions.has(meta.sessionId)) continue;
      this.busySessions.add(meta.sessionId);
      try {
        if (await this._finalizePartial(dir)) recovered++;
      } catch (error) {
        debugLogger.warn(
          "Could not recover meeting audio; will retry next start",
          { sessionId: meta.sessionId, error: error.message },
          "meeting-audio"
        );
      } finally {
        this.busySessions.delete(meta.sessionId);
      }
    }
    if (recovered > 0) {
      debugLogger.info("Recovered interrupted meeting audio", { recovered }, "meeting-audio");
    }
    return { recovered };
  }

  async _removeIfStale(dir) {
    try {
      const stats = await fs.promises.stat(dir);
      if (this.now() - stats.mtimeMs > STALE_PARTIAL_MS) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    } catch {}
  }

  _withPath(row) {
    return row ? { ...row, file_path: path.join(this.baseDir, row.file_name) } : null;
  }

  listForNote(noteId) {
    return this.getDatabase()
      .getNoteRecordings(noteId)
      .map((row) => this._withPath(row))
      .filter((row) => fs.existsSync(row.file_path));
  }

  getRecording(id) {
    const row = this._withPath(this.getDatabase().getNoteRecording(id));
    return row && fs.existsSync(row.file_path) ? row : null;
  }

  _deleteRow(row) {
    try {
      fs.rmSync(path.join(this.baseDir, row.file_name), { force: true });
    } catch (error) {
      debugLogger.warn(
        "Failed to delete meeting audio file",
        { file: row.file_name, error: error.message },
        "meeting-audio"
      );
      return false;
    }
    this.getDatabase().deleteNoteRecording(row.id);
    return true;
  }

  _notifyNotes(rows) {
    for (const noteId of new Set(rows.map((row) => row.note_id))) this.onChanged(noteId);
  }

  // Device-wide, like dictation audio cleanup.
  cleanupExpired(retentionDays) {
    if (!(retentionDays > 0)) return { deleted: 0 };
    const expired = this.getDatabase().getExpiredNoteRecordings(
      this.now() - retentionDays * DAY_MS
    );
    const deleted = expired.filter((row) => this._deleteRow(row));
    this._notifyNotes(deleted);
    if (deleted.length > 0) {
      debugLogger.info(
        "Expired meeting audio deleted",
        { deleted: deleted.length, retentionDays },
        "meeting-audio"
      );
    }
    return { deleted: deleted.length };
  }

  // A note's rows go with it (ON DELETE CASCADE) from whichever path deletes
  // it; this removes the files left behind. Rows whose file was removed by
  // hand go too, so the UI never offers audio that isn't there.
  reconcileOrphans() {
    let files;
    try {
      files = fs.readdirSync(this.baseDir).filter((name) => name.endsWith(".webm"));
    } catch {
      return { deletedFiles: 0, deletedRows: 0 };
    }
    const db = this.getDatabase();
    const rows = db.getAllNoteRecordings();
    const known = new Set(rows.map((row) => row.file_name));
    // A finalize moves its file in just before it writes the row; that file
    // isn't an orphan yet.
    const inFlight = [...this.busySessions].map((id) => `-${safeSessionId(id)}.webm`);
    let deletedFiles = 0;
    for (const name of files) {
      if (known.has(name) || inFlight.some((suffix) => name.endsWith(suffix))) continue;
      try {
        fs.rmSync(path.join(this.baseDir, name), { force: true });
        deletedFiles++;
      } catch {}
    }
    const present = new Set(files);
    let deletedRows = 0;
    for (const row of rows) {
      if (present.has(row.file_name)) continue;
      if (db.deleteNoteRecording(row.id).success) {
        deletedRows++;
        this.onChanged(row.note_id);
      }
    }
    if (deletedFiles + deletedRows > 0) {
      debugLogger.info("Meeting audio reconciled", { deletedFiles, deletedRows }, "meeting-audio");
    }
    return { deletedFiles, deletedRows };
  }

  // The active account's recordings, like the dictation storage figure.
  getStorageUsage() {
    let totalBytes = 0;
    let fileCount = 0;
    for (const row of this.getDatabase().getVisibleNoteRecordings()) {
      try {
        totalBytes += fs.statSync(path.join(this.baseDir, row.file_name)).size;
        fileCount++;
      } catch {}
    }
    return { fileCount, totalBytes };
  }

  deleteAllVisible() {
    const rows = this.getDatabase().getVisibleNoteRecordings();
    const deleted = rows.filter((row) => this._deleteRow(row));
    this._notifyNotes(deleted);
    return { deleted: deleted.length };
  }

  // --- Re-transcription work files (design.md §3.1) -------------------------
  // A job folder ow-retx-* in the safe temp dir holds one mono 16 kHz WAV per
  // channel and recording, then one WAV per piece. That dir is one the file
  // transcription and diarization handlers accept (resolveAllowedAudioPath).

  _jobFiles(jobDir, recordingId) {
    const base = safeSessionId(recordingId);
    return {
      micPath: path.join(jobDir, `${base}-mic.wav`),
      systemPath: path.join(jobDir, `${base}-system.wav`),
    };
  }

  // The realpath of a job folder this class made, or null for anything else,
  // so a renderer can't point cleanup or chunking at an arbitrary folder.
  resolveJobDir(jobDir) {
    if (typeof jobDir !== "string" || !jobDir) return null;
    try {
      const real = fs.realpathSync(jobDir);
      const root = fs.realpathSync(this.getTempDir());
      if (path.dirname(real) !== root || !path.basename(real).startsWith(JOB_PREFIX)) return null;
      return fs.statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  async splitForRetranscribe(noteId, { signal } = {}) {
    const recordings = this.listForNote(noteId);
    if (recordings.length === 0) {
      return { success: false, code: "NO_RECORDINGS", error: "This note has no stored audio" };
    }
    const jobDir = await fs.promises.mkdtemp(path.join(this.getTempDir(), JOB_PREFIX));
    try {
      const result = [];
      for (const recording of recordings) {
        signal?.throwIfAborted();
        const { micPath, systemPath } = this._jobFiles(jobDir, recording.id);
        const options = { sampleRate: RETRANSCRIBE_SAMPLE_RATE, signal };
        await this.extractChannel(recording.file_path, 0, micPath, options);
        await this.extractChannel(recording.file_path, 1, systemPath, options);
        result.push({
          id: recording.id,
          startedAt: recording.started_at,
          durationMs: recording.duration_ms,
          micPath,
          systemPath,
        });
      }
      return { success: true, jobDir, recordings: result };
    } catch (error) {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
      throw error;
    }
  }

  // Cuts one recording's channels into pieces (mic: utterances; system:
  // diarization turns when given, otherwise utterances) and writes a WAV for
  // each. startMs/endMs are epoch ms, like live meeting segments.
  async buildRetranscribeChunks({ jobDir, recordingId, systemTurns = null, signal } = {}) {
    const realJobDir = this.resolveJobDir(jobDir);
    if (!realJobDir) return { success: false, code: "INVALID_JOB", error: "Unknown job folder" };
    const recording = this.getRecording(recordingId);
    if (!recording) return { success: false, code: "NO_RECORDINGS", error: "Recording not found" };

    const { pcm16ToWav } = require("../utils/audioUtils");
    const files = this._jobFiles(realJobDir, recording.id);
    const chunks = [];
    const toSampleIndex = (ms) => Math.round((ms * RETRANSCRIBE_SAMPLE_RATE) / 1000);

    for (const source of ["mic", "system"]) {
      signal?.throwIfAborted();
      const samples = readPcm16WavSamples(
        await fs.promises.readFile(source === "mic" ? files.micPath : files.systemPath)
      );
      const pieces =
        source === "system" && Array.isArray(systemTurns) && systemTurns.length > 0
          ? mergeSpeakerTurns(systemTurns)
          : segmentBySilence(samples, RETRANSCRIBE_SAMPLE_RATE);

      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index];
        const start = Math.min(samples.length, toSampleIndex(piece.startMs));
        const end = Math.min(samples.length, toSampleIndex(piece.endMs));
        if (end <= start) continue;
        const pcm = Buffer.from(samples.buffer, samples.byteOffset + start * 2, (end - start) * 2);
        const chunkPath = path.join(
          realJobDir,
          `${safeSessionId(recording.id)}-${source}-${String(index).padStart(4, "0")}.wav`
        );
        await fs.promises.writeFile(chunkPath, pcm16ToWav(pcm, RETRANSCRIBE_SAMPLE_RATE, 1));
        chunks.push({
          path: chunkPath,
          source,
          startMs: recording.started_at + piece.startMs,
          endMs: recording.started_at + piece.endMs,
          ...(piece.speaker ? { speaker: piece.speaker } : {}),
        });
      }
    }
    chunks.sort((a, b) => a.startMs - b.startMs || (a.source === "mic" ? -1 : 1));
    return { success: true, chunks };
  }

  async cleanupJob(jobDir) {
    const real = this.resolveJobDir(jobDir);
    if (!real) return { success: false };
    await fs.promises.rm(real, { recursive: true, force: true });
    return { success: true };
  }

  // Job folders a crash or a closed window left behind.
  async sweepStaleJobs() {
    try {
      const root = this.getTempDir();
      for (const name of await fs.promises.readdir(root)) {
        if (!name.startsWith(JOB_PREFIX)) continue;
        const dir = path.join(root, name);
        try {
          if (this.now() - (await fs.promises.stat(dir)).mtimeMs > JOB_STALE_MS) {
            await fs.promises.rm(dir, { recursive: true, force: true });
          }
        } catch {}
      }
    } catch {}
  }
}

module.exports = {
  MeetingRecordingStorage,
  meetingAudioRecordingAllowed,
  buildRecordingFileName,
  readPcm16WavSamples,
};
