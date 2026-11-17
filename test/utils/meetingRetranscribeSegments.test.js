// FORK: specs/meeting-audio-recording/design.md §3.2.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRetranscribedSegments,
  textContainment,
} = require("../../src/utils/meetingRetranscribeSegments.ts");
const { serializeTranscriptSegments } = require("../../src/utils/transcriptSpeakerState.ts");
const { parseTranscriptSegments } = require("../../src/utils/parseTranscriptSegments.ts");

const T0 = 1_800_000_000_000;
const piece = (source, startS, endS, text, speaker) => ({
  chunk: {
    path: `/tmp/${source}-${startS}.wav`,
    source,
    startMs: T0 + startS * 1000,
    endMs: T0 + endS * 1000,
    ...(speaker ? { speaker } : {}),
  },
  text,
});

test("pieces become time-ordered segments with the user on the mic side", () => {
  const segments = buildRetranscribedSegments([
    piece("system", 5, 8, "Sounds good, see you Friday.", "speaker_03"),
    piece("mic", 1, 4, "Let's ship it on Friday."),
  ]);
  assert.deepEqual(
    segments.map((s) => [s.source, s.timestamp - T0, s.speaker, s.text]),
    [
      ["mic", 1000, "you", "Let's ship it on Friday."],
      ["system", 5000, "speaker_0", "Sounds good, see you Friday."],
    ]
  );
  assert.equal(segments[0].speakerStatus, "confirmed");
  assert.equal(segments[1].speakerIsPlaceholder, false);
  assert.equal(new Set(segments.map((s) => s.id)).size, 2);
});

test("system speakers are renumbered by first appearance across recordings", () => {
  const segments = buildRetranscribedSegments([
    piece("system", 1, 2, "one", "rec1:speaker_02"),
    piece("system", 3, 4, "two", "rec1:speaker_00"),
    piece("system", 5, 6, "three", "rec1:speaker_02"),
    piece("system", 100, 101, "four", "rec2:speaker_00"),
  ]);
  assert.deepEqual(
    segments.map((s) => s.speaker),
    ["speaker_0", "speaker_1", "speaker_0", "speaker_2"]
  );
});

test("system pieces without diarization carry no speaker", () => {
  const [segment] = buildRetranscribedSegments([piece("system", 1, 2, "hello")]);
  assert.equal(segment.speaker, undefined);
  assert.equal(segment.source, "system");
});

test("empty texts are dropped", () => {
  const segments = buildRetranscribedSegments([
    piece("mic", 1, 2, "   "),
    piece("system", 3, 4, "", "speaker_0"),
    piece("mic", 5, 6, "kept"),
  ]);
  assert.deepEqual(
    segments.map((s) => s.text),
    ["kept"]
  );
});

test("a mic piece that echoes overlapping system speech is dropped", () => {
  const segments = buildRetranscribedSegments([
    piece("system", 10, 14, "We should move the launch to next Tuesday.", "speaker_0"),
    // Picked up from the speakers, slightly garbled and a little late.
    piece("mic", 10.4, 14.6, "we should move the launch to next tuesday"),
    // The user's own answer right after: kept.
    piece("mic", 15, 17, "Tuesday works for me."),
    // Same words but far away in time: not an echo.
    piece("mic", 60, 63, "We should move the launch to next Tuesday."),
  ]);
  assert.deepEqual(
    segments.map((s) => [s.source, s.timestamp - T0]),
    [
      ["system", 10000],
      ["mic", 15000],
      ["mic", 60000],
    ]
  );
});

test("text containment compares words, ignoring case, accents and punctuation", () => {
  assert.equal(textContainment("Perché no?", "perche NO"), 1);
  assert.equal(textContainment("a b c d", "a b x y"), 0.5);
  assert.equal(textContainment("", "anything"), 0);
});

test("segments survive the note transcript round trip", () => {
  const segments = buildRetranscribedSegments([
    piece("mic", 1, 2, "hi there"),
    piece("system", 3, 4, "hello", "speaker_00"),
  ]);
  const parsed = parseTranscriptSegments(serializeTranscriptSegments(segments));
  assert.deepEqual(
    parsed.map((s) => [s.source, s.timestamp, s.speaker, s.text]),
    segments.map((s) => [s.source, s.timestamp, s.speaker, s.text])
  );
});
