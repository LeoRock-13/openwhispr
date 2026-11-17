// FORK: which model wrote a note's transcript, in the vocabulary main uses for
// live meetings (src/helpers/meetingTranscriptSource.js):
// "local:<whisper|nvidia|cohere>", "openwhispr", "byok:<provider>",
// "self-hosted", "enterprise".
import type { FileTranscriptionConfig } from "../services/fileTranscription";

export interface TranscriptModelInfo {
  engine: string;
  model: string | null;
}

/** The model a re-transcription with this config runs on. */
export function describeFileTranscriptionConfig(
  config: FileTranscriptionConfig,
  managed: boolean
): TranscriptModelInfo {
  if (managed) return { engine: "enterprise", model: null };
  if (config.useLocalWhisper) {
    const provider = config.localTranscriptionProvider || "whisper";
    const model =
      provider === "nvidia"
        ? config.parakeetModel
        : provider === "cohere"
          ? config.cohereModel
          : config.whisperModel;
    return { engine: `local:${provider}`, model: model || null };
  }
  if (config.isOpenWhisprCloud) return { engine: "openwhispr", model: null };
  if (config.transcriptionMode === "self-hosted") {
    return { engine: "self-hosted", model: config.remoteTranscriptionModel || null };
  }
  return {
    engine: `byok:${config.cloudTranscriptionProvider}`,
    model: config.cloudTranscriptionModel || null,
  };
}

export interface TranscriptModelNames {
  /** Display name of a local model, or undefined when unknown. */
  localName: (provider: string, model: string) => string | undefined;
  providerName: (providerId: string) => string | undefined;
  managed: string;
  selfHosted: string;
  unknown: string;
}

export function formatTranscriptModel(
  info: TranscriptModelInfo,
  names: TranscriptModelNames
): string {
  const { engine, model } = info;
  if (engine.startsWith("local:")) {
    const provider = engine.slice("local:".length);
    const name = model ? (names.localName(provider, model) ?? model) : names.unknown;
    return provider === "whisper" ? `Whisper · ${name}` : name;
  }
  if (engine === "openwhispr") return "OpenWhispr Cloud";
  if (engine === "enterprise") return names.managed;
  if (engine === "self-hosted") return model ? `${names.selfHosted} · ${model}` : names.selfHosted;
  if (engine.startsWith("byok:")) {
    const id = engine.slice("byok:".length);
    const provider = names.providerName(id) ?? id;
    return model ? `${provider} · ${model}` : provider;
  }
  return names.unknown;
}

/** "42 min", "1 h 12 min": the length of a note's stored audio. */
export function formatRecordingDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}
