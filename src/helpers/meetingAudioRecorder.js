// FORK: streams the raw audio of one meeting session to disk while it records
// (specs/meeting-audio-recording/design.md §2.1).
//
// Every mic and system chunk reaches main through sendMeetingAudio as 24 kHz
// mono s16le, raw (before AEC and the mic gate). The two channels arrive
// independently -- the system capture can start later, and a helper restart
// leaves a hole -- so each chunk is placed on the session's wall clock: when a
// channel falls behind where the chunk belongs by more than the tolerance, the
// gap is filled with silence first. A channel that runs ahead is never cut, so
// IPC jitter can't produce audible clicks. The result is two PCM files that
// line up within the tolerance and can be joined into one stereo recording.
//
// The files live under a per-session directory with a meta.json, so a session
// cut short by a crash or by quitting is recovered at the next start.
const fs = require("fs");
const path = require("path");

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_GAP_TOLERANCE_MS = 250;
// A clock jump (sleep/resume, a wildly wrong capturedAt) must not write hours
// of silence; longer real gaps are still capped to this.
const MAX_GAP_FILL_MS = 60 * 60 * 1000;
const SOURCES = ["mic", "system"];
const META_FILE = "meta.json";
const META_VERSION = 1;
const ZERO_BLOCK = Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE); // 1 s of silence

const pcmFileName = (source) => `${source}.pcm`;

function writeSilence(stream, samples) {
  let remaining = samples * BYTES_PER_SAMPLE;
  while (remaining > 0) {
    const size = Math.min(remaining, ZERO_BLOCK.length);
    stream.write(size === ZERO_BLOCK.length ? ZERO_BLOCK : ZERO_BLOCK.subarray(0, size));
    remaining -= size;
  }
}

function createMeetingAudioRecorder({
  dir,
  sessionId,
  noteId,
  startedAt,
  gapToleranceMs = DEFAULT_GAP_TOLERANCE_MS,
  now = Date.now,
}) {
  if (!dir || !sessionId || noteId == null || !Number.isFinite(startedAt)) {
    throw new Error("createMeetingAudioRecorder needs dir, sessionId, noteId and startedAt");
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, META_FILE),
    JSON.stringify({ version: META_VERSION, sessionId, noteId, startedAt })
  );

  const toleranceSamples = Math.round((gapToleranceMs * SAMPLE_RATE) / 1000);
  const maxGapSamples = Math.round((MAX_GAP_FILL_MS * SAMPLE_RATE) / 1000);
  const channels = new Map();
  let closed = false;
  let failed = null;

  const channelFor = (source) => {
    let channel = channels.get(source);
    if (!channel) {
      const stream = fs.createWriteStream(path.join(dir, pcmFileName(source)), { flags: "a" });
      // A failed write (disk full, folder removed) must not crash main; the
      // session simply stops recording and finalize reports nothing.
      stream.on("error", (error) => {
        failed = failed || error;
      });
      channel = { stream, samples: 0 };
      channels.set(source, channel);
    }
    return channel;
  };

  function write(source, buffer, { capturedAt = null } = {}) {
    if (closed || failed || !SOURCES.includes(source) || !buffer?.length) return;
    const chunk = buffer.length % 2 === 0 ? buffer : buffer.subarray(0, buffer.length - 1);
    const chunkSamples = chunk.length / BYTES_PER_SAMPLE;
    if (chunkSamples === 0) return;

    const channel = channelFor(source);
    // capturedAt (or arrival time) marks the end of the chunk.
    const endedAt = Number.isFinite(capturedAt) ? capturedAt : now();
    const chunkStartMs = endedAt - (chunkSamples * 1000) / SAMPLE_RATE - startedAt;
    const expectedStart = Math.round((chunkStartMs * SAMPLE_RATE) / 1000);
    const behind = expectedStart - channel.samples;
    if (behind > toleranceSamples) {
      const fill = Math.min(behind, maxGapSamples);
      writeSilence(channel.stream, fill);
      channel.samples += fill;
    }
    // Copy: the caller may reuse the buffer after this returns.
    channel.stream.write(Buffer.from(chunk));
    channel.samples += chunkSamples;
  }

  const endStream = (stream) =>
    new Promise((resolve) => {
      if (stream.closed || stream.destroyed) {
        resolve();
        return;
      }
      stream.once("close", resolve);
      stream.once("error", resolve);
      stream.end();
    });

  async function close() {
    if (closed) return { dir, failed };
    closed = true;
    await Promise.all([...channels.values()].map(({ stream }) => endStream(stream)));
    return { dir, failed };
  }

  async function discard() {
    await close();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  return {
    sessionId,
    noteId,
    startedAt,
    dir,
    write,
    close,
    discard,
    get closed() {
      return closed;
    },
    samplesWritten: (source) => channels.get(source)?.samples ?? 0,
  };
}

function readMeetingRecordingMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8"));
    if (
      meta?.version !== META_VERSION ||
      typeof meta.sessionId !== "string" ||
      meta.noteId == null ||
      !Number.isFinite(meta.startedAt)
    ) {
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

// Both channels padded with trailing silence to the longer one's length, so the
// stereo join keeps all of each. Creates a missing channel file. Returns the
// paths and the common length in samples.
async function padMeetingPcmToEqualLength(dir) {
  const paths = Object.fromEntries(
    SOURCES.map((source) => [source, path.join(dir, pcmFileName(source))])
  );
  const sizes = {};
  for (const source of SOURCES) {
    try {
      const size = (await fs.promises.stat(paths[source])).size;
      sizes[source] = size - (size % BYTES_PER_SAMPLE);
    } catch {
      sizes[source] = 0;
    }
  }
  const target = Math.max(...Object.values(sizes));
  for (const source of SOURCES) {
    // Creates a missing file; truncate() both trims a stray odd byte and
    // extends with zero bytes.
    await (await fs.promises.open(paths[source], "a")).close();
    await fs.promises.truncate(paths[source], target);
  }
  return { micPath: paths.mic, systemPath: paths.system, samples: target / BYTES_PER_SAMPLE };
}

module.exports = {
  createMeetingAudioRecorder,
  readMeetingRecordingMeta,
  padMeetingPcmToEqualLength,
  MEETING_RECORDING_SAMPLE_RATE: SAMPLE_RATE,
};
