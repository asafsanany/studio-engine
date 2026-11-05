// The fake runner's music (Soundtrack plan, "The engine"): with the music switch on, step 6 of a
// fake edit run makes v1 through the music script itself, the way a real edit run does: a plan in
// edit/music/plan.json that fits the cut, then `make --by edit --fake` (an ffmpeg tone, no network,
// no ElevenLabs). The job then comes back to Review with music v1 picked, edit/preview/music.mp3 in
// place and the composition playing it, so the whole Music flow can be tried without a key or a
// Claude run.
//
// With the Songs switch on (SG12) a brief that asks for a song gets it the way a real edit run gets
// it: the music script's `song` command, called with the options the prompt (music-songs.md) names,
// from edit/brief.json's music.song (a title and artist, a link) or music.wantsTrending. The command
// runs for real; what it gets the song with is the script's own test hooks, which the e2e engine
// points at stand-ins (MUSIC_GET_SONG, MUSIC_TRENDING_PICK, MUSIC_HYPERFRAMES in the engine's
// environment reach the script), so nothing touches the network or Apify. A song that cannot be got
// leaves its failure in music.json and the run makes v1 as before, as the prompt says. A brief that
// says "Original audio" (a picture named "original-…") has no song to get: the run makes v1, then
// notes it with the script's `song-note` command, as music-songs-sources.md says, so Review and the
// sheet ask for the reel's link.
//
// Music only when asked (U21): the fake edit follows the same rule as music.md. A brief whose
// `music.wanted` is true (or that asks for a song) gets music made, as above; any other brief gets no
// music: the plan for the cut, then the script's `none --plan` ("Music was not asked for."), which
// records no music with that plan and leaves silence at edit/preview/music.mp3 for the composition,
// so Make music in Review has a plan to make from and a version made there drops straight in.
//
// A revise run (RGM2) gets the song a note asks for the way the real one does (music-revise-songs.md):
// "Use [x] instead.", "Use the song from [link] instead." or "Use a trending song that fits the
// cut." in edit/review/round-N.md is one `song` call with `--from note --by you` (`--from trending
// --by you` for the trending one), after the round's cut is in place. A song that cannot be got
// leaves the music as it was (the script's own guarantee) and the run goes on.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  briefSchema,
  FIXED_NOTES_HEADING,
  formatMusicLength,
  MUSIC_FILES,
  MUSIC_LIMITS,
  MUSIC_NOT_ASKED_REASON,
  type MusicPlan,
  type MusicSection,
  musicRecordSchema,
  musicWasNotAsked,
} from '@studio/shared';
import { createMusicScriptRunner, type MusicScriptRunner } from './music-script.js';

/**
 * The stand-ins for the song getter, the trending pick and the beat finder (testdata/). tsc doesn't copy
 * testdata/ into dist/, and this path works from src/music/ (dev, tests) and from dist/music/ (the
 * built server, e2e) alike: both are two folders below apps/server/.
 */
const STANDINS_DIR = fileURLToPath(new URL('../../src/music/testdata/', import.meta.url));

/**
 * `env` for the music script of a fake run that gets a song: the script's own test hooks point at the
 * stand-ins unless the environment already names others, so a fake run never reaches YouTube or Apify
 * (a trending pick with a real key would spend money). The e2e engine sets the same three variables
 * itself (support/engine.ts).
 */
export function fakeSongEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...env,
    MUSIC_GET_SONG: env.MUSIC_GET_SONG || join(STANDINS_DIR, 'fake-e2e-songs.mjs'),
    MUSIC_TRENDING_PICK: env.MUSIC_TRENDING_PICK || join(STANDINS_DIR, 'fake-e2e-songs.mjs'),
    MUSIC_HYPERFRAMES: env.MUSIC_HYPERFRAMES || join(STANDINS_DIR, 'fake-e2e-hyperframes.mjs'),
  };
}

/** Where the Brief step leaves the brief, relative to the job's edit/ folder. */
const BRIEF_FILE = 'brief.json';

