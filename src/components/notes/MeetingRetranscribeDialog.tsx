// FORK: re-transcribe a meeting note from its stored audio with the model set
// for uploaded files or another one picked for this run
// (specs/meeting-audio-recording/design.md §3.3-3.4).
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useToast } from "../ui/useToast";
import { AlertTriangle } from "../icons";
import { useAuth } from "../../hooks/useAuth";
import { useSettings } from "../../hooks/useSettings";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  useSettingsStore,
  selectPolicyEffectiveSettings,
  selectResolvedUploadTranscription,
} from "../../stores/settingsStore";
import { useManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import {
  getParakeetModelInfo,
  getTranscriptionProvider,
  getTranscriptionProviders,
  getWhisperModelInfo,
  isCohereTranscribeModel,
} from "../../models/ModelRegistry";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import {
  getTranscriptionApiKey,
  type FileTranscriptionConfig,
} from "../../services/fileTranscription";
import {
  retranscribeMeetingNote,
  saveRetranscribedTranscript,
  type RetranscribeProgress,
} from "../../services/meetingRetranscription";
import {
  applyRetranscribeModel,
  buildRetranscribeModelOptions,
  DEFAULT_RETRANSCRIBE_MODEL_ID,
  type LocalModelEntry,
} from "../../utils/meetingRetranscribeModels";
import type { NoteRecording } from "../../types/electron";

const LAST_MODEL_KEY = "meetingRetranscribeModel";

const readLastModel = () => {
  try {
    return localStorage.getItem(LAST_MODEL_KEY) || DEFAULT_RETRANSCRIBE_MODEL_ID;
  } catch {
    return DEFAULT_RETRANSCRIBE_MODEL_ID;
  }
};

const formatDuration = (ms: number) => {
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
};

type RunState =
  | { kind: "idle" }
  | { kind: "running"; progress: RetranscribeProgress }
  | { kind: "error"; message: string };

interface MeetingRetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteId: number;
  recordings: NoteRecording[];
}

