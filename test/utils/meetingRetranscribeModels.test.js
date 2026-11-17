// FORK: specs/meeting-audio-recording/design.md §3.3.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRetranscribeModelOptions,
  applyRetranscribeModel,
  DEFAULT_RETRANSCRIBE_MODEL_ID,
} = require("../../src/utils/meetingRetranscribeModels.ts");

const base = {
  useLocalWhisper: false,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: "parakeet-tdt",
  cohereModel: "cohere-a",
  isOpenWhisprCloud: false,
  getApiKey: () => "groq-key",
  cloudTranscriptionProvider: "groq",
  cloudTranscriptionBaseUrl: "https://groq.example/v1",
  cloudTranscriptionModel: "whisper-large-v3-turbo",
  language: "it",
  transcriptionMode: "providers",
};

const providers = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe" },
      { id: "gpt-realtime", name: "Realtime", streaming: true },
      { id: "whisper-0", name: "Old", legacy: true },
    ],
  },
  { id: "groq", name: "Groq", models: [{ id: "whisper-large-v3", name: "Whisper Large v3" }] },
  { id: "deepgram", name: "Deepgram", models: [{ id: "nova-3", name: "Nova 3" }] },
  { id: "custom", name: "Custom", models: [{ id: "x", name: "X" }] },
  { id: "mistral", name: "Mistral", models: [{ id: "voxtral", name: "Voxtral" }] },
];

const options = (overrides = {}) =>
  buildRetranscribeModelOptions({
    defaultLabel: "Default: Groq · whisper-large-v3-turbo",
    isSignedIn: true,
    managedActive: false,
    localModels: [
      { provider: "whisper", model: "large-v3", label: "Whisper Large v3" },
      { provider: "nvidia", model: "parakeet-tdt", label: "Parakeet" },
      { provider: "cohere", model: "cohere-a", label: "Cohere" },
    ],
    cloudProviders: providers,
    hasApiKey: (id) => id !== "mistral",
    ...overrides,
  });

test("offers the default, OpenWhispr Cloud, installed local models and keyed batch models", () => {
  assert.deepEqual(
    options().map((option) => option.id),
    [
      DEFAULT_RETRANSCRIBE_MODEL_ID,
      "openwhispr",
      "local:whisper:large-v3",
      "local:nvidia:parakeet-tdt",
      "local:cohere:cohere-a",
      "cloud:openai:gpt-4o-transcribe",
      "cloud:groq:whisper-large-v3",
    ]
  );
});

test("signed out there is no OpenWhispr Cloud; managed transcription offers only the default", () => {
  assert.ok(!options({ isSignedIn: false }).some((option) => option.id === "openwhispr"));
  assert.deepEqual(
    options({ managedActive: true }).map((option) => option.id),
    [DEFAULT_RETRANSCRIBE_MODEL_ID]
  );
});

test("the default leaves the config untouched", () => {
  const [defaultOption] = options();
  assert.equal(
    applyRetranscribeModel(base, defaultOption, () => ""),
    base
  );
  assert.equal(
    applyRetranscribeModel(base, undefined, () => ""),
    base
  );
});

test("a local model switches the engine and only its own model field", () => {
  const nvidia = options().find((option) => option.id === "local:nvidia:parakeet-tdt");
  const config = applyRetranscribeModel(base, nvidia, () => "");
  assert.equal(config.useLocalWhisper, true);
  assert.equal(config.isOpenWhisprCloud, false);
  assert.equal(config.localTranscriptionProvider, "nvidia");
  assert.equal(config.parakeetModel, "parakeet-tdt");
  assert.equal(config.whisperModel, "base");
  assert.equal(config.language, "it");
});

test("another BYOK provider brings its own key and drops the default's URL", () => {
  const openai = options().find((option) => option.id === "cloud:openai:gpt-4o-transcribe");
  const config = applyRetranscribeModel(base, openai, (id) => `${id}-key`);
  assert.equal(config.cloudTranscriptionProvider, "openai");
  assert.equal(config.cloudTranscriptionModel, "gpt-4o-transcribe");
  assert.equal(config.cloudTranscriptionBaseUrl, "");
  assert.equal(config.getApiKey(), "openai-key");
  assert.equal(config.useLocalWhisper, false);
});

test("another model of the default's provider keeps its URL", () => {
  const groq = options().find((option) => option.id === "cloud:groq:whisper-large-v3");
  const config = applyRetranscribeModel(base, groq, (id) => `${id}-key`);
  assert.equal(config.cloudTranscriptionBaseUrl, "https://groq.example/v1");
  assert.equal(config.cloudTranscriptionModel, "whisper-large-v3");
});

test("OpenWhispr Cloud turns local and BYOK off", () => {
  const cloud = options().find((option) => option.id === "openwhispr");
  const config = applyRetranscribeModel({ ...base, useLocalWhisper: true }, cloud, () => "");
  assert.equal(config.isOpenWhisprCloud, true);
  assert.equal(config.useLocalWhisper, false);
});