/** What the brief asks the music for, as the song command is called with it. */
export type FakeSongAsk =
  | {
      kind: 'song';
      title: string | null;
      artist: string | null;
      version: string | null;
      link: string | null;
      fromFile: string | null;
      /** Asked by a note of a Review round (`--from note --by you`), not by the brief. */
      inRound?: boolean;
    }
  | {
      kind: 'trending';
      /** Asked by a note of a Review round (`--by you`), not by the brief (`--by editor`). */
      inRound?: boolean;
    }
  /** The screenshot's label says "Original audio · [by]": no song to look up, only a note. */
  | { kind: 'original'; by: string };

/** The reels niche the fake passes when the client's style has no "Reels niche:" line. */
export const FAKE_SONG_NICHE = '#fpv #fpvdrone';

/**
 * The song edit/brief.json asks for, or `null` (no brief, or none asked). A song named wins over
 * "a trending song", and both over "Original audio" (which asks for no song, only a note), as in
 * the prompt.
 */
export async function readFakeSongAsk(editDir: string): Promise<FakeSongAsk | null> {
  let brief: ReturnType<typeof briefSchema.safeParse>;
  try {
    brief = briefSchema.safeParse(JSON.parse(await readFile(join(editDir, BRIEF_FILE), 'utf8')));
  } catch {
    return null;
  }
  const music = brief.success ? brief.data.music : null;
  if (music === null) return null;
  if (music.song !== null) return { kind: 'song', ...music.song };
  if (music.wantsTrending) return { kind: 'trending' };
  return music.original === null ? null : { kind: 'original', by: music.original.by };
}

/**
 * Whether edit/brief.json says the instructions ask for music to be made (`music.wanted`). `false`
 * for no brief, a brief that does not read, or one that asks for nothing: music is made only when
 * it is asked for.
 */
export async function readFakeMusicWanted(editDir: string): Promise<boolean> {
  try {
    const brief = briefSchema.safeParse(
      JSON.parse(await readFile(join(editDir, BRIEF_FILE), 'utf8')),
    );
    return brief.success && brief.data.music?.wanted === true;
  } catch {
    return false;
  }
}

/** Whether edit/music/music.json says music was not asked for (a run that made none left it so). */
export async function readFakeNotAsked(editDir: string): Promise<boolean> {
  try {
    const record = musicRecordSchema.safeParse(
      JSON.parse(await readFile(join(editDir, MUSIC_FILES.record), 'utf8')),
    );
    return record.success && musicWasNotAsked(record.data);
  } catch {
    return false;
  }
}

/** The song command's arguments for the ask, as music-songs.md writes the calls. */
export function fakeSongArgv(editDir: string, ask: FakeSongAsk): string[] {
  if (ask.kind === 'original') return ['song-note', editDir, '--original', ask.by];
  if (ask.kind === 'trending') {
    return [
      'song',
      editDir,
      '--trending',
      '--from',
      'trending',
      '--by',
      ask.inRound === true ? 'you' : 'editor',
      '--niche',
      FAKE_SONG_NICHE,
    ];
  }
  const argv = ['song', editDir];
  // A link alone is given alone, without a title and an artist.
  if (ask.title !== null) argv.push('--title', ask.title);
  if (ask.artist !== null) argv.push('--artist', ask.artist);
  if (ask.version !== null) argv.push('--version', ask.version);
  if (ask.link !== null) argv.push('--link', ask.link);
  const inRound = ask.inRound === true;
  const from = inRound
    ? 'note'
    : ask.fromFile !== null
      ? 'screenshot'
      : ask.title === null
        ? 'link'
        : 'name';
  argv.push('--from', from);
  if (ask.fromFile !== null) argv.push('--file', ask.fromFile);
  argv.push('--by', inRound ? 'you' : 'brief');
  return argv;
}

/** The note Pick a trending one adds in Review's Music list (music-text.ts's SONG_TEXT.trendingNote). */
const TRENDING_NOTE_TEXT = 'Use a trending song that fits the cut.';

/** A line of the round file: "- 0:07.0 — words" ("- 0:07.0 (on 1:1) — words" on a two-format job). */
const ROUND_NOTE_LINE = /^- \S+(?: \([^)]*\))? — (.+)$/;

/**
 * The songs the notes of a round ask for, in the order the notes are in the round file
 * (edit/review/round-N.md): one ask for each note that is word for word what Another song and Pick
 * a trending one add in Review ("Use [name] instead.", "Use the song from [link] instead." and "Use
 * a trending song that fits the cut."). A name that holds " by " is a title and an artist, split at
 * the last one ("Use Blinding Lights by The Weeknd instead."); one without is a title alone. The
 * notes already fixed in Review (their own heading) and every other note are not songs.
 */
