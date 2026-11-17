// FORK: the models offered for re-transcribing a meeting note
// (specs/meeting-audio-recording/design.md §3.3). The default is the one set
// for uploaded files -- a batch model, while the meeting one may be
// streaming-only -- and any other entry overrides just the provider/model of
// that config for this run, never the saved settings.
import type { FileTranscriptionConfig } from "../services/fileTranscription";

export interface RetranscribeModelOption {
  id: string;
  group: "default" | "openwhispr" | "local" | "cloud";
  label: string;
  overrides: Partial<FileTranscriptionConfig>;
}

export interface LocalModelEntry {
  provider: "whisper" | "nvidia" | "cohere";
  model: string;
  label: string;
}

export interface CloudProviderEntry {
  id: string;
  name: string;
  models: Array<{ id: string; name: string; streaming?: boolean; legacy?: boolean }>;
}

export const DEFAULT_RETRANSCRIBE_MODEL_ID = "default";

// Providers with no batch (file) route.
const STREAMING_ONLY = new Set(["deepgram", "assemblyai"]);

export function buildRetranscribeModelOptions({
  defaultLabel,
  isSignedIn,
  managedActive,
  localModels,
  cloudProviders,
  hasApiKey,
}: {
  defaultLabel: string;
  isSignedIn: boolean;
  /** Managed enterprise transcription outranks every choice, so none is offered. */
  managedActive: boolean;
  localModels: LocalModelEntry[];
  cloudProviders: CloudProviderEntry[];
  hasApiKey: (providerId: string) => boolean;
}): RetranscribeModelOption[] {
  const options: RetranscribeModelOption[] = [
    { id: DEFAULT_RETRANSCRIBE_MODEL_ID, group: "default", label: defaultLabel, overrides: {} },
  ];
  if (managedActive) return options;

  if (isSignedIn) {
    options.push({
      id: "openwhispr",
      group: "openwhispr",
      label: "OpenWhispr Cloud",
      overrides: { isOpenWhisprCloud: true, useLocalWhisper: false },
    });
  }

  for (const entry of localModels) {
    options.push({
      id: `local:${entry.provider}:${entry.model}`,
      group: "local",
      label: entry.label,
      overrides: {
        isOpenWhisprCloud: false,
        useLocalWhisper: true,
        localTranscriptionProvider: entry.provider,
        ...(entry.provider === "whisper"
          ? { whisperModel: entry.model }
          : entry.provider === "cohere"
            ? { cohereModel: entry.model }
            : { parakeetModel: entry.model }),
      },
    });
  }

  for (const provider of cloudProviders) {
    if (provider.id === "custom" || STREAMING_ONLY.has(provider.id) || !hasApiKey(provider.id)) {
      continue;
    }
    for (const model of provider.models) {
      if (model.streaming || model.legacy) continue;
      options.push({
        id: `cloud:${provider.id}:${model.id}`,
        group: "cloud",
        label: `${provider.name} · ${model.name}`,
        overrides: {
          isOpenWhisprCloud: false,
          useLocalWhisper: false,
          transcriptionMode: "providers",
          cloudTranscriptionProvider: provider.id,
          cloudTranscriptionModel: model.id,
        },
      });
    }
  }
  return options;
}

// The run's config: the default with the chosen entry's fields. A BYOK entry
// for another provider also takes that provider's key and its default URL.
export function applyRetranscribeModel(
  base: FileTranscriptionConfig,
  option: RetranscribeModelOption | undefined,
  getApiKeyFor: (providerId: string) => string
): FileTranscriptionConfig {
  if (!option || option.group === "default") return base;
  const config = { ...base, ...option.overrides };
  if (option.group === "cloud") {
    const providerId = option.overrides.cloudTranscriptionProvider as string;
    if (providerId !== base.cloudTranscriptionProvider) config.cloudTranscriptionBaseUrl = "";
    config.getApiKey = () => getApiKeyFor(providerId);
  }
  return config;
}
