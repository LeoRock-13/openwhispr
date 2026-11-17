// FORK: specs/meeting-audio-recording/design.md §2.3-2.6.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MeetingRecordingStorage,
  meetingAudioRecordingAllowed,
  buildRecordingFileName,
} = require("../../src/helpers/meetingRecordingStorage");
const { getFFmpegPath, encodeStereoPcmToOpus } = require("../../src/helpers/ffmpegUtils");

const RATE = 24000;
const START = 1_800_000_000_000;

// In-memory stand-in for the note_recordings methods of DatabaseManager.
function fakeDatabase({ notes = [1], visibleNotes = null } = {}) {
  const rows = new Map();
  const noteIds = new Set(notes);
  const visible = (row) => (visibleNotes ? visibleNotes.includes(row.note_id) : true);
  return {
    rows,
    noteIds,
    addNoteRecording({ id, noteId, fileName, startedAt, durationMs, sizeBytes }) {
      if (!noteIds.has(noteId)) throw new Error("FOREIGN KEY constraint failed");
      const row = {
        id,
        note_id: noteId,
        file_name: fileName,
        started_at: startedAt,
        duration_ms: durationMs,
        size_bytes: sizeBytes,
      };
      rows.set(id, row);
      return row;
    },
    getNoteRecordings: (noteId) =>
      [...rows.values()].filter((r) => r.note_id === noteId && visible(r)),
    getNoteRecording: (id) => (rows.has(id) && visible(rows.get(id)) ? rows.get(id) : null),
    deleteNoteRecording: (id) => ({ success: rows.delete(id) }),
    getExpiredNoteRecordings: (cutoff) => [...rows.values()].filter((r) => r.started_at < cutoff),
    getAllNoteRecordings: () => [...rows.values()],
    getVisibleNoteRecordings: () => [...rows.values()].filter(visible),
  };
}

const fakeEncode = async (micPath, systemPath, outputPath) => {
  const size = fs.statSync(micPath).size + fs.statSync(systemPath).size;
  fs.writeFileSync(outputPath, Buffer.alloc(Math.max(1, Math.floor(size / 10))));
};

function setup(t, { db = fakeDatabase(), encode = fakeEncode, now = () => START } = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-storage-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const changed = [];
  const storage = new MeetingRecordingStorage({
    baseDir,
    getDatabase: () => db,
    encode,
    onChanged: (noteId) => changed.push(noteId),
    now,
  });
  return { storage, db, baseDir, changed };
}

const tone = (ms) => Buffer.alloc(Math.round((ms * RATE) / 1000) * 2, 1);
const allowed = true;

function record(storage, { sessionId = "s1", noteId = 1, ms = 2000 } = {}) {
  const recorder = storage.startSession({ sessionId, noteId, startedAt: START, allowed });
  recorder.write("mic", tone(ms), { capturedAt: START + ms });
  recorder.write("system", tone(ms / 2), { capturedAt: START + ms });
  return recorder;
}

test("recording is allowed only with history on, a retention period, synced settings and the switch on", () => {
  const ok = { dataRetentionEnabled: true, audioRetentionDays: 30, saveMeetingAudio: true };
  assert.equal(meetingAudioRecordingAllowed(ok, true), true);
  assert.equal(meetingAudioRecordingAllowed(ok, false), false);
  assert.equal(meetingAudioRecordingAllowed({ ...ok, dataRetentionEnabled: false }, true), false);
  assert.equal(meetingAudioRecordingAllowed({ ...ok, audioRetentionDays: 0 }, true), false);
  assert.equal(meetingAudioRecordingAllowed({ ...ok, saveMeetingAudio: false }, true), false);
  // A renderer that predates the switch never turns recording off.
  const { saveMeetingAudio: _omit, ...legacy } = ok;
  assert.equal(meetingAudioRecordingAllowed(legacy, true), true);
});

test("the file name carries the local start time and a safe session id", () => {
  const name = buildRecordingFileName("ab/c..d", new Date(2026, 10, 17, 9, 5, 3).getTime());
  assert.equal(name, "OpenWhispr-Meeting-2026-11-17-09-05-03-ab_c__d.webm");
});

