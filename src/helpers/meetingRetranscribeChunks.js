// FORK: cuts a meeting channel into pieces that are transcribed one by one
// (specs/meeting-audio-recording/design.md §3.1).
//
// Cloud and local engines return text without timestamps, so a whole channel
// can't be interleaved with the other one. Each piece instead carries its own
// start time: mic pieces are utterances split on silence, system pieces are
// diarization turns (merged per speaker), or utterances when there are none.
// Pure functions: no I/O, all times in milliseconds relative to the recording.

const DEFAULTS = {
  frameMs: 30,
  minSilenceMs: 600,
  minSpeechMs: 400,
  maxChunkMs: 30000,
  padMs: 150,
  // Frames below the floor never count as speech, however quiet the room is.
  absoluteFloor: 0.004,
  noiseMultiplier: 3,
  noisePercentile: 0.1,
  peakPercentile: 0.95,
  // The threshold never exceeds this share of the loud frames, so a channel
  // that is mostly speech (a monologue) still has speech above it.
  peakShare: 0.5,
  // A channel whose loud frames are barely above its quiet ones and still
  // quiet in absolute terms is steady background noise, not speech.
  flatRatio: 2,
  speechLevel: 0.02,
};

function frameRms(samples, frameSamples) {
  const frames = Math.floor(samples.length / frameSamples);
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * frameSamples;
    for (let i = 0; i < frameSamples; i++) {
      const v = samples[base + i] / 32768;
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / frameSamples);
  }
  return rms;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// Splits [startFrame, endFrame) into pieces of at most maxFrames, each cut at
// the quietest frame in the back half of the window so words aren't halved.
function splitLongRun(startFrame, endFrame, maxFrames, rms) {
  const pieces = [];
  let start = startFrame;
  while (endFrame - start > maxFrames) {
    const windowStart = start + Math.floor(maxFrames / 2);
    const windowEnd = start + maxFrames;
    let cut = windowEnd;
    let quietest = Infinity;
    for (let f = windowStart; f < windowEnd; f++) {
      if (rms[f] < quietest) {
        quietest = rms[f];
        cut = f;
      }
    }
    pieces.push([start, cut]);
    start = cut;
  }
  pieces.push([start, endFrame]);
  return pieces;
}

/**
 * Utterances in a mono s16 channel.
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @returns {Array<{startMs: number, endMs: number}>}
 */
function segmentBySilence(samples, sampleRate, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const frameSamples = Math.max(1, Math.round((opts.frameMs * sampleRate) / 1000));
  const rms = frameRms(samples, frameSamples);
  if (rms.length === 0) return [];

  const noise = percentile(rms, opts.noisePercentile);
  const peak = percentile(rms, opts.peakPercentile);
  if (peak < opts.absoluteFloor) return [];
  if (peak < noise * opts.flatRatio && peak < opts.speechLevel) return [];
  const threshold = Math.max(
    opts.absoluteFloor,
    Math.min(noise * opts.noiseMultiplier, peak * opts.peakShare)
  );
  const minSilenceFrames = Math.ceil(opts.minSilenceMs / opts.frameMs);
  const minSpeechFrames = Math.ceil(opts.minSpeechMs / opts.frameMs);
  const maxFrames = Math.floor(opts.maxChunkMs / opts.frameMs);
  const padFrames = Math.round(opts.padMs / opts.frameMs);

  // Runs of speech frames, joined across pauses shorter than minSilence.
  const runs = [];
  let runStart = -1;
  let lastSpeech = -1;
  let speechFrames = 0;
  const closeRun = () => {
    if (runStart >= 0 && speechFrames >= minSpeechFrames) {
      runs.push([runStart, lastSpeech + 1]);
    }
    runStart = -1;
    speechFrames = 0;
  };
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] >= threshold) {
      if (runStart >= 0 && f - lastSpeech - 1 >= minSilenceFrames) closeRun();
      if (runStart < 0) runStart = f;
      lastSpeech = f;
      speechFrames++;
    }
  }
  closeRun();

  const segments = [];
  for (const [start, end] of runs) {
    const padded = [Math.max(0, start - padFrames), Math.min(rms.length, end + padFrames)];
    for (const [s, e] of splitLongRun(padded[0], padded[1], maxFrames, rms)) {
      segments.push({ startMs: s * opts.frameMs, endMs: e * opts.frameMs });
    }
  }
  // Padding can make neighbours overlap; keep them back to back instead.
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startMs < segments[i - 1].endMs) {
      segments[i].startMs = segments[i - 1].endMs;
    }
  }
  return segments.filter((segment) => segment.endMs > segment.startMs);
}

/**
 * Diarization turns (seconds) → pieces per speaker (ms): consecutive turns of
 * the same speaker with a short pause are joined up to maxChunkMs, longer
 * turns are cut into equal pieces, and blips shorter than minSpeechMs dropped.
 * @returns {Array<{startMs: number, endMs: number, speaker: string}>}
 */
function mergeSpeakerTurns(turns, options = {}) {
  const { maxGapMs = 1500, maxChunkMs = DEFAULTS.maxChunkMs, minSpeechMs = 300 } = options;
  const sorted = (Array.isArray(turns) ? turns : [])
    .filter(
      (turn) =>
        Number.isFinite(turn?.start) &&
        Number.isFinite(turn?.end) &&
        turn.end > turn.start &&
        typeof turn.speaker === "string"
    )
    .map((turn) => ({
      startMs: Math.round(turn.start * 1000),
      endMs: Math.round(turn.end * 1000),
      speaker: turn.speaker,
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const merged = [];
  for (const turn of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.speaker === turn.speaker &&
      turn.startMs - last.endMs < maxGapMs &&
      Math.max(last.endMs, turn.endMs) - last.startMs <= maxChunkMs
    ) {
      last.endMs = Math.max(last.endMs, turn.endMs);
    } else {
      merged.push({ ...turn });
    }
  }

  const pieces = [];
  for (const turn of merged) {
    const length = turn.endMs - turn.startMs;
    if (length < minSpeechMs) continue;
    const count = Math.ceil(length / maxChunkMs);
    const step = length / count;
    for (let i = 0; i < count; i++) {
      pieces.push({
        startMs: Math.round(turn.startMs + i * step),
        endMs: Math.round(i === count - 1 ? turn.endMs : turn.startMs + (i + 1) * step),
        speaker: turn.speaker,
      });
    }
  }
  return pieces;
}

module.exports = { segmentBySilence, mergeSpeakerTurns, RETRANSCRIBE_CHUNK_DEFAULTS: DEFAULTS };
