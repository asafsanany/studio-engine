// Measuring a song for the music script's `song` command (Songs, SG3). Pure helpers, no writes: the
// script (make-music.mjs) runs ffmpeg and hyperframes, calls these to read the decoded song and
// choose its part, and writes the files and the record itself. Plain Node, no dependencies, so it
// runs from the engine's assets/ folder in src and dist alike.
//
// The part is the window of the cut's length that starts on a downbeat and holds the biggest rise of
// energy (the drop or the chorus), preferring one after the intro:
//   - the song is decoded once to a 48 kHz stereo float WAV; its loudness is read as mean power per
//     50 ms hop (`energyEnvelope`);
//   - `npx hyperframes audio … --only beats,downbeats,bpm,sections --json` gives the beats, the
//     downbeats, the tempo and the sections (`parseHyperframes`); the first section is the intro;
//   - `riseDb` is how much louder the next 1.5 s are than the last 1.5 s; its biggest value after the
//     intro is the drop, found on a 100 ms grid (`choosePart`), and the part starts on the last
//     downbeat at or just before it. A song shorter than the cut is used whole.
//   - `dropMs`, the drop the editor cuts to, is where the bass comes in: the first strong onset in the
//     low band (30 to 150 Hz) shortly after that step (`bassOnsetAfter`, read from a second, tiny
//     decode of the song through the low-pass `LOW_BAND_FILTER`). The step itself is the loudness
//     jumping, which on real songs is 0.5 to 0.8 s before the bass is heard (C73). Without a low
//     band to read, or without a strong onset in it, `dropMs` stays at the step.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** What the part-finder reads and decides with. */
export const PART = {
  /** The energy envelope's step. */
  hopMs: 50,
  /** SONG_LIMITS.partMinMs / partMaxMs in the shared contract. */
  minMs: 3_000,
  maxMs: 120_000,
  /** A rise smaller than this is no drop: the part then starts after the intro instead. */
  minRiseDb: 1.5,
  /** Nothing before this can be a drop (there is no music before it to rise from). */
  introMs: 2_000,
  /** A drop needs at least this much song after it inside the window. */
  tailMs: 4_000,
  /** The drop is the sharpest step of loudness, looked for on this grid with this width each side. */
  dropStepMs: 100,
  dropWidthMs: 1_500,
  /** The low band the drop's bass is looked for in, decoded to its own small WAV (see LOW_BAND_FILTER). */
  lowBandHz: [30, 150],
  lowSampleRate: 1_000,
  lowHopMs: 20,
  /** A bass onset: the next `bassAfterMs` are this much louder than the `bassBeforeMs` before it... */
  bassAfterMs: 120,
  bassBeforeMs: 400,
  bassRiseDb: 6,
  /** ...and the next `bassSustainMs` stay within this many dB of the song's loud bass level. */
  bassSustainMs: 500,
  bassWithinDb: 12,
  /** The bass is looked for from the loudness step until this long after it. */
  bassSearchMs: 2_000,
  /** The decoded WAV the measuring reads. */
  sampleRate: 48_000,
  /** A sample this quiet or quieter is silence (-60 dBFS). */
  silentPeak: 0.001,
};

const EPSILON = 1e-9;

/**
 * The ffmpeg filter that makes the low band's WAV out of the decoded song: 30 to 150 Hz, then
 * resampled to `PART.lowSampleRate` (a 200 s song is 1.6 MB). Stereo 32-bit float like the song's.
 */
export const LOW_BAND_FILTER = `highpass=f=${PART.lowBandHz[0]},lowpass=f=${PART.lowBandHz[1]},aresample=${PART.lowSampleRate}`;

// --- the decoded song ----------------------------------------------------------------------------

/**
 * Where the audio is in a WAV file that ffmpeg wrote as stereo 32-bit float:
 * `{ rate, frames, dataStart }`. Throws when it is some other WAV.
 */
