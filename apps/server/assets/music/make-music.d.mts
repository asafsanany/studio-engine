// Types of make-music.mjs, the music script (Soundtrack; SD0 contract, SD1 ElevenLabs), for its
// tests and the engine. The shapes it reads and writes are the shared contract's (packages/shared/src/domain/
// music.ts); these are only the script's own exports.

export const FILES: {
  dir: string;
  plan: string;
  record: string;
  lock: string;
  preview: string;
  songFull: string;
  songReel: string;
  song: string;
};

export const LIMITS: {
  sectionMinMs: number;
  sectionMaxMs: number;
  lengthMinMs: number;
  lengthMaxMs: number;
  describeMax: number;
  versionDescribeMax: number;
  askMax: number;
};

export const EXIT: { ok: 0; failed: 1; refused: 2; down: 3 };

export const KEY_FILE: string;

export const ELEVENLABS: {
  base: string;
  model: string;
  outputFormat: string;
  bitrate: string;
  sampleRate: number;
  composeTimeoutMs: number;
  planTimeoutMs: number;
  retryMs: number;
};

export const LOUDNESS: { integratedLufs: number; truePeakDbtp: number };

export const ALWAYS_AVOID: readonly string[];

/** ELEVENLABS_API_KEY from `file` (default KEY_FILE), then `env`; `null` when neither has one. */
export function readKey(env?: Record<string, string | undefined>, file?: string): string | null;

export class MusicError extends Error {
  constructor(code: string, message: string);
  readonly code: string;
}

export function exitCodeFor(code: string): number;

/** SONG_FAILURE_CODES, SONG_VERSIONS, SONG_ASKED_FROM, SONG_ASKED_BY, SONG_LIMITS in the shared contract. */
export const SONG_FAILURE_CODES: readonly string[];
export const SONG_VERSIONS: readonly string[];
export const SONG_ASKED_FROM: readonly string[];
export const SONG_ASKED_BY: readonly string[];
export const SONG_LIMITS: {
  titleMax: number;
  artistMax: number;
  instagramLineMax: number;
  partMinMs: number;
  partMaxMs: number;
};

/** What a part of a song is levelled to. */
export const SONG_LOUDNESS: { integratedLufs: number; truePeakDbtp: number };

/** How a part is cut, and how long the beat finder gets. */
export const SONG_CUT: { fadeInMs: number; fadeOutMs: number; hyperframesTimeoutMs: number };

export function redact(text: unknown): string;

export interface MusicFailureFor {
  code: 'no_credits' | 'no_access' | 'no_key' | 'down' | 'bad_plan' | 'failed';
  message: string;
  /** Whether one more try may help (a 5xx, a 429). */
  retry: boolean;
}

export function failureFor(status: number, body: unknown): MusicFailureFor;

export function loudnessGain(integrated: number, truePeak: number, ceiling?: number): number;

export type MusicCommand = 'make' | 'pick' | 'supplied' | 'series' | 'none' | 'song' | 'song-note';

export interface MusicArgs {
  command: Exclude<MusicCommand, 'song' | 'song-note'>;
  /** Absolute. */
  editDir: string;
  again: boolean;
  ask: string | null;
  by: 'edit' | 'revise' | 'you';
  fake: boolean;
  /** pick: v1 …, off, file, series or song; supplied and series: the file; none: the reason; make: null. */
  target: string | null;
  /** none --plan (U21): keep edit/music/plan.json's plan in the record and put silence of its length at music.mp3. */
  plan: boolean;
}

/** The `song` command's call (Songs, SG3): what is asked for, how, and by whom. */
export interface SongArgs {
  command: 'song';
  /** Absolute. */
  editDir: string;
  again: false;
  ask: null;
  by: 'brief' | 'you' | 'editor';
  fake: boolean;
  target: null;
  title: string | null;
  artist: string | null;
  version: string | null;
  link: string | null;
  trending: boolean;
  niche: string | null;
  from: 'screenshot' | 'link' | 'name' | 'note' | 'trending';
  file: string | null;
  lengthMs: number | null;
  /** `--lyrics-at`: the moment of the cut (ms) where the song's words should start; `null` for none. */
  lyricsAtMs: number | null;
  /** `--start-ms`: the moment of the song (ms) where the part starts; `null` for none. */
  startMs: number | null;
  /** Default process.env: the tools' paths, HOME, the test hooks. */
  env?: Record<string, string | undefined>;
}

