// FORK: display names for the model that wrote a note's transcript
// (specs/meeting-audio-recording/design.md §3.5).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getParakeetModelInfo,
  getTranscriptionProvider,
  getWhisperModelInfo,
} from "../../models/ModelRegistry";
import { formatTranscriptModel, type TranscriptModelInfo } from "../../utils/transcriptSource";
import type { NoteTranscriptSource } from "../../types/electron";

export function useFormatTranscriptModel() {
  const { t } = useTranslation();
  return useCallback(
    (info: TranscriptModelInfo) =>
      formatTranscriptModel(info, {
        localName: (provider, model) =>
          provider === "whisper"
            ? getWhisperModelInfo(model)?.name
            : getParakeetModelInfo(model)?.name,
        providerName: (id) => getTranscriptionProvider(id)?.name,
        managed: t("notes.recordings.retranscribe.managedModel"),
        selfHosted: t("notes.recordings.retranscribe.selfHostedModel"),
        unknown: t("notes.recordings.source.unknownModel"),
      }),
    [t]
  );
}

/** The note's transcript source, kept current as main records new ones. */
export function useNoteTranscriptSource(noteId: number): NoteTranscriptSource | null {
  const [source, setSource] = useState<NoteTranscriptSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      window.electronAPI
        ?.getNoteTranscriptSource?.(noteId)
        .then((row) => {
          if (!cancelled) setSource(row ?? null);
        })
        .catch(() => {});
    setSource(null);
    void load();
    const dispose = window.electronAPI?.onNoteTranscriptSourceChanged?.((payload) => {
      if (payload?.noteId === noteId) void load();
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [noteId]);
  return source;
}

export function useTranscriptSourceText(source: NoteTranscriptSource | null) {
  const { t, i18n } = useTranslation();
  const format = useFormatTranscriptModel();
  if (!source) return null;
  const model = format({ engine: source.engine, model: source.model });
  const date = new Date(source.updated_at).toLocaleDateString(i18n.language, {
    day: "numeric",
    month: "short",
  });
  return {
    model,
    detail:
      source.source === "retranscribed"
        ? t("notes.recordings.source.retranscribed", { date })
        : source.mixed
          ? t("notes.recordings.source.liveMixed")
          : t("notes.recordings.source.live"),
  };
}