export function readWavInfo(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, head, 0, head.length, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      throw new Error('the decoded song is not a WAV file');
    }
    let fmt = null;
    let at = 12;
    while (at + 8 <= head.length) {
      const id = head.toString('latin1', at, at + 4);
      const length = head.readUInt32LE(at + 4);
      if (id === 'fmt ' && at + 24 <= head.length) {
        fmt = {
          channels: head.readUInt16LE(at + 10),
          rate: head.readUInt32LE(at + 12),
          bits: head.readUInt16LE(at + 22),
        };
      } else if (id === 'data') {
        if (fmt === null || fmt.channels !== 2 || fmt.bits !== 32) {
          throw new Error('the decoded song is not stereo 32-bit float');
        }
        const dataStart = at + 8;
        const bytes = Math.min(length, size - dataStart);
        return { rate: fmt.rate, frames: Math.floor(bytes / 8), dataStart };
      }
      at += 8 + length + (length % 2);
    }
    throw new Error('the decoded song has no audio in it');
  } finally {
    closeSync(fd);
  }
}

/** An energy envelope from mean power per hop (`power`), with the sums `windowPower` reads. */
export function envelopeFromPower(power, hopMs = PART.hopMs) {
  const prefix = new Float64Array(power.length + 1);
  for (let i = 0; i < power.length; i++) prefix[i + 1] = (prefix[i] ?? 0) + (power[i] ?? 0);
  return { hopMs, power, prefix };
}

/** The song's mean power (mono) in every `hopMs` step, read from the WAV `info` describes. */
export function energyEnvelope(path, info, hopMs = PART.hopMs) {
  const hopFrames = Math.max(1, Math.round((info.rate * hopMs) / 1000));
  const hops = Math.ceil(info.frames / hopFrames);
  const power = new Float64Array(hops);
  const counts = new Float64Array(hops);
  const chunkFrames = hopFrames * 200;
  const buffer = Buffer.alloc(chunkFrames * 8);
  const fd = openSync(path, 'r');
  try {
    let frame = 0;
    while (frame < info.frames) {
      const want = Math.min(chunkFrames, info.frames - frame);
      const got = readSync(fd, buffer, 0, want * 8, info.dataStart + frame * 8);
      const frames = Math.floor(got / 8);
      if (frames === 0) break;
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, frames * 2);
      let hop = Math.floor(frame / hopFrames);
      let nextHop = (hop + 1) * hopFrames;
      for (let i = 0; i < frames; i++) {
        if (frame + i >= nextHop) {
          hop++;
          nextHop += hopFrames;
        }
        const mono = ((samples[2 * i] ?? 0) + (samples[2 * i + 1] ?? 0)) * 0.5;
        power[hop] = (power[hop] ?? 0) + mono * mono;
        counts[hop] = (counts[hop] ?? 0) + 1;
      }
      frame += frames;
    }
  } finally {
    closeSync(fd);
  }
  for (let i = 0; i < hops; i++) power[i] = (power[i] ?? 0) / Math.max(1, counts[i] ?? 0);
  return envelopeFromPower(power, hopMs);
}

/** The loudest sample (0 to 1) in `count` frames of the WAV from `frame`. */
export function peakAt(path, info, frame, count) {
  const frames = Math.max(0, Math.min(count, info.frames - frame));
  if (frames === 0) return 0;
  const buffer = Buffer.alloc(frames * 8);
  const fd = openSync(path, 'r');
  try {
    const got = readSync(fd, buffer, 0, frames * 8, info.dataStart + frame * 8);
    const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(got / 4));
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return peak;
  } finally {
    closeSync(fd);
  }
}

// --- hyperframes -----------------------------------------------------------------------------------

/**
 * What `hyperframes audio --json` said, as `{ beatsMs, downbeatsMs, bpm, sectionStartsMs }` (the
 * section starts without the first, which is the song's start), or `null` when the text is not its
 * answer. Its times are seconds from the file's start.
 */
