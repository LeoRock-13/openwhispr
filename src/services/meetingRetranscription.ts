// FORK: re-transcribes a meeting note from its stored audio with any
// transcription model (specs/meeting-audio-recording/design.md §3.2).
//
// Main splits each recording into its two channels and cuts them into pieces
// with known start times; every piece then goes through transcribeFile, the
// same dispatch the audio upload uses, so every provider works (OpenWhispr
// Cloud, BYOK, self-hosted, local, enterprise managed) even when it returns
// text only. The note is only written once everything succeeded.
import { transcribeFile, type FileTranscriptionConfig } from "./fileTranscription";
import {
  buildRetranscribedSegments,
  type TranscribedChunk,
} from "../utils/meetingRetranscribeSegments";
import { serializeTranscriptSegments } from "../utils/transcriptSpeakerState";
import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import type { RetranscribeChunk } from "../types/electron";

export type RetranscribeProgress =
  { phase: "analyzing" } | { phase: "transcribing"; done: number; total: number };

export type RetranscribeOutcome =
  | {
      status: "success";
      segments: TranscriptSegment[];
      failedChunks: number;
      totalChunks: number;
    }
  | { status: "cancelled" }
  | { status: "error"; error: string; code?: string };

export interface RetranscribeOptions {
  noteId: number;
  config: FileTranscriptionConfig;
  diarization: { enabled: boolean; numSpeakers: number | null };
  signal?: AbortSignal;
  onProgress?: (progress: RetranscribeProgress) => void;
}

// More failed pieces than this and the result is too gappy to replace the
// transcript with.
const MAX_FAILED_SHARE = 0.1;
const CLOUD_CONCURRENCY = 3;
const RETRY_DELAY_MS = 2000;
const CANCELLED_CODE = "UPLOAD_CANCELLED";

class RetranscribeCancelled extends Error {}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export async function retranscribeMeetingNote({
  noteId,
  config,
  diarization,
  signal,
  onProgress,
}: RetranscribeOptions): Promise<RetranscribeOutcome> {
  const api = window.electronAPI;
  if (!api.splitNoteRecordings || !api.buildRetranscribeChunks) {
    return { status: "error", error: "Meeting re-transcription is not available" };
  }
  const requestId = `retx-${noteId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // One cancel stops main's split/chunking, diarization and the piece in flight.
  const cancelInMain = () => void api.cancelUploadTranscription?.(requestId);
  signal?.addEventListener("abort", cancelInMain, { once: true });
  const assertNotCancelled = () => {
    if (signal?.aborted) throw new RetranscribeCancelled();
  };

  let jobDir: string | null = null;
  try {
    onProgress?.({ phase: "analyzing" });
    const split = await api.splitNoteRecordings(noteId, requestId);
    assertNotCancelled();
    if (!split.success) {
      const failure = split as Extract<typeof split, { success: false }>;
      if (failure.code === CANCELLED_CODE) throw new RetranscribeCancelled();
      return { status: "error", error: failure.error, code: failure.code };
    }
    jobDir = split.jobDir;

    const chunks: RetranscribeChunk[] = [];
    for (const recording of split.recordings) {
      let systemTurns: Array<{ start: number; end: number; speaker: string }> | null = null;
      if (diarization.enabled && api.diarizeAudioFile) {
        const diarized = await api
          .diarizeAudioFile(recording.systemPath, {
            numSpeakers: diarization.numSpeakers ?? undefined,
            requestId,
          })
          .catch(() => null);
        assertNotCancelled();
        if (diarized?.success && diarized.segments?.length) systemTurns = diarized.segments;
      }
      const built = await api.buildRetranscribeChunks({
        jobDir,
        recordingId: recording.id,
        systemTurns,
        requestId,
      });
      assertNotCancelled();
      if (!built.success) {
        const failure = built as Extract<typeof built, { success: false }>;
        if (failure.code === CANCELLED_CODE) throw new RetranscribeCancelled();
        return { status: "error", error: failure.error, code: failure.code };
      }
      // Each recording's diarization numbers its own clusters.
      for (const chunk of built.chunks) {
        chunks.push(
          chunk.speaker ? { ...chunk, speaker: `${recording.id}:${chunk.speaker}` } : chunk
        );
      }
    }

    if (chunks.length === 0) {
      return { status: "error", error: "No speech found in the stored audio", code: "NO_SPEECH" };
    }

    const results: TranscribedChunk[] = [];
    let done = 0;
    let failed = 0;
    let lastError: { error: string; code?: string } | null = null;
    onProgress?.({ phase: "transcribing", done, total: chunks.length });

    const transcribeOne = async (chunk: RetranscribeChunk) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        assertNotCancelled();
        const result = await transcribeFile(chunk.path, config, false, {
          requestId,
          purpose: "upload",
        });
        if (signal?.aborted || result.code === CANCELLED_CODE) throw new RetranscribeCancelled();
        if (result.success) return result.text ?? "";
        lastError = { error: result.error || "Transcription failed", code: result.code };
        // One retry, mostly for rate limits on the cloud providers.
        if (attempt === 0) await wait(RETRY_DELAY_MS, signal);
      }
      return null;
    };

    // Local engines run one model instance; cloud providers take a few at once.
    const concurrency = config.useLocalWhisper ? 1 : CLOUD_CONCURRENCY;
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const text = await transcribeOne(chunk);
        if (text === null) failed++;
        else results.push({ chunk, text });
        done++;
        onProgress?.({ phase: "transcribing", done, total: chunks.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
    assertNotCancelled();

    if (failed > chunks.length * MAX_FAILED_SHARE) {
      const reason = lastError as { error: string; code?: string } | null;
      return {
        status: "error",
        error: reason?.error || "Too many parts of the audio could not be transcribed",
        code: reason?.code,
      };
    }

    return {
      status: "success",
      segments: buildRetranscribedSegments(results),
      failedChunks: failed,
      totalChunks: chunks.length,
    };
  } catch (error) {
    if (error instanceof RetranscribeCancelled || signal?.aborted) return { status: "cancelled" };
    return { status: "error", error: (error as Error)?.message || String(error) };
  } finally {
    signal?.removeEventListener("abort", cancelInMain);
    if (jobDir) void api.cleanupRetranscribeJob?.(jobDir).catch(() => {});
  }
}

// Replaces the note's transcript. Names given to the old speakers belong to
// the old numbering, so those mappings go too; the user's own ("you") stays.
export async function saveRetranscribedTranscript(
  noteId: number,
  segments: TranscriptSegment[]
): Promise<boolean> {
  const api = window.electronAPI;
  const result = await api.updateNote(noteId, {
    transcript: serializeTranscriptSegments(segments),
  });
  if (!result?.success) return false;
  try {
    const mappings = (await api.getSpeakerMappings?.(noteId)) ?? [];
    await Promise.all(
      mappings
        .filter((mapping) => mapping.speaker_id !== "you")
        .map((mapping) => api.removeSpeakerMapping?.(noteId, mapping.speaker_id))
    );
  } catch {
    // Stale names are cosmetic; the transcript itself is saved.
  }
  return true;
}
