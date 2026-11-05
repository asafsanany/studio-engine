import { useEffect, useState } from 'react';

// The waveform of a voice note's card: 28 bars from the loudness of its audio. The audio is
// fetched and decoded with WebAudio once per note and the peaks are kept; a note whose audio the
// browser can't decode (it happens with some formats in some browsers) keeps its flat bars.

/** The bars of a voice note's waveform. */
export const VOICE_BARS = 28;
/** The shortest and the tallest bar in px (the board's 4 and 22). */
export const BAR_MIN_PX = 4;
export const BAR_MAX_PX = 22;

/**
 * The loudness of each of `bars` equal slices (0 to 1, the loudest slice is 1); all zeros for
 * silence or no samples. Each bar is the largest absolute sample of any channel in its slice.
 */
export function computePeaks(
  channels: readonly Float32Array[],
  bars: number = VOICE_BARS,
): number[] {
  const peaks = new Array<number>(bars).fill(0);
  const frames = channels[0]?.length ?? 0;
  if (frames === 0 || bars <= 0) return peaks;
  const slice = Math.ceil(frames / bars);
  for (const channel of channels) {
    const length = Math.min(channel.length, frames);
    for (let index = 0; index < length; index++) {
      const bar = Math.floor(index / slice);
      const level = Math.abs(channel[index] ?? 0);
      if (level > (peaks[bar] ?? 0)) peaks[bar] = level;
    }
  }
  const loudest = Math.max(...peaks);
  if (!(loudest > 0)) return new Array<number>(bars).fill(0);
  return peaks.map((level) => level / loudest);
}

/** Bar heights in px from the peaks; `null` (not decoded yet) gives the flat `BAR_MIN_PX` row. */
export function peakBarHeights(
  peaks: readonly number[] | null,
  bars: number = VOICE_BARS,
): number[] {
  return Array.from({ length: bars }, (_, index) => {
    const level = peaks?.[index];
    const peak =
      level !== undefined && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    return Math.round(BAR_MIN_PX + peak * (BAR_MAX_PX - BAR_MIN_PX));
  });
}

export interface PeaksDeps {
  /** Default `globalThis.fetch`. */
  fetch?: (url: string) => Promise<Response>;
  /** Default: `OfflineAudioContext.decodeAudioData`, every channel. */
  decode?: (data: ArrayBuffer) => Promise<Float32Array[]>;
}

/**
 * WebAudio's decoder, on an `OfflineAudioContext`: unlike an `AudioContext` it needs no click, and
 * it makes no "was not allowed to start" warning. Rejects where the browser has none or can't
 * read the format.
 */
async function decodeChannels(data: ArrayBuffer): Promise<Float32Array[]> {
  const Context: typeof OfflineAudioContext | undefined =
    globalThis.OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (Context === undefined) throw new Error('This browser has no WebAudio.');
  const buffer = await new Context(1, 1, 44100).decodeAudioData(data);
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel),
  );
}

/** Peaks by key (the note id), once they are known: so a card that comes back shows them at once. */
const settled = new Map<string, number[]>();
/** The loads, by key: one fetch and one decode per note. */
const loads = new Map<string, Promise<number[]>>();

/** The peaks of a voice note's audio, fetched and decoded once per key (the note id); a failure is not kept. */
export function loadVoicePeaks(url: string, key: string, deps: PeaksDeps = {}): Promise<number[]> {
  const existing = loads.get(key);
  if (existing) return existing;
  const fetchAudio = deps.fetch ?? ((target: string) => globalThis.fetch(target));
  const decode = deps.decode ?? decodeChannels;
  const load = (async () => {
    const response = await fetchAudio(url);
    if (!response.ok) throw new Error(`The audio did not load (${response.status}).`);
    const peaks = computePeaks(await decode(await response.arrayBuffer()));
    settled.set(key, peaks);
    return peaks;
  })();
  loads.set(key, load);
  load.catch(() => {
    // A failure is not kept: the next card to ask tries again.
    if (loads.get(key) === load) loads.delete(key);
  });
  return load;
}

/** `loadVoicePeaks` in a component: `null` until decoded (and on a failure: the bars stay flat). */
export function useVoicePeaks(url: string, key: string): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => settled.get(key) ?? null);
  useEffect(() => {
    let mounted = true;
    loadVoicePeaks(url, key).then(
      (loaded) => {
        if (mounted) setPeaks(loaded);
      },
      () => {
        // Nothing to show: the bars stay flat.
      },
    );
    return () => {
      mounted = false;
    };
  }, [url, key]);
  return peaks;
}