export function parseHyperframes(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  let doc;
  try {
    doc = JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
  const item = Array.isArray(doc?.items) ? doc.items[0] : null;
  if (item === null || typeof item !== 'object') return null;
  const times = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((sec) => typeof sec === 'number' && Number.isFinite(sec) && sec >= 0)
      .map((sec) => sec * 1000)
      .sort((a, b) => a - b);
  const spans = Array.isArray(item.sections?.spans) ? item.sections.spans : [];
  const bpm = item.bpm?.value;
  return {
    beatsMs: times(item.beats?.times),
    downbeatsMs: times(item.downbeats?.times),
    bpm: typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    sectionStartsMs: times(spans.slice(1).map((span) => span?.start)),
  };
}

// --- choosing the part -----------------------------------------------------------------------------

/** Mean power in [fromMs, toMs) of an envelope. */
export function windowPower(envelope, fromMs, toMs) {
  const from = Math.max(0, Math.floor(fromMs / envelope.hopMs));
  const to = Math.min(envelope.power.length, Math.ceil(toMs / envelope.hopMs));
  if (to <= from) return 0;
  return ((envelope.prefix[to] ?? 0) - (envelope.prefix[from] ?? 0)) / (to - from);
}

/**
 * How much louder (dB, mean power) `widthMs` of song after `atMs` is than `widthMs` before it. 0
 * where there is no music before it (the first seconds) or too little song after it.
 */
export function riseDb(envelope, atMs, widthMs, durationMs) {
  if (atMs < PART.introMs) return 0;
  const afterEnd = Math.min(durationMs, atMs + widthMs);
  if (afterEnd - atMs < Math.min(widthMs, 1_500)) return 0;
  const before = windowPower(envelope, Math.max(0, atMs - widthMs), atMs);
  const after = windowPower(envelope, atMs, afterEnd);
  const db = 10 * Math.log10((after + EPSILON) / (before + EPSILON));
  return Math.max(-30, Math.min(30, db));
}

/** How loud the song's bass is when it is loud: the 95th percentile of 500 ms mean power. 0 for none. */
function loudBassLevel(low) {
  const levels = [];
  const stepMs = 100;
  const spanMs = low.power.length * low.hopMs;
  for (let at = 0; at + PART.bassSustainMs <= spanMs; at += stepMs) {
    levels.push(windowPower(low, at, at + PART.bassSustainMs));
  }
  if (levels.length === 0) return 0;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(0.95 * (levels.length - 1))] ?? 0;
}

/**
 * Where the bass comes in: the first strong onset of the low band (`low` is its energy envelope, see
 * `LOW_BAND_FILTER`) from `fromMs` (less one loudness step, which is the grid the step was found on)
 * to `toMs`, in ms from the song's start; `null` when there is none. An onset is strong when the next
 * 120 ms are 6 dB louder than the 400 ms before, and the next 500 ms stay within 12 dB of the song's
 * loud bass level, so a ghost note or a quiet verse does not count and a loud one does. It is
 * placed on the first 20 ms of the bass itself.
 */
export function bassOnsetAfter(low, fromMs, toMs) {
  const level = loudBassLevel(low);
  if (!(level > 0)) return null;
  const floor = level * 10 ** (-PART.bassWithinDb / 10);
  const first = Math.max(PART.bassBeforeMs, fromMs - PART.dropStepMs);
  for (let at = Math.ceil(first / low.hopMs) * low.hopMs; at <= toMs; at += low.hopMs) {
    const before = windowPower(low, at - PART.bassBeforeMs, at);
    const after = windowPower(low, at, at + PART.bassAfterMs);
    if (10 * Math.log10((after + EPSILON) / (before + EPSILON)) < PART.bassRiseDb) continue;
    const sustain = windowPower(low, at, at + PART.bassSustainMs);
    if (sustain < floor) continue;
    // The window already fires when a trace of the bass enters it (up to 120 ms before the bass):
    // the onset is the first hop of it that is within 6 dB of how loud the bass then stays.
    for (let hop = at; hop < at + PART.bassAfterMs + low.hopMs; hop += low.hopMs) {
      if (windowPower(low, hop, hop + low.hopMs) >= sustain / 4) return hop;
    }
    return at;
  }
  return null;
}

