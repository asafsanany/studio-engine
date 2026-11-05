// Types of song-part.mjs, the song measuring of the music script's `song` command (Songs, SG3), for
// its tests and the script.

export const PART: {
  hopMs: number;
  minMs: number;
  maxMs: number;
  minRiseDb: number;
  introMs: number;
  tailMs: number;
  dropStepMs: number;
  dropWidthMs: number;
  /** The low band (Hz) the drop's bass is looked for in, and its small WAV's rate and hop. */
  lowBandHz: readonly [number, number];
  lowSampleRate: number;
  lowHopMs: number;
  bassAfterMs: number;
  bassBeforeMs: number;
  bassRiseDb: number;
  bassSustainMs: number;
  bassWithinDb: number;
  bassSearchMs: number;
  sampleRate: number;
  silentPeak: number;
};

export interface WavInfo {
  rate: number;
  frames: number;
  /** Byte offset of the first sample. */
  dataStart: number;
}

/** Where the audio is in a stereo 32-bit float WAV; throws for any other WAV. */
export function readWavInfo(path: string): WavInfo;

export interface Envelope {
  hopMs: number;
  /** Mean power (mono) per hop. */
  power: Float64Array | number[];
  prefix: Float64Array;
}

export function envelopeFromPower(power: Float64Array | number[], hopMs?: number): Envelope;
export function energyEnvelope(path: string, info: WavInfo, hopMs?: number): Envelope;
/** The loudest sample (0 to 1) in `count` frames from `frame`. */
export function peakAt(path: string, info: WavInfo, frame: number, count: number): number;

export interface HyperframesAudio {
  beatsMs: number[];
  downbeatsMs: number[];
  bpm: number | null;
  /** Without the first (the song's start). */
  sectionStartsMs: number[];
}

/** What `hyperframes audio --json` said; `null` when the text is not its answer. */
export function parseHyperframes(text: string): HyperframesAudio | null;

export function windowPower(envelope: Envelope, fromMs: number, toMs: number): number;
/** The ffmpeg filter that makes the low band's WAV (30 to 150 Hz, 1 kHz) out of the decoded song. */
export const LOW_BAND_FILTER: string;

/**
 * Where the bass comes in: the first strong onset of the low band's `low` envelope from `fromMs` to
 * `toMs` (ms from the song's start), `null` when there is none.
 */
export function bassOnsetAfter(low: Envelope, fromMs: number, toMs: number): number | null;

export function riseDb(
  envelope: Envelope,
  atMs: number,
  widthMs: number,
  durationMs: number,
): number;

export interface ChosenPart {
  startMs: number;
  lengthMs: number;
  how: 'measured' | 'whole';
  /**
   * Where the drop is heard inside the part, in the song (not the part): the first strong bass onset
   * within 2 s after the biggest rise (the rise itself without a `lowEnvelope`, or when the bass has
   * no onset there); `null` when no rise is clear.
   */
  dropMs: number | null;
  riseDb: number;
  /** Whether the part was chosen for a clear rise. */
  clear: boolean;
}

export function choosePart(options: {
  durationMs: number;
  cutMs: number;
  envelope: Envelope;
  beatsMs?: readonly number[];
  downbeatsMs?: readonly number[];
  sectionStartsMs?: readonly number[];
  bpm?: number | null;
  /** Only the reel's own audio was had: it already is the part. */
  asIs?: boolean;
  /** The energy envelope of the song's low band (`LOW_BAND_FILTER`); without it `dropMs` is the rise itself. */
  lowEnvelope?: Envelope | null;
}): ChosenPart;

/**
 * The part that holds the song's first word `lyricsAtMs` into it (the song's own intro as the
 * lead-in); `null` when the song is no longer than the cut.
 */
export function partAroundFirstWord(options: {
  durationMs: number;
  cutMs: number;
  /** Where the song's first word starts, ms from the song's start. */
  firstMs: number;
  lyricsAtMs: number;
}): ChosenPart | null;

/**
 * The part that starts `startMs` into the song (earlier only as far as the song's end needs);
 * `null` when the song is no longer than the cut.
 */
export function partFromStart(options: {
  durationMs: number;
  cutMs: number;
  /** Where the part should start, ms from the song's start. */
  startMs: number;
}): ChosenPart | null;

export function clockText(ms: number): string;
export function clip(text: string, max: number): string;
export const INSTAGRAM_LINE_MAX: number;
export function instagramLine(song: {
  title: string;
  artist: string;
  part: { startMs: number };
}): string;
