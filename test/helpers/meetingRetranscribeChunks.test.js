// FORK: specs/meeting-audio-recording/design.md §3.1.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  segmentBySilence,
  mergeSpeakerTurns,
} = require("../../src/helpers/meetingRetranscribeChunks");

const RATE = 16000;

// Builds a channel from [kind, ms] parts: "speech" is a loud tone, "noise" a
// faint hiss, "silence" zeros.
function channel(parts) {
  const total = parts.reduce((sum, [, ms]) => sum + Math.round((ms * RATE) / 1000), 0);
  const samples = new Int16Array(total);
  let offset = 0;
  let seed = 1;
  for (const [kind, ms] of parts) {
    const count = Math.round((ms * RATE) / 1000);
    for (let i = 0; i < count; i++) {
      if (kind === "speech")
        samples[offset + i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
      else if (kind === "noise") {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        samples[offset + i] = (seed % 200) - 100;
      }
    }
    offset += count;
  }
  return samples;
}

const near = (actual, expected, tolerance = 200) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} not within ${tolerance} of ${expected}`
  );

test("utterances separated by silence become separate pieces with their start time", () => {
  const segments = segmentBySilence(
    channel([
      ["noise", 1000],
      ["speech", 2000],
      ["noise", 1500],
      ["speech", 1000],
      ["noise", 500],
    ]),
    RATE
  );
  assert.equal(segments.length, 2);
  near(segments[0].startMs, 1000);
  near(segments[0].endMs, 3000);
  near(segments[1].startMs, 4500);
  near(segments[1].endMs, 5500);
});

test("a short pause inside an utterance does not split it", () => {
  const segments = segmentBySilence(
    channel([
      ["speech", 1000],
      ["silence", 300],
      ["speech", 1000],
    ]),
    RATE
  );
  assert.equal(segments.length, 1);
});

test("blips shorter than the minimum speech length are dropped", () => {
  const segments = segmentBySilence(
    channel([
      ["noise", 1000],
      ["speech", 150],
      ["noise", 1000],
    ]),
    RATE
  );
  assert.deepEqual(segments, []);
});

test("silence or near-silence alone yields nothing", () => {
  assert.deepEqual(segmentBySilence(channel([["silence", 3000]]), RATE), []);
  assert.deepEqual(segmentBySilence(channel([["noise", 3000]]), RATE), []);
  assert.deepEqual(segmentBySilence(new Int16Array(0), RATE), []);
});

test("steady background noise above the floor is not taken for speech", () => {
  const hum = new Int16Array(RATE * 3);
  for (let i = 0; i < hum.length; i++)
    hum[i] = Math.round(300 * Math.sin((2 * Math.PI * 50 * i) / RATE));
  assert.deepEqual(segmentBySilence(hum, RATE), []);
});

test("an utterance longer than the limit is cut into pieces no longer than it", () => {
  const segments = segmentBySilence(channel([["speech", 70000]]), RATE);
  assert.ok(segments.length >= 3);
  for (const segment of segments) assert.ok(segment.endMs - segment.startMs <= 30000);
  near(segments[0].startMs, 0);
  near(segments.at(-1).endMs, 70000);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs, "pieces are contiguous");
  }
});

test("diarization turns of the same speaker are merged across short pauses", () => {
  const pieces = mergeSpeakerTurns([
    { start: 0, end: 4, speaker: "speaker_0" },
    { start: 4.5, end: 8, speaker: "speaker_0" },
    { start: 8.2, end: 10, speaker: "speaker_1" },
    { start: 13, end: 15, speaker: "speaker_1" }, // 3 s pause: separate piece
  ]);
  assert.deepEqual(pieces, [
    { startMs: 0, endMs: 8000, speaker: "speaker_0" },
    { startMs: 8200, endMs: 10000, speaker: "speaker_1" },
    { startMs: 13000, endMs: 15000, speaker: "speaker_1" },
  ]);
});

test("merged turns stay under the limit and long turns are split evenly", () => {
  const pieces = mergeSpeakerTurns([
    { start: 0, end: 20, speaker: "speaker_0" },
    { start: 20.5, end: 40, speaker: "speaker_0" }, // merging would exceed 30 s
    { start: 50, end: 115, speaker: "speaker_1" }, // 65 s turn
  ]);
  assert.deepEqual(pieces.slice(0, 2), [
    { startMs: 0, endMs: 20000, speaker: "speaker_0" },
    { startMs: 20500, endMs: 40000, speaker: "speaker_0" },
  ]);
  const long = pieces.slice(2);
  assert.equal(long.length, 3);
  assert.equal(long[0].startMs, 50000);
  assert.equal(long.at(-1).endMs, 115000);
  for (const piece of long) assert.ok(piece.endMs - piece.startMs <= 30000);
});

test("invalid and negligible turns are ignored and order is restored", () => {
  const pieces = mergeSpeakerTurns([
    { start: 5, end: 6, speaker: "speaker_1" },
    { start: 1, end: 1.1, speaker: "speaker_0" }, // 100 ms blip
    { start: 2, end: 1, speaker: "speaker_0" }, // reversed
    { start: "x", end: 3, speaker: "speaker_0" },
    { start: 0, end: 2, speaker: null },
    { start: 3, end: 4, speaker: "speaker_0" },
  ]);
  assert.deepEqual(pieces, [
    { startMs: 3000, endMs: 4000, speaker: "speaker_0" },
    { startMs: 5000, endMs: 6000, speaker: "speaker_1" },
  ]);
  assert.deepEqual(mergeSpeakerTurns(null), []);
});