test("no recorder without permission or without a note", (t) => {
  const { storage } = setup(t);
  assert.equal(
    storage.startSession({ sessionId: "s", noteId: 1, startedAt: START, allowed: false }),
    null
  );
  assert.equal(
    storage.startSession({ sessionId: "s", noteId: null, startedAt: START, allowed }),
    null
  );
});

test("finalize encodes, saves the row, removes the partial folder and notifies", async (t) => {
  const { storage, db, baseDir, changed } = setup(t);
  const recorder = record(storage);

  const row = await storage.finalizeSession(recorder);

  assert.equal(row.id, "s1");
  assert.equal(row.note_id, 1);
  assert.equal(row.duration_ms, 2000);
  assert.ok(fs.existsSync(path.join(baseDir, row.file_name)));
  assert.equal(fs.existsSync(recorder.dir), false);
  assert.deepEqual(changed, [1]);
  assert.equal(storage.listForNote(1)[0].file_path, path.join(baseDir, row.file_name));
  assert.equal(db.rows.size, 1);
});

test("a recording shorter than a second is dropped", async (t) => {
  const { storage, db } = setup(t);
  const recorder = record(storage, { ms: 400 });
  assert.equal(await storage.finalizeSession(recorder), null);
  assert.equal(db.rows.size, 0);
  assert.equal(fs.existsSync(recorder.dir), false);
});

test("a failed encode keeps the raw audio and recovery finishes it later", async (t) => {
  let fail = true;
  const encode = async (...args) => {
    if (fail) throw new Error("ffmpeg crashed");
    return fakeEncode(...args);
  };
  const { storage, db } = setup(t, { encode });
  const recorder = record(storage);

  assert.equal(await storage.finalizeSession(recorder), null);
  assert.ok(fs.existsSync(recorder.dir), "raw audio kept for recovery");
  assert.equal(db.rows.size, 0);

  fail = false;
  assert.deepEqual(await storage.recoverPartials(), { recovered: 1 });
  assert.equal(db.rows.size, 1);
  assert.equal(fs.existsSync(recorder.dir), false);
});

test("recovery finishes a session left behind by a crash but never a live one", async (t) => {
  const { storage, db } = setup(t);
  const crashed = record(storage, { sessionId: "crashed" });
  await crashed.close(); // the process died here: no finalize
  storage.busySessions.delete("crashed");
  const live = record(storage, { sessionId: "live" });

  assert.deepEqual(await storage.recoverPartials(), { recovered: 1 });
  assert.ok(db.rows.has("crashed"));
  assert.ok(!db.rows.has("live"));
  assert.ok(fs.existsSync(live.dir));
  await storage.discardSession(live);
});

test("audio of a note deleted while recording is dropped", async (t) => {
  const { storage, db, baseDir } = setup(t);
  const recorder = record(storage);
  db.noteIds.delete(1);

  assert.equal(await storage.finalizeSession(recorder), null);
  assert.deepEqual(
    fs.readdirSync(baseDir).filter((name) => name.endsWith(".webm")),
    []
  );
  assert.equal(fs.existsSync(recorder.dir), false);
});

test("discard removes the live session's audio", async (t) => {
  const { storage, db } = setup(t);
  const recorder = record(storage);
  await storage.discardSession(recorder);
  assert.equal(fs.existsSync(recorder.dir), false);
  assert.equal(db.rows.size, 0);
  assert.equal(storage.busySessions.size, 0);
});

test("expired recordings are deleted with their files", async (t) => {
  let clock = START;
  const { storage, db, baseDir, changed } = setup(t, { now: () => clock });
  const row = await storage.finalizeSession(record(storage));
  changed.length = 0;

  clock = START + 29 * 86400000;
  assert.deepEqual(storage.cleanupExpired(30), { deleted: 0 });
  clock = START + 31 * 86400000;
  assert.deepEqual(storage.cleanupExpired(30), { deleted: 1 });
  assert.equal(fs.existsSync(path.join(baseDir, row.file_name)), false);
  assert.equal(db.rows.size, 0);
  assert.deepEqual(changed, [1]);
  assert.deepEqual(storage.cleanupExpired(0), { deleted: 0 });
});

