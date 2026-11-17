// FORK: runs a meeting re-transcription in the background, so the dialog can
// close and the user can keep working (specs/meeting-audio-recording/design.md
// §3.4). One run at a time: local engines hold a single model instance, and a
// second cloud run would only compete for the same note list and toasts.
// MeetingRetranscribeToastListener reports results; the note's Audio pill
// shows progress and cancels.
import { create } from "zustand";
import {
  retranscribeMeetingNote,
  saveRetranscribedTranscript,
  type RetranscribeProgress,
} from "../services/meetingRetranscription";
import type { FileTranscriptionConfig } from "../services/fileTranscription";
import type { TranscriptModelInfo } from "../utils/transcriptSource";

export type RetranscribeEvent =
  | {
      kind: "success";
      noteId: number;
      noteTitle: string;
      failedChunks: number;
      hasSummary: boolean;
    }
  | {
      kind: "error";
      noteId: number;
      noteTitle: string;
      reason: "noSpeech" | "saveFailed" | "changed" | "failed";
      error?: string;
    };

interface MeetingRetranscribeState {
  job: { noteId: number; progress: RetranscribeProgress } | null;
  events: RetranscribeEvent[];
  /** A note whose summary should be regenerated once its editor is on screen. */
  summaryRequest: number | null;
}

export const useMeetingRetranscribeStore = create<MeetingRetranscribeState>()(() => ({
  job: null,
  events: [],
  summaryRequest: null,
}));

let controller: AbortController | null = null;
let accountAtStart: string | null | undefined;
let unsubscribeScope: (() => void) | undefined;

const pushEvent = (event: RetranscribeEvent) =>
  useMeetingRetranscribeStore.setState((s) => ({ events: [...s.events, event] }));

// A run started under one account never writes into the next one's notes. The
// database scope, not the credential's, which reads signed out mid token rotation.
const watchAccount = () => {
  accountAtStart = undefined;
  void window.electronAPI
    ?.getDatabaseAccountScope?.()
    .then((scope) => {
      if (accountAtStart === undefined) accountAtStart = scope?.accountId ?? null;
    })
    .catch(() => {});
  unsubscribeScope = window.electronAPI?.onDatabaseAccountScopeChanged?.((scope) => {
    const accountId = scope?.accountId ?? null;
    if (accountAtStart === undefined) accountAtStart = accountId;
    else if (accountId !== accountAtStart) controller?.abort();
  });
};

export interface StartRetranscriptionOptions {
  noteId: number;
  config: FileTranscriptionConfig;
  diarization: { enabled: boolean; numSpeakers: number | null };
  modelInfo: TranscriptModelInfo;
}

/** False when another re-transcription is already running. */
export function startRetranscription({
  noteId,
  config,
  diarization,
  modelInfo,
}: StartRetranscriptionOptions): boolean {
  if (useMeetingRetranscribeStore.getState().job) return false;
  const runController = new AbortController();
  controller = runController;
  useMeetingRetranscribeStore.setState({ job: { noteId, progress: { phase: "analyzing" } } });
  watchAccount();

  void (async () => {
    const api = window.electronAPI;
    const readNote = () => api.getNote(noteId).catch(() => null);
    try {
      // A session recorded, or an edit made, while this runs would be lost by
      // the replacement: such a run keeps the transcript and says why.
      const transcriptAtStart = (await readNote())?.transcript ?? null;
      const outcome = await retranscribeMeetingNote({
        noteId,
        config,
        diarization,
        signal: runController.signal,
        onProgress: (progress) => {
          if (runController.signal.aborted) return;
          useMeetingRetranscribeStore.setState({ job: { noteId, progress } });
        },
      });
      if (outcome.status === "cancelled" || runController.signal.aborted) return;

      const before = await readNote();
      const noteTitle = before?.title ?? "";
      if (!before || before.deleted_at) return;
      if (outcome.status === "error") {
        pushEvent({
          kind: "error",
          noteId,
          noteTitle,
          reason: outcome.code === "NO_SPEECH" ? "noSpeech" : "failed",
          error: outcome.error,
        });
        return;
      }
      if ((before.transcript ?? null) !== transcriptAtStart) {
        pushEvent({ kind: "error", noteId, noteTitle, reason: "changed" });
        return;
      }
      if (!(await saveRetranscribedTranscript(noteId, outcome.segments))) {
        pushEvent({ kind: "error", noteId, noteTitle, reason: "saveFailed" });
        return;
      }
      const hasSummary = Boolean(before.enhanced_content?.trim());
      await api
        .recordRetranscribedSource?.(noteId, {
          ...modelInfo,
          staleSummaryHash: hasSummary ? (before.enhanced_at_content_hash ?? null) : null,
        })
        .catch(() => null);
      pushEvent({
        kind: "success",
        noteId,
        noteTitle,
        failedChunks: outcome.failedChunks,
        hasSummary,
      });
    } catch (error) {
      pushEvent({
        kind: "error",
        noteId,
        noteTitle: "",
        reason: "failed",
        error: (error as Error)?.message || String(error),
      });
    } finally {
      unsubscribeScope?.();
      unsubscribeScope = undefined;
      if (controller === runController) controller = null;
      useMeetingRetranscribeStore.setState({ job: null });
    }
  })();
  return true;
}

export function cancelRetranscription(noteId: number): void {
  if (useMeetingRetranscribeStore.getState().job?.noteId === noteId) controller?.abort();
}

export function consumeRetranscribeEvents(): RetranscribeEvent[] {
  const { events } = useMeetingRetranscribeStore.getState();
  if (events.length > 0) useMeetingRetranscribeStore.setState({ events: [] });
  return events;
}

export function requestSummaryRegeneration(noteId: number): void {
  useMeetingRetranscribeStore.setState({ summaryRequest: noteId });
}

/** True once for the note a regeneration was requested for. */
export function takeSummaryRequest(noteId: number): boolean {
  if (useMeetingRetranscribeStore.getState().summaryRequest !== noteId) return false;
  useMeetingRetranscribeStore.setState({ summaryRequest: null });
  return true;
}
