// FORK: specs/meeting-audio-recording/design.md §3.5.
const test = require("node:test");
const assert = require("node:assert/strict");
const { describeLiveMeetingModel } = require("../../src/helpers/meetingTranscriptSource");

test("live meeting options name their engine and model", () => {
  assert.deepEqual(
    describeLiveMeetingModel({ provider: "local", localProvider: "nvidia", localModel: "p-v3" }),
    { engine: "local:nvidia", model: "p-v3" }
  );
  assert.deepEqual(describeLiveMeetingModel({ provider: "local", localModel: "base" }), {
    engine: "local:whisper",
    model: "base",
  });
  assert.deepEqual(
    describeLiveMeetingModel({ provider: "openai-realtime", mode: "openwhispr", model: "m" }),
    { engine: "openwhispr", model: "m" }
  );
  assert.deepEqual(
    describeLiveMeetingModel({ provider: "deepgram-realtime", mode: "byok", model: "nova-3" }),
    { engine: "byok:deepgram", model: "nova-3" }
  );
  assert.deepEqual(
    describeLiveMeetingModel({ provider: "enterprise-realtime", mode: "enterprise", model: "d" }),
    { engine: "enterprise", model: "d" }
  );
  assert.deepEqual(describeLiveMeetingModel({}), { engine: "unknown", model: null });
});