test("orphan files and rows without a file are reconciled", async (t) => {
  const { storage, db, baseDir } = setup(t);
  const kept = await storage.finalizeSession(record(storage, { sessionId: "kept" }));
  const lost = await storage.finalizeSession(record(storage, { sessionId: "lost" }));
  fs.rmSync(path.join(baseDir, lost.file_name)); // removed by hand
  fs.writeFileSync(path.join(baseDir, "OpenWhispr-Meeting-orphan.webm"), "x"); // note deleted

  assert.deepEqual(storage.reconcileOrphans(), { deletedFiles: 1, deletedRows: 1 });
  assert.deepEqual([...db.rows.keys()], ["kept"]);
  assert.ok(fs.existsSync(path.join(baseDir, kept.file_name)));
  // The in-flight partial folder is never touched.
  assert.ok(fs.existsSync(path.join(baseDir, ".partial")));
});

test("usage and delete-all cover only the active account's recordings", async (t) => {
  const db = fakeDatabase({ notes: [1, 2], visibleNotes: [1] });
  const { storage, baseDir } = setup(t, { db });
  const mine = await storage.finalizeSession(record(storage, { sessionId: "mine", noteId: 1 }));
  const theirs = await storage.finalizeSession(record(storage, { sessionId: "theirs", noteId: 2 }));

  const usage = storage.getStorageUsage();
  assert.equal(usage.fileCount, 1);
  assert.equal(usage.totalBytes, mine.size_bytes);
  assert.equal(storage.getRecording("theirs"), null);

  assert.deepEqual(storage.deleteAllVisible(), { deleted: 1 });
  assert.equal(fs.existsSync(path.join(baseDir, mine.file_name)), false);
  assert.ok(fs.existsSync(path.join(baseDir, theirs.file_name)));
});

test(
  "with real ffmpeg the saved recording is a stereo WebM",
  { skip: !getFFmpegPath() && "no ffmpeg binary available" },
  async (t) => {
    const { storage, baseDir } = setup(t, { encode: encodeStereoPcmToOpus });
    const row = await storage.finalizeSession(record(storage));
    const header = fs.readFileSync(path.join(baseDir, row.file_name)).subarray(0, 4);
    assert.deepEqual([...header], [0x1a, 0x45, 0xdf, 0xa3], "EBML/WebM magic");
  }
);

// --- Re-transcription work files -------------------------------------------

// Raw 24 kHz PCM: silence with a loud tone over [fromMs, toMs).
function toneBetween(totalMs, fromMs, toMs) {
  const samples = Math.round((totalMs * RATE) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  const from = Math.round((fromMs * RATE) / 1000);
  const to = Math.round((toMs * RATE) / 1000);
  for (let i = from; i < to; i++) {
    buffer.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / RATE)), i * 2);
  }
  return buffer;
}

function setupWithTemp(t, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-temp-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const env = setup(t, { encode: encodeStereoPcmToOpus, ...options });
  env.storage.getTempDir = () => tempDir;
  return { ...env, tempDir };
}

async function recordConversation(storage) {
  const recorder = storage.startSession({
    sessionId: "conv",
    noteId: 1,
    startedAt: START,
    allowed,
  });
  // The user speaks 0.5-1.5 s, the other side 2.5-4 s.
  recorder.write("mic", toneBetween(5000, 500, 1500), { capturedAt: START + 5000 });
  recorder.write("system", toneBetween(5000, 2500, 4000), { capturedAt: START + 5000 });
  return storage.finalizeSession(recorder);
}

const ffmpegSkip = { skip: !getFFmpegPath() && "no ffmpeg binary available" };