/** The `song-note` command's call (RGM1): the screenshot's audio is "Original audio", so no song is looked up. */
export interface SongNoteArgs {
  command: 'song-note';
  /** Absolute. */
  editDir: string;
  again: false;
  ask: null;
  by: 'brief';
  fake: boolean;
  target: null;
  /** The account under the label (music.original.by), or `null` for none. */
  original: string | null;
  /** Default process.env. */
  env?: Record<string, string | undefined>;
}

export function parseArgs(
  argv: readonly string[],
  env?: Record<string, string | undefined>,
): MusicArgs | SongArgs | SongNoteArgs | { error: string };

export function planProblem(plan: unknown): string | null;

export function emptyRecord(): Record<string, unknown>;

export function nextVersionId(record: { versions: readonly { id: string }[] } | null): string;

export function findTool(name: string, env?: Record<string, string | undefined>): string | null;

export function toneFrequency(id: string): number;

export function versionDescribe(plan: { describe: string }, ask: string | null): string;

/** A plan's shape as the script reads it (MusicPlan in the shared contract). */
export interface ScriptPlan {
  lengthMs: number;
  styles: string[];
  avoid: string[];
  sections: { name: string; ms: number; styles: string[]; avoid: string[] }[];
  describe: string;
}

export interface CompositionChunk {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles: string[];
  context_adherence?: 'low' | 'medium' | 'high';
}

export function toComposition(plan: ScriptPlan): { chunks: CompositionChunk[] };

export function restyledPlan(plan: ScriptPlan, ask: string, answer: unknown): ScriptPlan;

export function restyle(
  plan: ScriptPlan,
  ask: string,
  options: { fake: boolean; env?: Record<string, string | undefined> },
): Promise<ScriptPlan>;

export function compose(options: {
  plan: ScriptPlan;
  id: string;
  seed: number;
  out: string;
  fake: boolean;
  env?: Record<string, string | undefined>;
}): Promise<{ model: string; lengthMs: number }>;

/** A plan for a song-only record: the cut's length in plain sections of at most 2 minutes. */
export function plainPlan(lengthMs: number): ScriptPlan;

/** What the `song-note` command prints, on top of `ok`, `id` (the pick, or `none`) and `lengthMs` (`null`). */
export interface SongNoteOk {
  command: 'song-note';
  /** What the record's `songFailure.asked` says: "Original audio · @x". */
  asked: string;
  /** `false` for a record that already has a song: nothing was written. */
  recorded: boolean;
}

/** What the `song` command prints on success, on top of `ok`, `id` and `lengthMs`. */
export interface SongOk {
  command: 'song';
  part: {
    startMs: number;
    endMs: number;
    how: 'measured' | 'whole';
    /** How many beats the finder found in the part; 0 for none (a ballad, or no finder). */
    beatCount: number;
  };
  /** Ms from the part's start. */
  beats: number[];
  downbeats: number[];
  bpm: number | null;
  /**
   * Where the drop is heard, ms from the part's start: the first strong bass (30 to 150 Hz) onset
   * just after the part's sharpest loudness step, else that step; `null` when no rise is clear.
   */
  dropMs: number | null;
  /**
   * With `--lyrics-at`: where the song's first word is heard, ms from the part's start (the asked
   * moment when the song's intro was long enough, sooner when not); `null` without `--lyrics-at`,
   * or when the words could not be found (the note says why).
   */
  lyricsMs: number | null;
  fullMs: number;
  lufs: number;
  cutMs: number;
  title: string;
  artist: string;
  instagramLine: string;
  trending: Record<string, unknown> | null;
  reused: boolean;
  note: string | null;
}

export type MusicLine =
  | ({ ok: true; id: string; lengthMs: number | null } & Partial<Omit<SongOk, 'command'>> &
      Partial<Omit<SongNoteOk, 'command'>> & { command?: 'song' | 'song-note' })
  | { ok: false; code: string; message: string };

export function run(args: MusicArgs | SongArgs | SongNoteArgs): Promise<MusicLine>;