export function songAsksOfRound(roundFile: string): FakeSongAsk[] {
  const open = roundFile.split(`\n## ${FIXED_NOTES_HEADING}`)[0] ?? '';
  const asks: FakeSongAsk[] = [];
  for (const line of open.split('\n')) {
    const body = ROUND_NOTE_LINE.exec(line)?.[1]?.trim();
    if (body === undefined) continue;
    if (body === TRENDING_NOTE_TEXT) {
      asks.push({ kind: 'trending', inRound: true });
      continue;
    }
    const link = /^Use the song from (\S+) instead\.$/.exec(body)?.[1];
    if (link !== undefined) {
      asks.push({
        kind: 'song',
        title: null,
        artist: null,
        version: null,
        link,
        fromFile: null,
        inRound: true,
      });
      continue;
    }
    const name = /^Use (.+) instead\.$/.exec(body)?.[1]?.trim();
    if (name === undefined || name === '') continue;
    // The greedy first group ends at the last " by ", so "Stand by Me by Ben E. King" splits right.
    const named = /^(.+) by (.+)$/iu.exec(name);
    asks.push({
      kind: 'song',
      title: named?.[1]?.trim() ?? name,
      artist: named?.[2]?.trim() ?? null,
      version: null,
      link: null,
      fromFile: null,
      inRound: true,
    });
  }
  return asks;
}

/** A plan for a cut of `lengthMs`: two sections (a build and a drop) once it is long enough, else one. */
export function fakeMusicPlan(lengthMs: number): MusicPlan {
  const total = Math.max(MUSIC_LIMITS.lengthMinMs, Math.round(lengthMs));
  const parts = Math.max(
    total >= 2 * MUSIC_LIMITS.sectionMinMs ? 2 : 1,
    Math.ceil(total / MUSIC_LIMITS.sectionMaxMs),
  );
  const each = Math.floor(total / parts);
  const sections: MusicSection[] = Array.from({ length: parts }, (_, index) => ({
    name: parts === 1 ? 'Tone' : index === parts - 1 ? 'Drop' : 'Build',
    ms: index === parts - 1 ? total - each * (parts - 1) : each,
    styles: ['fake tone'],
    avoid: [],
  }));
  return {
    lengthMs: total,
    styles: ['fake tone', 'instrumental'],
    avoid: ['vocals'],
    sections,
    describe: `A fake tone, ${formatMusicLength(total)} long, made without ElevenLabs.`,
  };
}

/** Writes edit/music/plan.json for a cut of `lengthMs` (in one move, so a reader never sees half of it). */
async function writeFakePlan(editDir: string, lengthMs: number): Promise<void> {
  await mkdir(join(editDir, MUSIC_FILES.dir), { recursive: true });
  const plan = join(editDir, MUSIC_FILES.plan);
  const temporary = `${plan}.tmp`;
  await writeFile(temporary, `${JSON.stringify(fakeMusicPlan(lengthMs), null, 2)}\n`);
  await rename(temporary, plan);
}

export interface MakeFakeMusicOptions {
  /** The job's edit/ folder. */
  editDir: string;
  /** The cut's length, in ms. */
  lengthMs: number;
  /** Stops the make (a cancel or a shutdown of the run). */
  signal?: AbortSignal;
  /**
   * What the brief asks of Songs: a song, got with the `song` command before any music is made, or
   * "Original audio", noted with `song-note` after the make.
   */
  song?: FakeSongAsk | null;
  /**
   * Runs the music script. Default: the real script, run in the OS temp folder; for a song, with its test
   * hooks pointing at the stand-ins (`fakeSongEnv`).
   */
  run?: MusicScriptRunner;
}

/**
 * Writes the plan, gets the song the brief asks for (with Songs on) and, when there is none or it
 * could not be got, makes music v1 with the script's fake path. A brief that says "Original audio"
 * makes v1 and then notes it (`song-note`), whatever the make did. Resolves `true` when music is in
 * place, `false` when it is not (stopped, or the script said no: the failure is in music.json and the
 * run goes on without music, like a real one).
 */
