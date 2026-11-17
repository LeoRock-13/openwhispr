// FORK: specs/meeting-audio-recording/design.md §3.5.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  describeFileTranscriptionConfig,
  formatTranscriptModel,
  formatRecordingDuration,
} = require("../../src/utils/transcriptSource.ts");

const base = {
  useLocalWhisper: false,
  localTranscriptionProvider: "whisper",
  whisperModel: "turbo",
  parakeetModel: "parakeet-v3",
  cohereModel: "cohere-a",
  isOpenWhisprCloud: false,
  getApiKey: () => "",
  cloudTranscriptionProvider: "groq",
  cloudTranscriptionBaseUrl: "",
  cloudTranscriptionModel: "whisper-large-v3",
  language: "",
  transcriptionMode: "providers",
};

test("a config names the model it runs on", () => {
  assert.deepEqual(describeFileTranscriptionConfig(base, false), {
    engine: "byok:groq",
    model: "whisper-large-v3",
  });
  assert.deepEqual(
    describeFileTranscriptionConfig(
      { ...base, useLocalWhisper: true, localTranscriptionProvider: "nvidia" },
      false
    ),
    { engine: "local:nvidia", model: "parakeet-v3" }
  );
  assert.deepEqual(describeFileTranscriptionConfig({ ...base, isOpenWhisprCloud: true }, false), {
    engine: "openwhispr",
    model: null,
  });
  assert.deepEqual(
    describeFileTranscriptionConfig(
      { ...base, transcriptionMode: "self-hosted", remoteTranscriptionModel: "w" },
      false
    ),
    { engine: "self-hosted", model: "w" }
  );
  assert.deepEqual(describeFileTranscriptionConfig(base, true), {
    engine: "enterprise",
    model: null,
  });
});

const names = {
  localName: (provider, model) => (model === "turbo" ? "Turbo" : undefined),
  providerName: (id) => (id === "groq" ? "Groq" : undefined),
  managed: "Managed",
  selfHosted: "Self-hosted",
  unknown: "Unknown",
};

test("models format for display", () => {
  assert.equal(
    formatTranscriptModel({ engine: "local:whisper", model: "turbo" }, names),
    "Whisper · Turbo"
  );
  assert.equal(formatTranscriptModel({ engine: "local:nvidia", model: "p" }, names), "p");
  assert.equal(
    formatTranscriptModel({ engine: "openwhispr", model: "x" }, names),
    "OpenWhispr Cloud"
  );
  assert.equal(formatTranscriptModel({ engine: "byok:groq", model: "w" }, names), "Groq · w");
  assert.equal(formatTranscriptModel({ engine: "byok:new", model: null }, names), "new");
  assert.equal(formatTranscriptModel({ engine: "enterprise", model: null }, names), "Managed");
  assert.equal(
    formatTranscriptModel({ engine: "self-hosted", model: "m" }, names),
    "Self-hosted · m"
  );
  assert.equal(formatTranscriptModel({ engine: "weird", model: null }, names), "Unknown");
});

test("recording length reads in minutes and hours", () => {
  assert.equal(formatRecordingDuration(10_000), "1 min");
  assert.equal(formatRecordingDuration(42 * 60_000), "42 min");
  assert.equal(formatRecordingDuration(72 * 60_000), "1 h 12 min");
});
