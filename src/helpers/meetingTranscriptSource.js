// FORK: names the model that writes a meeting's live transcript, in the same
// vocabulary the renderer uses for re-transcriptions (src/utils/transcriptSource.ts):
// "local:<whisper|nvidia|cohere>", "openwhispr", "byok:<provider>", "enterprise".
function describeLiveMeetingModel(options = {}) {
  const provider = typeof options.provider === "string" ? options.provider : "";
  if (provider === "local") {
    return {
      engine: `local:${options.localProvider || "whisper"}`,
      model: options.localModel || null,
    };
  }
  const model = typeof options.model === "string" && options.model ? options.model : null;
  if (options.mode === "enterprise" || provider === "enterprise-realtime") {
    return { engine: "enterprise", model };
  }
  if (options.mode === "openwhispr") return { engine: "openwhispr", model };
  const id = provider.replace(/-realtime$/, "");
  return { engine: id ? `byok:${id}` : "unknown", model };
}

module.exports = { describeLiveMeetingModel };