export async function makeFakeMusic({
  editDir,
  lengthMs,
  signal,
  song = null,
  run = createMusicScriptRunner(song === null ? {} : { env: fakeSongEnv() }),
}: MakeFakeMusicOptions): Promise<boolean> {
  await writeFakePlan(editDir, lengthMs);
  if (song !== null && song.kind !== 'original') {
    // The command takes minutes for a real song; the stand-ins answer at once.
    const got = await run({ argv: fakeSongArgv(editDir, song), signal, timeoutMs: 120_000 });
    if (got.kind === 'ran' && got.line?.ok === true) return true;
    if (signal?.aborted) return false;
  }
  const outcome = await run({
    argv: ['make', editDir, '--by', 'edit', '--fake'],
    signal,
    timeoutMs: 60_000,
  });
  if (song?.kind === 'original' && signal?.aborted !== true) {
    await run({ argv: fakeSongArgv(editDir, song), signal, timeoutMs: 60_000 });
  }
  return outcome.kind === 'ran' && outcome.line?.ok === true;
}

export interface MakeFakeNoMusicOptions {
  /** The job's edit/ folder. */
  editDir: string;
  /** The cut's length, in ms. */
  lengthMs: number;
  /** Stops the call (a cancel or a shutdown of the run). */
  signal?: AbortSignal;
  /** Runs the music script. Default: the real script, run in the OS temp folder. */
  run?: MusicScriptRunner;
}

/**
 * Music was not asked for (U21): writes edit/music/plan.json for the cut and runs the script's
 * `none --plan` with the reason the app tells apart. Nothing is made. Resolves `true` when the
 * record is written, `false` when it is not (stopped, or the script said no).
 */
export async function makeFakeNoMusic({
  editDir,
  lengthMs,
  signal,
  run = createMusicScriptRunner(),
}: MakeFakeNoMusicOptions): Promise<boolean> {
  await writeFakePlan(editDir, lengthMs);
  const outcome = await run({
    argv: ['none', editDir, MUSIC_NOT_ASKED_REASON, '--plan'],
    signal,
    timeoutMs: 60_000,
  });
  return outcome.kind === 'ran' && outcome.line?.ok === true;
}

export interface GetFakeRoundSongsOptions {
  /** The job's edit/ folder. */
  editDir: string;
  /** The length of the round's cut, in ms. */
  lengthMs: number;
  /** What the round's notes ask for (`songAsksOfRound`), one `song` call each, in order. */
  asks: readonly FakeSongAsk[];
  /** Stops the calls (a cancel or a shutdown of the run). */
  signal?: AbortSignal;
  /** Runs the music script. Default: the real script, its test hooks pointing at the stand-ins (`fakeSongEnv`). */
  run?: MusicScriptRunner;
}

/**
 * The revise run's songs (music-revise-songs.md): once the round's cut is in place, plan.json says
 * its length (a plan is written when there is none, or when it was for another length), then one
 * `song` call for each note that asks for a song. A call that fails leaves the music as it was (the
 * script records the failure and changes nothing else), so the next note, and the run, go on.
 * Resolves with how many songs were got.
 */
export async function getFakeRoundSongs({
  editDir,
  lengthMs,
  asks,
  signal,
  run = createMusicScriptRunner({ env: fakeSongEnv() }),
}: GetFakeRoundSongsOptions): Promise<number> {
  const songs = asks.filter((ask) => ask.kind !== 'original');
  if (songs.length === 0) return 0;
  if ((await planLengthOf(editDir)) !== fakeMusicPlan(lengthMs).lengthMs) {
    await writeFakePlan(editDir, lengthMs);
  }
  let got = 0;
  for (const ask of songs) {
    if (signal?.aborted) break;
    // The command takes minutes for a real song; the stand-ins answer at once.
    const outcome = await run({ argv: fakeSongArgv(editDir, ask), signal, timeoutMs: 120_000 });
    if (outcome.kind === 'ran' && outcome.line?.ok === true) got += 1;
  }
  return got;
}

/** The length plan.json says the cut is, or `null` when there is no plan (or none that reads). */
async function planLengthOf(editDir: string): Promise<number | null> {
  try {
    const plan = JSON.parse(await readFile(join(editDir, MUSIC_FILES.plan), 'utf8')) as {
      lengthMs?: unknown;
    };
    return typeof plan.lengthMs === 'number' ? plan.lengthMs : null;
  } catch {
    return null;
  }
}