/**
 * The part of a song the video uses, as `{ startMs, lengthMs, how, dropMs, riseDb, clear }`:
 *  - `how` is `whole` when the song is no longer than the cut (all of it, from its start), or when
 *    only the reel's own audio could be had (`asIs`: it already is the part, from its start);
 *    otherwise `measured`.
 *  - the drop is the sharpest step of loudness after the intro (the first section; a step inside
 *    it only when nothing after it is clear). `startMs` is the last downbeat at or just before it,
 *    so the part holds the drop in its first bar; it slides earlier only as far as the song's end
 *    needs. Without a clear drop the part starts on the first downbeat after the intro. Without any
 *    downbeat it starts on the drop itself.
 *  - `dropMs` is where the drop is heard inside the part (in the song, not the part): the first
 *    strong bass onset (`lowEnvelope`, when it is given) within 2 s after the sharpest step inside
 *    the part, else that step; `null` when no step is clear. `clear` says whether the part was
 *    chosen for a clear drop.
 * `lengthMs` is the cut's length, cut down to the longest part there can be.
 */
export function choosePart({
  durationMs,
  cutMs,
  envelope,
  beatsMs = [],
  downbeatsMs = [],
  sectionStartsMs = [],
  bpm = null,
  asIs = false,
  lowEnvelope = null,
}) {
  const target = Math.min(cutMs, PART.maxMs);
  const beatMs = bpm === null ? 500 : 60_000 / bpm;
  // A downbeat this much after the drop still counts as on it (the beat finder is a little late).
  const tolerance = Math.min(beatMs / 2, 300);

  let starts = [...downbeatsMs];
  if (starts.length === 0 && beatsMs.length > 0) starts = beatsMs.filter((_, i) => i % 4 === 0);
  starts = [...new Set(starts)].sort((a, b) => a - b);

  // The sharpest step of loudness in [fromMs, toMs].
  const bestRiseIn = (fromMs, toMs) => {
    let best = { atMs: null, db: 0 };
    const first = Math.ceil(fromMs / PART.dropStepMs) * PART.dropStepMs;
    for (let at = first; at <= toMs; at += PART.dropStepMs) {
      const db = riseDb(envelope, at, PART.dropWidthMs, durationMs);
      if (db > best.db) best = { atMs: at, db };
    }
    return best;
  };
  const isClear = (rise) => rise.atMs !== null && rise.db >= PART.minRiseDb;
  // Where the drop is heard: the bass coming in just after the loudness step (not before the part's
  // start, nor past its end), else the step itself.
  const dropAt = (rise, fromMs, endMs) => {
    if (!isClear(rise)) return null;
    if (lowEnvelope === null) return rise.atMs;
    const to = Math.min(rise.atMs + PART.bassSearchMs, endMs - 1);
    const bass = bassOnsetAfter(lowEnvelope, rise.atMs, to);
    return bass === null ? rise.atMs : Math.max(fromMs, bass);
  };

  const whole = (length) => {
    const drop = bestRiseIn(0, length - PART.tailMs);
    return {
      startMs: 0,
      lengthMs: length,
      how: 'whole',
      dropMs: dropAt(drop, 0, length),
      riseDb: drop.db,
      clear: isClear(drop),
    };
  };
  if (asIs) return whole(Math.min(target, durationMs));
  if (durationMs <= target) return whole(durationMs);

  // The intro ends where the second section starts (when that is early enough to be an intro); a
  // clear drop after it beats any in it.
  const firstSection = sectionStartsMs[0] ?? 0;
  const introEnd = firstSection <= Math.min(30_000, durationMs * 0.35) ? firstSection : 0;
  const lastDrop = durationMs - Math.min(target, PART.tailMs);
  let found = bestRiseIn(Math.max(0, introEnd - tolerance), lastDrop);
  if (!isClear(found)) found = bestRiseIn(0, lastDrop);
  const clear = isClear(found);

  let startMs;
  if (clear) {
    // The last downbeat at or just before the drop; the drop itself when none is near.
    const last = [...starts].reverse().find((at) => at <= found.atMs + tolerance);
    startMs = last !== undefined && found.atMs - last <= 8 * beatMs ? last : found.atMs;
  } else {
    startMs =
      starts.find((at) => at >= introEnd - tolerance && at + target <= durationMs) ??
      starts.find((at) => at + target <= durationMs) ??
      0;
  }
  if (startMs + target > durationMs) {
    // The drop is too near the end for a whole window from it: end on the song's end instead.
    const room = durationMs - target;
    startMs = [...starts].reverse().find((at) => at <= room) ?? Math.max(0, room);
  }
  startMs = Math.max(0, startMs);

  const drop = bestRiseIn(startMs, startMs + target - Math.min(target, PART.dropWidthMs));
  return {
    startMs,
    lengthMs: target,
    how: 'measured',
    dropMs: dropAt(drop, startMs, startMs + target),
    riseDb: clear ? found.db : drop.db,
    clear,
  };
}