export default function MeetingRetranscribeDialog({
  open,
  onOpenChange,
  noteId,
  recordings,
}: MeetingRetranscribeDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isSignedIn } = useAuth();
  const apiKeys = useSettings();
  const policyState = usePolicySnapshot();
  const upload = useSettingsStore(
    useShallow((settings) =>
      selectResolvedUploadTranscription(selectPolicyEffectiveSettings(settings, policyState))
    )
  );
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const enterpriseTranscriptionSetupMode = useSettingsStore(
    (s) => s.enterpriseTranscriptionSetupMode
  );
  const managedActive =
    useManagedScopeResolution("transcription", enterpriseTranscriptionSetupMode).kind === "managed";

  const [localModels, setLocalModels] = useState<LocalModelEntry[]>([]);
  const [diarizationReady, setDiarizationReady] = useState(false);
  const [selectedId, setSelectedId] = useState(readLastModel);
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // Installed local models and diarization status, refreshed on each open.
  useEffect(() => {
    if (!open) return;
    setRun({ kind: "idle" });
    let cancelled = false;
    void (async () => {
      const api = window.electronAPI;
      const [whisper, parakeet, diarization] = await Promise.all([
        api.listWhisperModels?.().catch(() => null),
        api.listParakeetModels?.().catch(() => null),
        api.getDiarizationModelStatus?.().catch(() => null),
      ]);
      if (cancelled) return;
      const entries: LocalModelEntry[] = [];
      for (const model of whisper?.models ?? []) {
        if (!model.downloaded) continue;
        entries.push({
          provider: "whisper",
          model: model.model,
          label: `Whisper · ${getWhisperModelInfo(model.model)?.name ?? model.model}`,
        });
      }
      for (const model of parakeet?.models ?? []) {
        if (!model.downloaded) continue;
        entries.push({
          provider: isCohereTranscribeModel(model.model) ? "cohere" : "nvidia",
          model: model.model,
          label: getParakeetModelInfo(model.model)?.name ?? model.model,
        });
      }
      setLocalModels(entries);
      setDiarizationReady(Boolean(diarization?.modelsDownloaded));
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // The upload config, built like UploadAudioView's.
  const isOpenWhisprCloud =
    !managedActive &&
    isSignedIn &&
    upload.cloudTranscriptionMode === "openwhispr" &&
    !upload.useLocalWhisper;
  const baseConfig: FileTranscriptionConfig = {
    useLocalWhisper: upload.useLocalWhisper,
    localTranscriptionProvider: upload.localTranscriptionProvider as string,
    whisperModel: upload.whisperModel,
    parakeetModel: upload.parakeetModel,
    cohereModel: upload.cohereModel,
    isOpenWhisprCloud,
    getApiKey: () => getTranscriptionApiKey(upload.cloudTranscriptionProvider, apiKeys),
    cloudTranscriptionProvider: upload.cloudTranscriptionProvider as string,
    cloudTranscriptionBaseUrl: upload.cloudTranscriptionBaseUrl || "",
    cloudTranscriptionModel: upload.cloudTranscriptionModel,
    language: getBaseLanguageCode(preferredLanguage) || "",
    cortiEnvironment,
    cortiTenant,
    transcriptionMode: upload.transcriptionMode,
    remoteTranscriptionUrl: upload.remoteTranscriptionUrl,
    remoteTranscriptionModel: upload.remoteTranscriptionModel,
  };

  const defaultModelName = (() => {
    if (managedActive) return t("notes.recordings.retranscribe.managedModel");
    if (isOpenWhisprCloud) return "OpenWhispr Cloud";
    if (upload.useLocalWhisper) {
      const provider = upload.localTranscriptionProvider;
      if (provider === "whisper") {
        return `Whisper · ${getWhisperModelInfo(upload.whisperModel)?.name ?? upload.whisperModel}`;
      }
      const model = provider === "cohere" ? upload.cohereModel : upload.parakeetModel;
      return getParakeetModelInfo(model)?.name ?? model;
    }
    if (upload.transcriptionMode === "self-hosted") {
      return t("notes.recordings.retranscribe.selfHostedModel");
    }
    const provider = getTranscriptionProvider(upload.cloudTranscriptionProvider);
    return `${provider?.name ?? upload.cloudTranscriptionProvider} · ${upload.cloudTranscriptionModel}`;
  })();

  const options = useMemo(
    () =>
      buildRetranscribeModelOptions({
        defaultLabel: t("notes.recordings.retranscribe.defaultModel", {
          model: defaultModelName,
        }),
        isSignedIn,
        managedActive,
        localModels,
        cloudProviders: getTranscriptionProviders(),
        hasApiKey: (providerId) => Boolean(getTranscriptionApiKey(providerId, apiKeys)),
      }),
    [t, defaultModelName, isSignedIn, managedActive, localModels, apiKeys]
  );
  const selected =
    options.find((option) => option.id === selectedId) ??
    options.find((option) => option.id === DEFAULT_RETRANSCRIBE_MODEL_ID);

  const totalDurationMs = recordings.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
  const running = run.kind === "running";

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ kind: "running", progress: { phase: "analyzing" } });
    try {
      localStorage.setItem(LAST_MODEL_KEY, selected?.id ?? DEFAULT_RETRANSCRIBE_MODEL_ID);
    } catch {
      // Remembering the choice is a convenience only.
    }

    const outcome = await retranscribeMeetingNote({
      noteId,
      config: applyRetranscribeModel(baseConfig, selected, (providerId) =>
        getTranscriptionApiKey(providerId, apiKeys)
      ),
      diarization: { enabled: speakerDiarizationEnabled && diarizationReady, numSpeakers: null },
      signal: controller.signal,
      onProgress: (progress) => setRun({ kind: "running", progress }),
    });
    abortRef.current = null;

    if (outcome.status === "cancelled") {
      setRun({ kind: "idle" });
      return;
    }
    if (outcome.status === "error") {
      setRun({
        kind: "error",
        message:
          outcome.code === "NO_SPEECH"
            ? t("notes.recordings.retranscribe.noSpeech")
            : t("notes.recordings.retranscribe.failed", { error: outcome.error }),
      });
      return;
    }
    if (!(await saveRetranscribedTranscript(noteId, outcome.segments))) {
      setRun({ kind: "error", message: t("notes.recordings.retranscribe.saveFailed") });
      return;
    }
    setRun({ kind: "idle" });
    onOpenChange(false);
    toast({
      title: t("notes.recordings.retranscribe.done"),
      description:
        outcome.failedChunks > 0
          ? t("notes.recordings.retranscribe.partial", { count: outcome.failedChunks })
          : undefined,
      variant: "success",
    });
  };

  const cancel = () => abortRef.current?.abort();

  const handleOpenChange = (next: boolean) => {
    // Closing mid-run would leave work running with nothing to show it.
    if (!next && running) return;
    onOpenChange(next);
  };

  const progress = run.kind === "running" ? run.progress : null;
  const percent =
    progress?.phase === "transcribing" && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  const groups: Array<{ key: string; label?: string }> = [
    { key: "default" },
    { key: "openwhispr" },
    { key: "local", label: t("notes.recordings.retranscribe.localGroup") },
    { key: "cloud", label: t("notes.recordings.retranscribe.cloudGroup") },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("notes.recordings.retranscribe.title")}</DialogTitle>
          <DialogDescription>
            {t("notes.recordings.retranscribe.description", {
              count: recordings.length,
              duration: formatDuration(totalDurationMs),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("notes.recordings.retranscribe.model")}
            </label>
            <Select
              value={selected?.id ?? DEFAULT_RETRANSCRIBE_MODEL_ID}
              onValueChange={setSelectedId}
              disabled={running}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groups.map(({ key, label }, index) => {
                  const items = options.filter((option) => option.group === key);
                  if (items.length === 0) return null;
                  return (
                    <SelectGroup key={key}>
                      {index > 0 && <SelectSeparator />}
                      {label && <SelectLabel>{label}</SelectLabel>}
                      {items.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {!running && (
            <div className="flex gap-2 rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-foreground/80">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
              <span>{t("notes.recordings.retranscribe.replaceWarning")}</span>
            </div>
          )}

          {progress && (
            <div className="space-y-2">
              <Progress value={progress.phase === "transcribing" ? percent : 5} />
              <p className="text-xs text-muted-foreground">
                {progress.phase === "analyzing"
                  ? t("notes.recordings.retranscribe.analyzing")
                  : t("notes.recordings.retranscribe.transcribing", {
                      done: progress.done,
                      total: progress.total,
                    })}
              </p>
            </div>
          )}

          {run.kind === "error" && <p className="text-xs text-destructive">{run.message}</p>}
        </div>

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={cancel}>
              {t("notes.recordings.retranscribe.cancel")}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("notes.recordings.retranscribe.close")}
              </Button>
              <Button onClick={start} disabled={recordings.length === 0}>
                {t("notes.recordings.retranscribe.start")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