test(
  "split + chunks put each utterance at its time on the right channel",
  ffmpegSkip,
  async (t) => {
    const { storage, tempDir } = setupWithTemp(t);
    await recordConversation(storage);

    const split = await storage.splitForRetranscribe(1);
    assert.equal(split.success, true);
    assert.equal(path.dirname(split.jobDir), fs.realpathSync(tempDir));
    assert.equal(split.recordings.length, 1);
    assert.equal(split.recordings[0].startedAt, START);

    const { success, chunks } = await storage.buildRetranscribeChunks({
      jobDir: split.jobDir,
      recordingId: "conv",
    });
    assert.equal(success, true);
    assert.deepEqual(
      chunks.map((chunk) => chunk.source),
      ["mic", "system"]
    );
    const near = (actual, expected) =>
      assert.ok(Math.abs(actual - expected) <= 250, `${actual} not near ${expected}`);
    near(chunks[0].startMs - START, 500);
    near(chunks[0].endMs - START, 1500);
    near(chunks[1].startMs - START, 2500);
    near(chunks[1].endMs - START, 4000);
    for (const chunk of chunks) assert.ok(fs.existsSync(chunk.path));

    assert.deepEqual(await storage.cleanupJob(split.jobDir), { success: true });
    assert.equal(fs.existsSync(split.jobDir), false);
  }
);

test("diarization turns drive the system pieces and carry the speaker", ffmpegSkip, async (t) => {
  const { storage } = setupWithTemp(t);
  await recordConversation(storage);
  const split = await storage.splitForRetranscribe(1);

  const { chunks } = await storage.buildRetranscribeChunks({
    jobDir: split.jobDir,
    recordingId: "conv",
    systemTurns: [
      { start: 2.5, end: 3.2, speaker: "speaker_00" },
      { start: 3.2, end: 4, speaker: "speaker_01" },
    ],
  });
  const system = chunks.filter((chunk) => chunk.source === "system");
  assert.deepEqual(
    system.map((chunk) => [chunk.startMs - START, chunk.endMs - START, chunk.speaker]),
    [
      [2500, 3200, "speaker_00"],
      [3200, 4000, "speaker_01"],
    ]
  );
  await storage.cleanupJob(split.jobDir);
});

test("a note without recordings can't be split", async (t) => {
  const { storage } = setupWithTemp(t, { encode: fakeEncode });
  assert.equal((await storage.splitForRetranscribe(1)).code, "NO_RECORDINGS");
});

test("job folders outside the temp dir or without the prefix are refused", async (t) => {
  const { storage, tempDir, baseDir } = setupWithTemp(t, { encode: fakeEncode });
  const other = path.join(tempDir, "not-a-job");
  fs.mkdirSync(other);
  assert.equal(storage.resolveJobDir(other), null);
  assert.equal(storage.resolveJobDir(baseDir), null);
  assert.equal(storage.resolveJobDir("../../etc"), null);
  assert.deepEqual(await storage.cleanupJob(other), { success: false });
  assert.ok(fs.existsSync(other));
  const chunks = await storage.buildRetranscribeChunks({ jobDir: other, recordingId: "x" });
  assert.equal(chunks.code, "INVALID_JOB");
});

test("a cancelled split removes its job folder", ffmpegSkip, async (t) => {
  const { storage, tempDir } = setupWithTemp(t);
  await recordConversation(storage);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(storage.splitForRetranscribe(1, { signal: controller.signal }));
  assert.deepEqual(
    fs.readdirSync(tempDir).filter((name) => name.startsWith("ow-retx-")),
    []
  );
});

test("stale job folders are swept, recent ones kept", async (t) => {
  let clock = Date.now();
  const { storage, tempDir } = setupWithTemp(t, { encode: fakeEncode, now: () => clock });
  const job = path.join(tempDir, "ow-retx-old");
  fs.mkdirSync(job);
  await storage.sweepStaleJobs();
  assert.ok(fs.existsSync(job));
  clock += 25 * 60 * 60 * 1000;
  await storage.sweepStaleJobs();
  assert.equal(fs.existsSync(job), false);
});

test("reconciling never removes the file of a session still being finalized", async (t) => {
  const db = fakeDatabase();
  const realAdd = db.addNoteRecording;
  const { storage, baseDir } = setup(t, { db });
  // A reconcile lands between the finalize moving its file in and writing the row.
  db.addNoteRecording = (row) => {
    storage.reconcileOrphans();
    return realAdd(row);
  };
  const row = await storage.finalizeSession(record(storage, { sessionId: "busy" }));
  assert.ok(row, "the recording was saved");
  assert.ok(fs.existsSync(path.join(baseDir, row.file_name)));
});
