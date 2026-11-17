// FORK: turns the transcribed pieces of a re-transcribed meeting back into
// note transcript segments (specs/meeting-audio-recording/design.md §3.2).
// Pure, so the ordering, speaker numbering and echo filtering are testable.
import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import type { RetranscribeChunk } from "../types/electron";

export interface TranscribedChunk {
  chunk: RetranscribeChunk;
  text: string;
}

// Without headphones the raw mic also picks up the other side from the
// speakers. A mic piece that overlaps a system piece in time and says nearly
// the same thing is that echo, not the user.
const ECHO_OVERLAP_SLACK_MS = 1000;
const ECHO_SIMILARITY = 0.6;

const normalizeWords = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

// Share of the shorter text's words that the other text also has.
export function textContainment(a: string, b: string): number {
  const wordsA = normalizeWords(a);
  const wordsB = normalizeWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const pool = new Map<string, number>();
  for (const word of longer) pool.set(word, (pool.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of shorter) {
    const left = pool.get(word) ?? 0;
    if (left > 0) {
      shared++;
      pool.set(word, left - 1);
    }
  }
  return shared / shorter.length;
}

export function isMicEcho(mic: TranscribedChunk, system: TranscribedChunk[]): boolean {
  return system.some(
    (other) =>
      other.chunk.startMs - ECHO_OVERLAP_SLACK_MS < mic.chunk.endMs &&
      mic.chunk.startMs < other.chunk.endMs + ECHO_OVERLAP_SLACK_MS &&
      textContainment(mic.text, other.text) >= ECHO_SIMILARITY
  );
}

/**
 * Pieces → segments ordered by time. Mic lines are the user ("you"); system
 * lines keep their diarization speaker, renumbered speaker_0, speaker_1… by
 * first appearance across every recording of the note (each recording's
 * diarization numbers its own clusters, prefixed by recording to keep them
 * apart). Empty texts and mic echoes are dropped.
 */
export function buildRetranscribedSegments(
  pieces: TranscribedChunk[],
  { idPrefix = "retx" }: { idPrefix?: string } = {}
): TranscriptSegment[] {
  const withText = pieces
    .map((piece) => ({ ...piece, text: piece.text.trim() }))
    .filter((piece) => piece.text.length > 0);
  const system = withText.filter((piece) => piece.chunk.source === "system");
  const kept = withText.filter(
    (piece) => piece.chunk.source === "system" || !isMicEcho(piece, system)
  );
  kept.sort(
    (a, b) =>
      a.chunk.startMs - b.chunk.startMs ||
      (a.chunk.source === b.chunk.source ? 0 : a.chunk.source === "mic" ? -1 : 1)
  );

  const speakerIds = new Map<string, string>();
  return kept.map((piece, index): TranscriptSegment => {
    const base = {
      id: `${idPrefix}-${index}`,
      text: piece.text,
      source: piece.chunk.source,
      timestamp: piece.chunk.startMs,
    };
    if (piece.chunk.source === "mic") {
      return { ...base, speaker: "you", speakerIsPlaceholder: false, speakerStatus: "confirmed" };
    }
    if (!piece.chunk.speaker) return base;
    let speaker = speakerIds.get(piece.chunk.speaker);
    if (!speaker) {
      speaker = `speaker_${speakerIds.size}`;
      speakerIds.set(piece.chunk.speaker, speaker);
    }
    return { ...base, speaker, speakerIsPlaceholder: false, speakerStatus: "confirmed" };
  });
}