/**
 * The part for a cut that wants the song's words to start `lyricsAtMs` into it: the part starts
 * that long before the song's first word (`firstMs`), so the song's own intro is the lead-in. When
 * the word comes sooner than that the part starts at the song's start (the word is then earlier in
 * the part than asked), and it slides earlier only as far as the song's end needs. `null` when the
 * song is no longer than the cut (it is used whole, as `choosePart` does).
 *   `dropMs` is `null`: the moment is the words, not a drop.
 */
export function partAroundFirstWord({ durationMs, cutMs, firstMs, lyricsAtMs }) {
  const lengthMs = Math.min(cutMs, PART.maxMs);
  if (durationMs <= lengthMs) return null;
  const startMs = Math.min(Math.max(0, firstMs - lyricsAtMs), durationMs - lengthMs);
  return { startMs, lengthMs, how: 'measured', dropMs: null, riseDb: 0, clear: false };
}

/**
 * The part that starts exactly `startMs` into the song (the brief names the moment: "start the song
 * at 0:37"). It slides earlier only as far as the song's end needs, and `null` when the song is no
 * longer than the cut (it is used whole, as `choosePart` does).
 *   `dropMs` is `null`: the moment is the one asked for, not a drop.
 */
export function partFromStart({ durationMs, cutMs, startMs }) {
  const lengthMs = Math.min(cutMs, PART.maxMs);
  if (durationMs <= lengthMs) return null;
  const at = Math.min(Math.max(0, startMs), durationMs - lengthMs);
  return { startMs: at, lengthMs, how: 'measured', dropMs: null, riseDb: 0, clear: false };
}

// --- the line for Instagram ----------------------------------------------------------------------

/** 42000 ms is "0:42" (clock in the shared format.ts). */
export function clockText(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** `text` cut to at most `max` UTF-16 units, ending in an ellipsis when it was cut. */
export function clip(text, max) {
  if (text.length <= max) return text;
  const characters = Array.from(text);
  while (characters.length > 0 && characters.join('').length + 1 > max) characters.pop();
  return `${characters.join('')}…`;
}

/** The longest the line may be (SONG_LIMITS.instagramLineMax in the shared contract). */
export const INSTAGRAM_LINE_MAX = 240;

/**
 * "In Instagram tap Add audio, pick [title] by [artist] and slide it to start at [m:ss]." as the
 * shared contract's `instagramLine` writes it (the script cannot import it; a test compares them).
 */
export function instagramLine({ title, artist, part }) {
  const build = (name, by) =>
    `In Instagram tap Add audio, pick ${name} by ${by} and slide it to start at ${clockText(part.startMs)}.`;
  const room = INSTAGRAM_LINE_MAX - build('', '').length;
  const half = Math.floor(room / 2);
  let name = title;
  let by = artist;
  if (name.length + by.length > room) {
    if (name.length <= half) by = clip(by, room - name.length);
    else if (by.length <= half) name = clip(name, room - by.length);
    else {
      name = clip(name, half);
      by = clip(by, room - half);
    }
  }
  return build(name, by);
}
