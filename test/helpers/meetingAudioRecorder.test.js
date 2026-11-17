// FORK: specs/meeting-audio-recording/design.md §2.1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createMeetingAudioRecorder,
  readMeetingRecordingMeta,
  padMeetingPcmToEqualLength,
} = require("../../src/helpers/meetingAudioRecorder");

const RATE = 24000;
const START = 1_800_000_000_000;
const msToSamples = (ms) => Math.round((ms * RATE) / 1000);

// A chunk of `ms` milliseconds filled with a constant sample value.
function chunk(ms, value = 1000) {
  const buffer = Buffer.alloc(msToSamples(ms) * 2);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer;
}

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-recorder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = START;
  const recorder = createMeetingAudioRecorder({
    dir: path.join(root, "session-1"),
    sessionId: "session-1",
    noteId: 7,
    startedAt: START,
    now: () => clock,
    ...overrides,
  });
  return { root, recorder, setClock: (value) => (clock = value) };
}

const samplesOf = (file) => fs.readFileSync(file).length / 2;

test("writes meta.json so an interrupted session can be recovered", (t) => {
  const { recorder } = setup(t);
  assert.deepEqual(readMeetingRecordingMeta(recorder.dir), {
    version: 1,
    sessionId: "session-1",
    noteId: 7,
    startedAt: START,
  });
});

test("contiguous chunks are written back to back with no padding", async (t) => {
  const { recorder } = setup(t);
  for (let i = 1; i <= 10; i++) {
    recorder.write("mic", chunk(100), { capturedAt: START + i * 100 });
  }
  await recorder.close();
  assert.equal(samplesOf(path.join(recorder.dir, "mic.pcm")), msToSamples(1000));
});

test("a channel that starts late is padded with leading silence", async (t) => {
  const { recorder } = setup(t);
  // System audio first heard 3 s into the meeting.
  recorder.write("system", chunk(100, 500), { capturedAt: START + 3100 });
  await recorder.close();
  const data = fs.readFileSync(path.join(recorder.dir, "system.pcm"));
  assert.equal(data.length / 2, msToSamples(3100));
  assert.equal(data.readInt16LE(0), 0, "leading silence");
  assert.equal(data.readInt16LE(msToSamples(3000) * 2), 500, "audio lands at 3 s");
});

test("a hole longer than the tolerance is filled; jitter below it is not", async (t) => {
  const { recorder } = setup(t);
  recorder.write("mic", chunk(100), { capturedAt: START + 100 });
  recorder.write("mic", chunk(100), { capturedAt: START + 300 }); // 100 ms late: jitter
  assert.equal(recorder.samplesWritten("mic"), msToSamples(200));
  recorder.write("mic", chunk(100), { capturedAt: START + 1300 }); // 1 s hole
  assert.equal(recorder.samplesWritten("mic"), msToSamples(1300));
  await recorder.close();
});

test("a channel running ahead of the clock is never cut", async (t) => {
  const { recorder } = setup(t);
  // Three chunks arrive in a burst with the same arrival time.
  for (let i = 0; i < 3; i++) recorder.write("mic", chunk(100), { capturedAt: START + 100 });
  await recorder.close();
  assert.equal(samplesOf(path.join(recorder.dir, "mic.pcm")), msToSamples(300));
});

test("without capturedAt the arrival time places the chunk", async (t) => {
  const { recorder, setClock } = setup(t);
  setClock(START + 2000);
  recorder.write("system", chunk(100));
  await recorder.close();
  assert.equal(samplesOf(path.join(recorder.dir, "system.pcm")), msToSamples(2000));
});

test("odd-length chunks, unknown sources and writes after close are ignored safely", async (t) => {
  const { recorder } = setup(t);
  recorder.write("mic", Buffer.alloc(5), { capturedAt: START + 1 });
  recorder.write("speaker", chunk(100), { capturedAt: START + 100 });
  await recorder.close();
  recorder.write("mic", chunk(100), { capturedAt: START + 200 });
  assert.equal(samplesOf(path.join(recorder.dir, "mic.pcm")), 2);
  assert.equal(fs.existsSync(path.join(recorder.dir, "speaker.pcm")), false);
});

test("padding equalizes both channels and creates a missing one", async (t) => {
  const { recorder } = setup(t);
  recorder.write("mic", chunk(500), { capturedAt: START + 500 });
  await recorder.close();

  const { micPath, systemPath, samples } = await padMeetingPcmToEqualLength(recorder.dir);
  assert.equal(samples, msToSamples(500));
  assert.equal(samplesOf(micPath), samples);
  assert.equal(samplesOf(systemPath), samples);
  assert.equal(fs.readFileSync(systemPath).readInt16LE(0), 0);
});

test("discard removes the session directory", async (t) => {
  const { recorder } = setup(t);
  recorder.write("mic", chunk(100), { capturedAt: START + 100 });
  await recorder.discard();
  assert.equal(fs.existsSync(recorder.dir), false);
});

test("an invalid meta.json is not treated as a session", (t) => {
  const { recorder } = setup(t);
  fs.writeFileSync(path.join(recorder.dir, "meta.json"), "{not json");
  assert.equal(readMeetingRecordingMeta(recorder.dir), null);
  assert.equal(readMeetingRecordingMeta(path.join(recorder.dir, "missing")), null);
});
