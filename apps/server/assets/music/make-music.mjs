#!/usr/bin/env node
// The music script (Soundtrack plan, "The music script"). One implementation, two callers: the edit
// run calls it from Bash, and the engine spawns it for Make another and Pick. It is the only writer
// of a job's edit/music/ and edit/preview/music.mp3.
//
//   node make-music.mjs make     "<edit dir>" [--again] [--ask "<words>"] [--by edit|revise|you]
//   node make-music.mjs pick     "<edit dir>" <v1|off|file|series|song>
//   node make-music.mjs supplied "<edit dir>" "<file in the job folder>"
//   node make-music.mjs series   "<edit dir>" "<kit audio file>"
//   node make-music.mjs none     "<edit dir>" "<reason>" [--plan]
//   node make-music.mjs song     "<edit dir>" (--title T --artist A [--version V] | --link URL |
//                                --trending [--niche "#a #b"]) [--from screenshot|link|name|note|
//                                trending] [--file F] [--by brief|you|editor] [--length-ms N]
//   node make-music.mjs song-note "<edit dir>" --original "<account>"
//
// make     reads edit/music/plan.json (with --again and no plan.json, the record's plan), makes
//          the next vN with a new seed, picks it (copies it to edit/preview/music.mp3) and records
//          it, with the plan it used. --ask makes it with the owner's words; the version's line says
//          "You asked: …".
// pick     copies vN to edit/preview/music.mp3, or writes silence of the same length for off;
//          file and series put the folder's or the series' music back after off, and song puts the
//          song's part (edit/music/song.mp3, once a `song` call recorded it) back.
// supplied / series / none only record where the music came from (supplied and series also copy
//          the file to edit/preview/music.mp3). Relative paths are taken from the job folder (the
//          edit dir's parent), and the file must be inside it.
// none --plan (U21: music is made only when the job asks for it; "Music was not asked for.") also
//          keeps edit/music/plan.json's plan in the record and puts silence of its length at
//          edit/preview/music.mp3 (picked stays null: No music), so Make music in Review has a plan
//          to make from, and the composition has its music.mp3 for a version made later to drop
//          into, exactly as after a make that failed. Nothing is made and no credit is spent. A
//          missing or bad plan.json is a bad_plan failure and the record stays as it was.
// song     (Songs, SG3; behind the `songs` switch: with it off nothing calls it) gets the song asked
//          for (by title and artist, by a reel or video link, or a trending one for the niche),
//          finds the part of it the video uses, cuts that part to edit/music/song.mp3 at -20 LUFS,
//          keeps the whole download as song-full.m4a (and a reel's own audio as song-reel.m4a),
//          picks it (edit/preview/music.mp3 is a copy) and records `song` in music.json, with a
//          plan (plan.json's, or a plain one) so Make music instead still works. --from says how it
//          was asked for, --file the screenshot, --by who asked. The cut's length is plan.json's
//          lengthMs (the edit run writes it first), else --length-ms. A repeat call for the song
//          already picked cuts a new part from the kept song-full.m4a (no new download).
//          --lyrics-at <ms> says the song's words should start that far into the cut (the brief
//          wants the song to open on its own intro and sing when the picture says so): Scribe finds
//          the song's first word and the part is cut to start that long before it, so the song's
//          own intro is the lead-in and music.mp3 plays from the cut's first frame. The line's
//          `lyricsMs` is where the first word is heard in the part (the asked ms, or sooner when
//          the song's intro is shorter), `dropMs` is then null, and `part.startMs` is not on a
//          downbeat. When the words cannot be found (no key, no network, an instrumental) the
//          part is the one found by loudness, `lyricsMs` is null and the note says why.
//          --start-ms <ms> starts the part exactly that far into the song (the brief names a moment
//          of the song: "start the song at 0:37"); nothing is listened for or measured to choose
//          it, `dropMs` is null and `part.startMs` is the ms asked. It slides earlier, and the note
//          says so, only when the song ends before a whole part fits after it. It cannot be given
//          with --lyrics-at.
//          Prints {"ok":true,"command":"song","id":"song","lengthMs":<the part's>,"part":{"startMs",
//          "endMs","how","beatCount":<how many beats the finder found in the part; 0 for none>},
//          "beats":[ms from the part's start],"downbeats":[…],"bpm","dropMs":<where the drop is
//          heard, ms from the part's start, or null: the first strong bass (30 to 150 Hz) onset just
//          after the part's sharpest loudness step, else that step>,"lyricsMs":<where the first
//          word is heard, ms from the part's start, with --lyrics-at; else null>,"fullMs","lufs","cutMs","title",
//          "artist","instagramLine","trending","trendingEvent":<for a trending pick, the
//          `music.song.trending` event: niche, how many songs it looked at, the pick; else null>,
//          "note":<one sentence when the part is not the cut's whole length, no beats were found
//          or the trending pick fits the cut badly, else null>}. part.how is `measured`, or
//          `whole` when the song is shorter than the cut (or only the reel's audio was had).
//          When it cannot get the song it records `songFailure`, leaves the earlier pick and
//          preview as they were and prints {"ok":false,"code":<a song failure code>,"message":"…"}.
//          Tools: STUDIO_YT_DLP and STUDIO_DENO (absolute paths, from the engine), ffmpeg, and
//          `npx hyperframes audio` for the beats; the Apify key is read by the getter from .env
//          (get-song.mjs) and is never printed. For tests: MUSIC_GET_SONG (a module with getSong),
//          MUSIC_TRENDING_PICK (a module with pickTrending), MUSIC_HYPERFRAMES (a program that
//          answers `audio <file> … --json`), MUSIC_SPEECH (a module with firstSungWordMs).
//
// song-note (Songs, RGM1; behind the `songs` switch) records that the screenshot's audio label said
//          "Original audio · <account>": there is no song to look up (no song, no guess), so it only
//          writes `songFailure { asked: "Original audio · <account>", code: "original_audio",
//          message, at }` into music.json, next to the music the edit run made, and changes nothing
//          else (the pick, the versions and edit/preview/music.mp3 stay as they are). That record is
//          what Review's Music list and the job sheet draw "No song name on the screenshot" from.
//          --original is the account as the brief has it (music.original.by); "" is no account.
//          A record that already has a song (one got from the reel's link, say) is left alone.
//          Prints {"ok":true,"command":"song-note","id":<the pick, or "none">,"lengthMs":null,
//          "asked":"…","recorded":<false for a record that has a song>} and exits 0.
//
// Output: one JSON line on stdout, {"ok":true,"id":"v2","lengthMs":39000} or
// {"ok":false,"code":"no_credits","message":"…"}; exit 0, 2 (ElevenLabs said no: credits, access,
// key; for song: needs_key, tool_missing, original_audio), 3 (down, timeout; for song: unavailable,
// blocked) or 1 (anything else). A make that fails also writes the failure into
// music.json, and when nothing is made or picked yet, the plan and silence of its length as
// edit/preview/music.mp3 (picked stays null), so the composition always has its music.mp3 and a
// version made later drops straight in. Every write holds edit/music/.lock, so one job never has
// two calls at once. The shapes are the shared contract's (packages/shared/src/domain/music.ts):
// MusicPlan, MusicRecord and the script's line; the tests check what this writes against them.
//
// ElevenLabs (SD1, the spike's findings in ~/.studio-engine/qa/soundtrack-sd1/notes.md):
// - make composes with music_v2_5 from the plan's sections as chunks of exact length, always
//   instrumental (vocals, singing and lyrics are negative styles; a chunk's text is only its
//   "[name]", since other text can be sung). Every chunk after the first has context_adherence
//   "low": with the default the music's changes drift seconds from the section boundaries.
// - --ask asks the free /v1/music/plan to restyle our plan ("<styles>. Change: <words>") with our
//   plan as its source, then keeps our names, lengths, adherence and avoid.
// - Every version is normalised to -20 LUFS integrated with one linear gain (measured first,
//   capped so the true peak stays at or under -2 dBTP), so swapping versions keeps the mix and a
//   drop keeps its punch, and is trimmed or padded to exactly the plan's length.
// - The key is read from ~/Developer/video-use/.env and then the environment; it is only ever sent
//   in the request's header: never printed, never in argv, and taken out of every message.
// - 120 s per compose (30 s per plan call) and one retry on a 5xx, a 429 or a network error (not
//   on a timeout).
// The fake path (--fake, or MUSIC_FAKE=1) makes an ffmpeg tone of the plan's length instead, with
// no network. For tests: MUSIC_API_BASE (the stub server), MUSIC_TIMEOUT_MS, MUSIC_RETRY_MS.
//
// Plain Node, no dependencies: it runs from the engine's assets/ folder in src and dist alike.

import { spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBeats } from './song-beats.mjs';
import {
  choosePart,
  clip,
  energyEnvelope,
  instagramLine,
  LOW_BAND_FILTER,
  PART,
  partAroundFirstWord,
  partFromStart,
  peakAt,
  readWavInfo,
} from './song-part.mjs';
import { WORDS } from './song-words.mjs';

/** The music files, relative to the edit dir (MUSIC_FILES in the shared contract). */
export const FILES = {
  dir: 'music',
  plan: 'music/plan.json',
  record: 'music/music.json',
  lock: 'music/.lock',
  preview: 'preview/music.mp3',
  songFull: 'music/song-full.m4a',
  songReel: 'music/song-reel.m4a',
  song: 'music/song.mp3',
};

/** MUSIC_LIMITS in the shared contract. */
export const LIMITS = {
  sectionMinMs: 3_000,
  sectionMaxMs: 120_000,
  lengthMinMs: 3_000,
  lengthMaxMs: 600_000,
  describeMax: 160,
  versionDescribeMax: 400,
  askMax: 200,
};

/** MUSIC_EXIT_CODES in the shared contract. */
export const EXIT = { ok: 0, failed: 1, refused: 2, down: 3 };

/** Where ElevenLabs' key is read from first: video-use's .env (then ELEVENLABS_API_KEY). */
export const KEY_FILE = join(homedir(), 'Developer', 'video-use', '.env');

/** ElevenLabs' API and how this script calls it (the spike's picks). */
export const ELEVENLABS = {
  base: 'https://api.elevenlabs.io',
  model: 'music_v2_5',
  /** 192 kb/s is allowed on the Starter plan. */
  outputFormat: 'mp3_44100_192',
  bitrate: '192k',
  sampleRate: 44_100,
  composeTimeoutMs: 120_000,
  planTimeoutMs: 30_000,
  retryMs: 1_500,
};

/** What every version is normalised to. */
export const LOUDNESS = { integratedLufs: -20, truePeakDbtp: -2 };

/** Styles every make avoids, whatever the plan says: the music is always instrumental. */
export const ALWAYS_AVOID = ['vocals', 'singing', 'lyrics'];

const COMMANDS = ['make', 'pick', 'supplied', 'series', 'none', 'song', 'song-note'];
const MAKERS = ['edit', 'revise', 'you'];
const VERSION_ID = /^v[1-9]\d*$/;
/** What pick takes besides a version: No music, the folder's or the series' music again, and the song. */
const PICKS = ['off', 'file', 'series', 'song'];

const USAGE = [
  'Usage:',
  '  node make-music.mjs make     "<edit dir>" [--again] [--ask "<words>"] [--by edit|revise|you]',
  '  node make-music.mjs pick     "<edit dir>" <v1|off|file|series|song>',
  '  node make-music.mjs supplied "<edit dir>" "<file in the job folder>"',
  '  node make-music.mjs series   "<edit dir>" "<kit audio file>"',
  '  node make-music.mjs none     "<edit dir>" "<reason>" [--plan]',
  '  node make-music.mjs song     "<edit dir>" (--title T --artist A [--version V] | --link URL |',
  '                               --trending [--niche "#a #b"]) [--from screenshot|link|name|note|trending]',
  '                               [--file F] [--by brief|you|editor] [--length-ms N] [--lyrics-at MS | --start-ms MS]',
  '  node make-music.mjs song-note "<edit dir>" --original "<account>"',
].join('\n');

/** A failure with its code (MUSIC_FAILURE_CODES): what the line says and what the exit code is. */
export class MusicError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MusicError';
    this.code = code;
  }
}

/** The exit code of a failure code (musicExitCode in the shared contract). */
export function exitCodeFor(code) {
  if (
    code === 'no_credits' ||
    code === 'no_access' ||
    code === 'no_key' ||
    code === 'needs_key' ||
    code === 'tool_missing' ||
    code === 'original_audio'
  ) {
    return EXIT.refused;
  }
  if (code === 'down' || code === 'unavailable' || code === 'blocked') return EXIT.down;
  return EXIT.failed;
}

/** Keys this process has read: `redact` takes each of them out, whatever they look like. */
const secrets = new Set();

/**
 * Text with the key taken out: the key this process read (as it is), anything that looks like an
 * ElevenLabs key (sk_…), and the value of an xi-api-key header.
 */
export function redact(text) {
  let out = String(text);
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[key]');
  return out
    .replace(/sk_[A-Za-z0-9_-]+/g, 'sk_…')
    .replace(/(xi-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[key]');
}

/** One variable's value in a .env text (the doctor's parseDotenv rules), or `null`. */
function dotenvValue(text, name) {
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

/**
 * ElevenLabs' key: ELEVENLABS_API_KEY in `file` (video-use's .env), then in the environment, or
 * `null` when there is none. The key is remembered so `redact` can take it out of any message.
 */
export function readKey(env = process.env, file = KEY_FILE) {
  let key = '';
  try {
    key = (dotenvValue(readFileSync(file, 'utf8'), 'ELEVENLABS_API_KEY') ?? '').trim();
  } catch {
    // No .env: the environment's, if any.
  }
  if (key === '' && typeof env.ELEVENLABS_API_KEY === 'string') key = env.ELEVENLABS_API_KEY.trim();
  if (key === '') return null;
  secrets.add(key);
  return key;
}

// --- arguments -----------------------------------------------------------------------------------

/** The options of `song` (and `--original`, which is `song-note`'s) that take a value, and the key each one is read into. */
const SONG_VALUE_OPTIONS = {
  '--title': 'title',
  '--artist': 'artist',
  '--version': 'version',
  '--link': 'link',
  '--from': 'from',
  '--file': 'file',
  '--niche': 'niche',
  '--length-ms': 'lengthMs',
  '--lyrics-at': 'lyricsAt',
  '--start-ms': 'startMs',
  '--original': 'original',
};

/** SONG_VERSIONS, SONG_ASKED_FROM, SONG_ASKED_BY in the shared contract. */
export const SONG_VERSIONS = ['original', 'sped up', 'slowed', 'remix'];
export const SONG_ASKED_FROM = ['screenshot', 'link', 'name', 'note', 'trending'];
export const SONG_ASKED_BY = ['brief', 'you', 'editor'];

/** SONG_LIMITS in the shared contract. */
export const SONG_LIMITS = {
  titleMax: 120,
  artistMax: 120,
  instagramLineMax: 240,
  partMinMs: 3_000,
  partMaxMs: 120_000,
};

/** What `--lyrics-at` takes: the words start at least this far into the cut. */
const LYRICS_AT = { minMs: 500 };

/** What `--start-ms` takes: a moment of the song, up to an hour in. */
const START_AT = { maxMs: 3_600_000 };

/** The `song` call from its options, or `{ error }`. */
function parseSong(editDir, options, { by, trending, fake }) {
  const text = (value) => {
    const one = typeof value === 'string' ? value.trim() : '';
    return one === '' ? null : one;
  };
  const title = text(options.title);
  const artist = text(options.artist);
  const version = text(options.version);
  const link = text(options.link);
  const file = text(options.file);
  const niche = text(options.niche);
  if (options.original !== undefined) {
    return { error: `--original is for song-note only.\n${USAGE}` };
  }
  if (version !== null && !SONG_VERSIONS.includes(version)) {
    return { error: `--version is ${SONG_VERSIONS.join(', ')}, not "${version}".\n${USAGE}` };
  }
  if (trending) {
    if (title !== null || artist !== null || link !== null || version !== null) {
      return {
        error: `--trending takes no --title, --artist, --version or --link: the editor picks the song.\n${USAGE}`,
      };
    }
  } else if (title === null && link === null) {
    return { error: `song needs --title (with --artist), --link or --trending.\n${USAGE}` };
  } else if (title === null && artist !== null) {
    return { error: `--artist needs the song's --title.\n${USAGE}` };
  }
  const from = trending ? 'trending' : (text(options.from) ?? (title === null ? 'link' : 'name'));
  if (!SONG_ASKED_FROM.includes(from)) {
    return { error: `--from is ${SONG_ASKED_FROM.join(', ')}, not "${from}".\n${USAGE}` };
  }
  const askedBy = by ?? (trending ? 'editor' : 'brief');
  if (!SONG_ASKED_BY.includes(askedBy)) {
    return { error: `--by is ${SONG_ASKED_BY.join(', ')} for song, not "${askedBy}".\n${USAGE}` };
  }
  let lengthMs = null;
  if (options.lengthMs !== undefined) {
    lengthMs = /^\d+$/.test(options.lengthMs.trim()) ? Number(options.lengthMs.trim()) : Number.NaN;
    if (!(lengthMs >= LIMITS.lengthMinMs && lengthMs <= LIMITS.lengthMaxMs)) {
      return {
        error: `--length-ms is the cut's length in whole ms, ${LIMITS.lengthMinMs} to ${LIMITS.lengthMaxMs}.`,
      };
    }
  }
  let lyricsAtMs = null;
  if (options.lyricsAt !== undefined) {
    lyricsAtMs = /^\d+$/.test(options.lyricsAt.trim())
      ? Number(options.lyricsAt.trim())
      : Number.NaN;
    if (!(lyricsAtMs >= LYRICS_AT.minMs && lyricsAtMs <= LIMITS.lengthMaxMs)) {
      return {
        error: `--lyrics-at is the moment of the cut where the words start, in whole ms, ${LYRICS_AT.minMs} to ${LIMITS.lengthMaxMs}.`,
      };
    }
  }
  let startMs = null;
  if (options.startMs !== undefined) {
    startMs = /^\d+$/.test(options.startMs.trim()) ? Number(options.startMs.trim()) : Number.NaN;
    if (!(startMs >= 0 && startMs <= START_AT.maxMs)) {
      return {
        error: `--start-ms is the moment of the song where the part starts, in whole ms, 0 to ${START_AT.maxMs}.`,
      };
    }
    if (lyricsAtMs !== null) {
      return {
        error: `--start-ms and --lyrics-at both say which part of the song plays: give one.\n${USAGE}`,
      };
    }
  }
  return {
    command: 'song',
    editDir,
    again: false,
    ask: null,
    by: askedBy,
    fake,
    target: null,
    title,
    artist,
    version,
    link,
    trending,
    niche,
    from,
    file,
    lengthMs,
    lyricsAtMs,
    startMs,
  };
}

/**
 * The `song-note` call (RGM1) from its options, or `{ error }`: `--original` and nothing else. The
 * account is trimmed; blank is no account (`null`).
 */
function parseSongNote(editDir, options, { by, trending, again, ask, rest, fake }) {
  if (again || ask !== null || by !== null || trending) {
    return { error: `song-note takes only --original.\n${USAGE}` };
  }
  if (rest.length > 0) return { error: `song-note takes no more than the edit dir.\n${USAGE}` };
  const others = Object.keys(options).filter((key) => key !== 'original');
  if (others.length > 0) return { error: `song-note takes only --original.\n${USAGE}` };
  if (options.original === undefined) {
    return {
      error: `song-note needs --original "<account>" ("" when the label names none).\n${USAGE}`,
    };
  }
  const account = options.original.trim();
  return {
    command: 'song-note',
    editDir,
    again: false,
    ask: null,
    by: 'brief',
    fake,
    target: null,
    original: account === '' ? null : account,
  };
}

/**
 * The call as `{ command, editDir, again, ask, by, fake, target }`, or `{ error }` with the line to
 * print. `target` is the pick (`v2`, `off`), the file (supplied, series) or the reason (none). A
 * `song` call also has `{ title, artist, version, link, trending, niche, from, file, lengthMs,
 * lyricsAtMs, startMs }` (each `null` or `false` when not given) and its `by` is brief, you or editor. A `song-note` call
 * also has `{ original }`: the account under the "Original audio" label, or `null`.
 */
export function parseArgs(argv, env = {}) {
  const positional = [];
  let again = false;
  let ask = null;
  let by = null;
  let fake = env.MUSIC_FAKE === '1';
  let trending = false;
  let plan = false;
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--again') again = true;
    else if (arg === '--fake') fake = true;
    else if (arg === '--trending') trending = true;
    else if (arg === '--plan') plan = true;
    else if (arg === '--ask' || arg === '--by' || arg in SONG_VALUE_OPTIONS) {
      const value = argv[i + 1];
      if (value === undefined) return { error: `${arg} needs a value.\n${USAGE}` };
      i++;
      if (arg === '--ask') ask = value.trim();
      else if (arg === '--by') by = value;
      else options[SONG_VALUE_OPTIONS[arg]] = value;
    } else if (arg.startsWith('--')) {
      return { error: `There is no option ${arg}.\n${USAGE}` };
    } else {
      positional.push(arg);
    }
  }
  const [command, editDir, ...rest] = positional;
  if (command === undefined || !COMMANDS.includes(command)) return { error: USAGE };
  if (editDir === undefined || editDir === '')
    return { error: `${command} needs the edit dir.\n${USAGE}` };
  if (plan && command !== 'none') return { error: `--plan is for none only.\n${USAGE}` };
  if (command === 'song') {
    if (again || ask !== null) return { error: `--again and --ask are for make only.\n${USAGE}` };
    if (rest.length > 0) return { error: `song takes no more than the edit dir.\n${USAGE}` };
    return parseSong(resolve(editDir), options, { by, trending, fake });
  }
  if (command === 'song-note') {
    return parseSongNote(resolve(editDir), options, { by, trending, again, ask, rest, fake });
  }
  if (trending || Object.keys(options).length > 0) {
    return {
      error: `--title, --artist, --version, --link, --trending, --niche, --from, --file, --length-ms, --lyrics-at and --start-ms are for song only, and --original is for song-note only.\n${USAGE}`,
    };
  }
  if (command !== 'make' && (again || ask !== null || (by !== null && by !== 'edit'))) {
    return { error: `--again, --ask and --by are for make only.\n${USAGE}` };
  }
  by ??= 'edit';
  if (!MAKERS.includes(by)) return { error: `--by is edit, revise or you, not "${by}".\n${USAGE}` };
  if (ask !== null && (ask === '' || ask.length > LIMITS.askMax)) {
    return { error: `--ask takes 1 to ${LIMITS.askMax} characters of words.` };
  }
  let target = null;
  if (command === 'make') {
    if (rest.length > 0) return { error: `make takes no more than the edit dir.\n${USAGE}` };
  } else if (command === 'none') {
    target = rest.join(' ').trim();
    if (target === '')
      return { error: `none needs the reason: whose rule says no music.\n${USAGE}` };
  } else {
    if (rest.length !== 1 || rest[0] === '')
      return { error: `${command} needs one more argument.\n${USAGE}` };
    target = rest[0];
    if (command === 'pick' && !PICKS.includes(target) && !VERSION_ID.test(target)) {
      return {
        error: `pick takes a version (v1, v2 …), off, file, series or song, not "${target}".`,
      };
    }
  }
  return { command, editDir: resolve(editDir), again, ask, by, fake, target, plan };
}

// --- the plan ------------------------------------------------------------------------------------

const isWholeMs = (value) => Number.isInteger(value);
const isStyles = (value) =>
  Array.isArray(value) && value.every((style) => typeof style === 'string' && style !== '');

/** What is wrong with a plan (musicPlanSchema in the shared contract), or `null`. */
export function planProblem(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan))
    return 'it is not a JSON object';
  const { lengthMs, styles, avoid, sections, describe } = plan;
  if (!isWholeMs(lengthMs) || lengthMs < LIMITS.lengthMinMs || lengthMs > LIMITS.lengthMaxMs) {
    return `lengthMs must be whole ms from ${LIMITS.lengthMinMs} to ${LIMITS.lengthMaxMs}, not ${JSON.stringify(lengthMs)}`;
  }
  if (!isStyles(styles) || styles.length === 0) return 'styles must be a list of one or more words';
  if (!isStyles(avoid)) return 'avoid must be a list of words (it can be empty)';
  if (!Array.isArray(sections) || sections.length === 0)
    return 'sections must be a list of one or more sections';
  let sum = 0;
  for (const [index, section] of sections.entries()) {
    const where = `sections[${index}]`;
    if (section === null || typeof section !== 'object' || Array.isArray(section))
      return `${where} is not an object`;
    if (typeof section.name !== 'string' || section.name === '')
      return `${where}.name must be a name`;
    if (
      !isWholeMs(section.ms) ||
      section.ms < LIMITS.sectionMinMs ||
      section.ms > LIMITS.sectionMaxMs
    ) {
      return `${where}.ms must be whole ms from ${LIMITS.sectionMinMs} to ${LIMITS.sectionMaxMs}, not ${JSON.stringify(section.ms)}`;
    }
    if (!isStyles(section.styles))
      return `${where}.styles must be a list of words (it can be empty)`;
    if (!isStyles(section.avoid)) return `${where}.avoid must be a list of words (it can be empty)`;
    sum += section.ms;
  }
  if (sum !== lengthMs) return `the sections add up to ${sum} ms, not lengthMs (${lengthMs} ms)`;
  if (typeof describe !== 'string' || describe === '' || describe.length > LIMITS.describeMax) {
    return `describe must be one line of 1 to ${LIMITS.describeMax} characters`;
  }
  return null;
}

/** The plan's own fields, and nothing else (unknown keys are dropped, as the schema does). */
function cleanPlan(plan) {
  return {
    lengthMs: plan.lengthMs,
    styles: [...plan.styles],
    avoid: [...plan.avoid],
    sections: plan.sections.map(({ name, ms, styles, avoid }) => ({
      name,
      ms,
      styles: [...styles],
      avoid: [...avoid],
    })),
    describe: plan.describe,
  };
}

/** edit/music/plan.json, checked. */
function readPlan(editDir) {
  const path = join(editDir, FILES.plan);
  if (!existsSync(path)) {
    throw new MusicError(
      'bad_plan',
      `There is no ${FILES.plan} in the edit dir: write the plan first.`,
    );
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new MusicError('bad_plan', `${FILES.plan} is not valid JSON (${err.message}).`);
  }
  const problem = planProblem(plan);
  if (problem !== null) throw new MusicError('bad_plan', `${FILES.plan} does not fit: ${problem}.`);
  return cleanPlan(plan);
}

// --- the record ----------------------------------------------------------------------------------

/** A record with nothing in it yet (emptyMusicRecord in the shared contract). */
export function emptyRecord() {
  return {
    v: 1,
    source: 'made',
    reason: null,
    file: null,
    plan: null,
    picked: null,
    versions: [],
    picks: [],
    making: null,
    failure: null,
    song: null,
    songFailure: null,
  };
}

/** The id the next make gets: one past the highest version (nextVersionId in the shared contract). */
export function nextVersionId(record) {
  let highest = 0;
  for (const version of record?.versions ?? []) {
    if (VERSION_ID.test(version.id)) highest = Math.max(highest, Number(version.id.slice(1)));
  }
  return `v${highest + 1}`;
}

/** edit/music/music.json, or `null` when there is none yet. */
function readRecord(editDir) {
  const path = join(editDir, FILES.record);
  if (!existsSync(path)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new MusicError('failed', `${FILES.record} cannot be read (${err.message}).`);
  }
  if (
    record === null ||
    typeof record !== 'object' ||
    record.v !== 1 ||
    !Array.isArray(record.versions)
  ) {
    throw new MusicError('failed', `${FILES.record} is not a music record this script knows.`);
  }
  return record;
}

/** Writes `text` to `path` through a dot-named temp file and a rename, so no reader sees half. */
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, data);
  renameSync(temp, path);
}

function writeRecord(editDir, record) {
  writeAtomic(join(editDir, FILES.record), `${JSON.stringify(record, null, 2)}\n`);
}

/** Copies a file with a fresh modified time (the page's `rev` follows edit/preview/music.mp3's). */
function copyAtomic(from, to) {
  writeAtomic(to, readFileSync(from));
}

// --- the lock ------------------------------------------------------------------------------------

/** Whether the lock's holder is gone (it died, or the file is unreadable). */
function lockIsStale(path) {
  let holder;
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return err.code !== 'EACCES';
  }
  if (!Number.isInteger(holder?.pid)) return true;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/** Takes edit/music/.lock (a lock left by a process that is gone is taken over); returns its release. */
function takeLock(editDir) {
  const path = join(editDir, FILES.lock);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!lockIsStale(path)) break;
      rmSync(path, { force: true });
    }
  }
  throw new MusicError(
    'failed',
    'Music is already being made or picked for this job. Try again when that is done.',
  );
}

// --- audio ---------------------------------------------------------------------------------------

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** ffmpeg or ffprobe: MUSIC_FFMPEG / MUSIC_FFPROBE, then PATH, then Homebrew's folders. */
export function findTool(name, env = process.env) {
  const override = env[`MUSIC_${name.toUpperCase()}`];
  if (override) return override;
  const dirs = [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (dir !== '' && isExecutable(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Seconds as ffmpeg takes them: at most 3 decimals. */
function seconds(ms) {
  return String(Math.round(ms) / 1000);
}

/** Runs ffmpeg; throws a MusicError with the end of what it said when it fails. */
function ffmpeg(args) {
  const bin = findTool('ffmpeg');
  if (bin === null)
    throw new MusicError('failed', 'ffmpeg is not installed (brew install ffmpeg).');
  const result = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const said = `${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
    throw new MusicError('failed', redact(`ffmpeg failed${said ? `: ${said}` : ''}.`));
  }
}

/** Writes an mp3 at `path` from ffmpeg's `input` arguments, through a temp file and a rename. */
function writeMp3(path, input, bitrate = '128k', sampleRate = 44_100) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path, '.mp3')}.${process.pid}.tmp.mp3`);
  try {
    ffmpeg([
      ...input,
      '-ac',
      '2',
      '-ar',
      String(sampleRate),
      '-c:a',
      'libmp3lame',
      '-b:a',
      bitrate,
      temp,
    ]);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * A file's integrated loudness (LUFS) and true peak (dBTP), from ffmpeg's loudnorm measuring pass
 * (after the filters `filters` names, when given: a part of a song is measured as it will sound).
 * Silence measures as -Infinity.
 */
function measureLoudness(path, filters = null) {
  const bin = findTool('ffmpeg');
  if (bin === null)
    throw new MusicError('failed', 'ffmpeg is not installed (brew install ffmpeg).');
  const { integratedLufs, truePeakDbtp } = LOUDNESS;
  const result = spawnSync(
    bin,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      path,
      '-af',
      `${filters === null ? '' : `${filters},`}loudnorm=I=${integratedLufs}:TP=${truePeakDbtp}:LRA=20:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(`${result.stderr ?? ''}`)?.[0];
  if (result.status !== 0 || json === undefined) {
    throw new MusicError('failed', 'ffmpeg could not measure the music’s loudness.');
  }
  const measured = JSON.parse(json);
  return {
    integrated: Number.parseFloat(measured.input_i),
    truePeak: Number.parseFloat(measured.input_tp),
  };
}

/**
 * The one gain (dB) that brings music measured at `integrated` LUFS to the target, cut back when
 * it would push the true peak over the ceiling. Linear: the music's own dynamics stay.
 */
export function loudnessGain(integrated, truePeak, ceiling = LOUDNESS.truePeakDbtp) {
  let gain = LOUDNESS.integratedLufs - integrated;
  if (Number.isFinite(truePeak) && truePeak + gain > ceiling) {
    gain = ceiling - truePeak;
  }
  return Math.round(gain * 100) / 100;
}

/**
 * Makes ElevenLabs' answer a version: normalised to the target loudness, exactly `lengthMs` long
 * (trimmed, or padded with silence; a 20 ms fade at the end so a trim never clicks), 192 kb/s.
 * Answers the length it measures in the file it wrote.
 */
function finishVersion(raw, out, lengthMs) {
  const { integrated, truePeak } = measureLoudness(raw);
  if (!Number.isFinite(integrated) || integrated < -70) {
    throw new MusicError('failed', 'ElevenLabs sent back silence instead of music.');
  }
  const samples = Math.round((lengthMs * ELEVENLABS.sampleRate) / 1000);
  const filters = [
    `aresample=${ELEVENLABS.sampleRate}`,
    `volume=${loudnessGain(integrated, truePeak)}dB`,
    `apad=whole_len=${samples}`,
    `atrim=end_sample=${samples}`,
    `afade=t=out:st=${seconds(lengthMs - 20)}:d=0.02`,
  ];
  writeMp3(out, ['-i', raw, '-af', filters.join(',')], ELEVENLABS.bitrate);
  return probeLengthMs(out) ?? lengthMs;
}

/** The fake path's music: a tone of `lengthMs`, a different note for every version. */
export function toneFrequency(id) {
  const notes = [440, 523.25, 659.25, 587.33, 493.88];
  const n = VERSION_ID.test(id) ? Number(id.slice(1)) : 1;
  return notes[(n - 1) % notes.length];
}

function writeTone(path, lengthMs, frequency) {
  writeMp3(path, [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds(lengthMs)}`,
  ]);
}

/** No music: silence of `lengthMs`, so the composition's music lane keeps its length. */
function writeSilence(path, lengthMs) {
  writeMp3(path, [
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t',
    seconds(lengthMs),
  ]);
}

/** A file's length in ms, or `null` when ffprobe cannot read it (or is missing). */
function probeLengthMs(path) {
  const bin = findTool('ffprobe');
  if (bin === null) return null;
  const result = spawnSync(
    bin,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const sec = Number.parseFloat(`${result.stdout ?? ''}`.trim());
  return result.status === 0 && Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null;
}

/** Puts a music file at edit/preview/music.mp3: copied when it is an mp3, else made one. */
function placePreview(editDir, file) {
  const to = join(editDir, FILES.preview);
  if (extname(file).toLowerCase() === '.mp3') copyAtomic(file, to);
  else writeMp3(to, ['-i', file, '-vn']);
}

// --- ElevenLabs ----------------------------------------------------------------------------------

const KEY_PLACE = '~/Developer/video-use/.env';
const KEYS_PAGE = 'https://elevenlabs.io/app/settings/api-keys';

/** At most this many characters of what ElevenLabs said go into a message. */
const SAID_MAX = 200;

function said(text) {
  const one = redact(String(text)).replace(/\s+/g, ' ').trim();
  return one.length > SAID_MAX ? `${one.slice(0, SAID_MAX - 1)}…` : one;
}

/**
 * What ElevenLabs' refusal means, as `{ code, message, retry }`: the failure code (the shared
 * contract's), one plain sentence for the owner, and whether one more try may help. It reads the body's
 * detail.type / code / status, not only the HTTP status: a wrong key is a 400, and older answers
 * say "quota_exceeded" with a 401.
 */
export function failureFor(status, body) {
  const detail = body !== null && typeof body === 'object' ? body.detail : undefined;
  const fields =
    detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
  const names = [fields.type, fields.code, fields.status]
    .filter((name) => typeof name === 'string')
    .map((name) => name.toLowerCase());
  const is = (...wanted) => wanted.some((name) => names.includes(name));
  const message =
    typeof fields.message === 'string'
      ? fields.message
      : typeof detail === 'string'
        ? detail
        : typeof body === 'string'
          ? body
          : '';

  if (status === 402 || is('payment_required', 'insufficient_credits', 'quota_exceeded')) {
    return {
      code: 'no_credits',
      message: 'ElevenLabs says this month’s credits are used up.',
      retry: false,
    };
  }
  if (
    is('invalid_api_key', 'missing_api_key', 'needs_authorization', 'invalid_authorization_header')
  ) {
    return {
      code: 'no_access',
      message: `ElevenLabs doesn’t accept the key in ${KEY_PLACE}: it says the key is invalid.`,
      retry: false,
    };
  }
  if (is('missing_permissions', 'insufficient_permissions')) {
    return {
      code: 'no_access',
      message: `The ElevenLabs key can’t make music: give it the Music permission at ${KEYS_PAGE}.`,
      retry: false,
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    is('authentication_error', 'authorization_error', 'unauthorized', 'forbidden')
  ) {
    return {
      code: 'no_access',
      message: `ElevenLabs won’t make music with this key${message ? ` (it says: ${said(message)})` : ` (it answered ${status})`}.`,
      retry: false,
    };
  }
  if (
    status === 429 ||
    is('rate_limit_error', 'rate_limit_exceeded', 'concurrent_limit_exceeded', 'system_busy')
  ) {
    return {
      code: 'down',
      message: 'ElevenLabs is busy right now. Try again in a minute.',
      retry: true,
    };
  }
  if (status >= 500) {
    return {
      code: 'down',
      message: `ElevenLabs is having trouble right now (it answered ${status}). Try again in a few minutes.`,
      retry: true,
    };
  }
  if (is('bad_composition_plan', 'bad_prompt')) {
    return {
      code: 'bad_plan',
      message:
        'ElevenLabs refused the plan’s styles: they name an artist or a song. Describe the sound instead.',
      retry: false,
    };
  }
  if (status === 400 || status === 422) {
    const first = Array.isArray(detail) ? detail[0] : null;
    const where = Array.isArray(first?.loc)
      ? first.loc.filter((part) => part !== 'body').join('.')
      : '';
    const what = typeof first?.msg === 'string' ? first.msg : message;
    return {
      code: 'bad_plan',
      message: `ElevenLabs can’t use this plan${what ? `: ${said(what)}` : ''}${where ? ` (at ${said(where)})` : ''}.`,
      retry: false,
    };
  }
  return {
    code: 'failed',
    message: `ElevenLabs answered ${status}${message ? `: ${said(message)}` : ''}.`,
    retry: false,
  };
}

function wholeMs(value, fallback) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : fallback;
}

function howLong(ms) {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${Math.round(ms / 100) / 10} seconds`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * POSTs `body` as JSON to ElevenLabs (MUSIC_API_BASE for the tests), with the key in its header
 * only. Answers the body's bytes on a 2xx; throws a MusicError for anything else. One more try on
 * a 5xx, a 429 or a network error; none on a timeout (it has waited long enough).
 */
async function callElevenLabs(path, body, { key, env, timeoutMs, accept }) {
  const base = (env.MUSIC_API_BASE || ELEVENLABS.base).replace(/\/+$/, '');
  const waitMs = wholeMs(env.MUSIC_TIMEOUT_MS, timeoutMs);
  const retryMs = wholeMs(env.MUSIC_RETRY_MS, ELEVENLABS.retryMs);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(waitMs),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: the text is what it said.
      }
      const failure = failureFor(res.status, parsed);
      if (failure.retry && attempt === 1) {
        await sleep(retryMs);
        continue;
      }
      throw new MusicError(failure.code, failure.message);
    } catch (err) {
      if (err instanceof MusicError) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new MusicError('down', `ElevenLabs didn’t answer within ${howLong(waitMs)}.`);
      }
      if (attempt === 1) {
        await sleep(retryMs);
        continue;
      }
      throw new MusicError('down', 'ElevenLabs can’t be reached. Is the Mac online?');
    }
  }
}

function requireKey(env) {
  const key = readKey(env);
  if (key === null) {
    throw new MusicError(
      'no_key',
      `There is no ElevenLabs key: put it after ELEVENLABS_API_KEY= in ${KEY_PLACE}.`,
    );
  }
  return key;
}

// --- the plan as ElevenLabs reads it -------------------------------------------------------------

/** Styles as a clean list: strings only, trimmed, no blanks, no repeats (any case), at most 20. */
function styleList(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const style = value.trim().slice(0, 200);
    if (style === '' || seen.has(style.toLowerCase())) continue;
    seen.add(style.toLowerCase());
    out.push(style);
    if (out.length === 20) break;
  }
  return out;
}

/** A section's name as a chunk's "[name]": no brackets or braces (they mean something), ≤ 100. */
function chunkName(name, index) {
  const clean = String(name)
    .replace(/[[\]{}\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return clean === '' ? `Part ${index + 1}` : clean;
}

/**
 * Our plan as music_v2_5's composition plan: one chunk per section, of exactly its length. The
 * first chunk sets the tone (the plan's styles and its own, always instrumental); the later ones
 * carry their own styles (the plan's when they have none) and start fresh on their boundary
 * (context_adherence low). Every chunk avoids vocals, singing and lyrics, the plan's avoid and its
 * own. The text is only "[name]": anything else can be sung.
 */
export function toComposition(plan) {
  const avoid = styleList([...plan.avoid, ...ALWAYS_AVOID]);
  return {
    chunks: plan.sections.map((section, index) => {
      let positive;
      if (index === 0) {
        positive = styleList([...plan.styles, ...section.styles]);
        if (!positive.some((style) => /instrumental/i.test(style))) {
          positive = [...positive.slice(0, 19), 'instrumental'];
        }
      } else {
        positive = styleList(section.styles.length > 0 ? section.styles : plan.styles);
      }
      const chunk = {
        text: `[${chunkName(section.name, index)}]`,
        duration_ms: section.ms,
        positive_styles: positive,
        negative_styles: styleList([...avoid, ...section.avoid]),
      };
      if (index > 0) chunk.context_adherence = 'low';
      return chunk;
    }),
  };
}

/**
 * Our plan restyled by /v1/music/plan's answer: its styles per section (the first chunk's are the
 * new tone), and our names, lengths and avoid (with what it adds to avoid). When the answer does
 * not have our shape, the words become one more style of the plan instead.
 */
export function restyledPlan(plan, ask, answer) {
  const chunks = Array.isArray(answer?.chunks) ? answer.chunks : null;
  const fits =
    chunks !== null &&
    chunks.length === plan.sections.length &&
    chunks.every((chunk) => styleList(chunk?.positive_styles).length > 0);
  if (!fits) return { ...plan, styles: styleList([...plan.styles, ask]) };
  return {
    ...plan,
    styles: styleList(chunks[0].positive_styles),
    sections: plan.sections.map((section, index) => ({
      name: section.name,
      ms: section.ms,
      styles: index === 0 ? [] : styleList(chunks[index].positive_styles),
      avoid: styleList([...section.avoid, ...styleList(chunks[index].negative_styles)]),
    })),
  };
}

// --- making --------------------------------------------------------------------------------------

/**
 * The plan to make a version with the owner's words. ElevenLabs' free /v1/music/plan restyles our plan
 * ("<plan styles>. Change: <words>", with our plan as its source); our sections and lengths stay
 * (restyledPlan). The fake path keeps the plan as it is.
 */
export async function restyle(plan, ask, { fake, env = process.env }) {
  if (fake) return plan;
  const key = requireKey(env);
  const answer = await callElevenLabs(
    '/v1/music/plan',
    {
      prompt: `${plan.styles.join(', ')}. Change: ${ask}. Keep every section and its length.`,
      music_length_ms: plan.lengthMs,
      model_id: ELEVENLABS.model,
      source_composition_plan: toComposition(plan),
    },
    { key, env, timeoutMs: ELEVENLABS.planTimeoutMs, accept: 'application/json' },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(answer.toString('utf8'));
  } catch {
    // Not a plan: restyledPlan falls back to the words as a style.
  }
  return restyledPlan(plan, ask, parsed);
}

/**
 * Makes one version's mp3 at `out` from `plan`, and says which model made it and how long the file
 * is. Real: ElevenLabs composes the plan (music_v2_5, the seed, 192 kb/s), then finishVersion
 * normalises it and makes it exactly the plan's length. Fake: an ffmpeg tone of the plan's length.
 */
export async function compose({ plan, id, seed, out, fake, env = process.env }) {
  if (fake) {
    writeTone(out, plan.lengthMs, toneFrequency(id));
    return { model: 'fake', lengthMs: plan.lengthMs };
  }
  const key = requireKey(env);
  const audio = await callElevenLabs(
    `/v1/music?output_format=${ELEVENLABS.outputFormat}`,
    { composition_plan: toComposition(plan), model_id: ELEVENLABS.model, seed },
    { key, env, timeoutMs: ELEVENLABS.composeTimeoutMs, accept: 'audio/mpeg' },
  );
  if (audio.length < 1_024) throw new MusicError('failed', 'ElevenLabs sent back no music.');
  const raw = join(dirname(out), `.${id}.${process.pid}.raw.mp3`);
  try {
    writeFileSync(raw, audio);
    const lengthMs = finishVersion(raw, out, plan.lengthMs);
    return { model: ELEVENLABS.model, lengthMs };
  } finally {
    rmSync(raw, { force: true });
  }
}

/** A version's line: the plan's, or "You asked: <words>. Same shape: <the plan's>". */
export function versionDescribe(plan, ask) {
  const text = ask === null ? plan.describe : `You asked: ${ask}. Same shape: ${plan.describe}`;
  return text.length > LIMITS.versionDescribeMax
    ? `${text.slice(0, LIMITS.versionDescribeMax - 1)}…`
    : text;
}

const now = () => new Date().toISOString();

/** Records a pick: what edit/preview/music.mp3 is now. */
function recordPick(record, id) {
  record.picked = id;
  record.picks = [...(record.picks ?? []), { id, at: now() }];
}

/**
 * The plan a make uses: edit/music/plan.json (the run keeps it current, e.g. a revise that changed
 * the cut), or with --again and no plan.json, the record's.
 */
function planForMake(editDir, record, again) {
  if (!again || existsSync(join(editDir, FILES.plan))) return readPlan(editDir);
  const problem =
    record.plan == null
      ? 'there is no plan.json and no plan in the record yet'
      : planProblem(record.plan);
  if (problem !== null) throw new MusicError('bad_plan', `Cannot make it again: ${problem}.`);
  return cleanPlan(record.plan);
}

async function make({ editDir, again, ask, by, fake }) {
  const record = readRecord(editDir) ?? emptyRecord();
  const id = nextVersionId(record);
  let plan = null;
  try {
    plan = planForMake(editDir, record, again);
    record.plan = plan;
    record.making = { id, ask, startedAt: now() };
    writeRecord(editDir, record);

    // 0 … 2^31 - 1, ElevenLabs' range; a new one for every version.
    const seed = randomInt(0, 2 ** 31);
    const styled = ask === null ? plan : await restyle(plan, ask, { fake });
    const file = `${id}.mp3`;
    const made = await compose({
      plan: styled,
      id,
      seed,
      out: join(editDir, FILES.dir, file),
      fake,
    });
    record.versions = [
      ...record.versions,
      {
        id,
        file,
        describe: versionDescribe(plan, ask),
        ask,
        seed,
        model: made.model,
        lengthMs: made.lengthMs,
        by,
        madeAt: now(),
      },
    ];
    record.source = 'made';
    record.reason = null;
    record.file = null;
    record.plan = plan;
    copyAtomic(join(editDir, FILES.dir, file), join(editDir, FILES.preview));
    recordPick(record, id);
    record.making = null;
    record.failure = null;
    writeRecord(editDir, record);
    return { ok: true, id, lengthMs: made.lengthMs };
  } catch (err) {
    const failure = asMusicError(err);
    record.making = null;
    record.failure = { id, code: failure.code, message: redact(failure.message), at: now() };
    // Nothing made or picked yet: the composition still gets its music.mp3, silence of the plan's
    // length, so a version made later drops straight in and `pick off` has a length. Picked
    // stays null: the sheet says the music couldn't be made, not that it is off.
    if (plan !== null && record.versions.length === 0 && record.picked == null) {
      try {
        writeSilence(join(editDir, FILES.preview), plan.lengthMs);
      } catch {
        // The failure being recorded matters more than the silence.
      }
    }
    writeRecord(editDir, record);
    throw failure;
  }
}

/** The length of the song's part in ms (`song.part`), 0 for a record without a song. */
function songPartMs(record) {
  const part = record.song?.part;
  return part == null ? 0 : part.endMs - part.startMs;
}

function pick({ editDir, target }) {
  const record = readRecord(editDir);
  if (record === null) {
    throw new MusicError('failed', `There is no ${FILES.record} yet: make the music first.`);
  }
  let lengthMs;
  if (target === 'off') {
    // Silence as long as the music it replaces: the folder's or the series' file when the job
    // brought one, else the plan (or the longest version, or the song's part when that is all
    // there is).
    const brought =
      (record.source === 'supplied' || record.source === 'series') && record.file != null;
    lengthMs = brought
      ? (probeLengthMs(jobFile(editDir, record.file).path) ?? 0)
      : (record.plan?.lengthMs ??
        Math.max(
          0,
          songPartMs(record),
          ...record.versions.map((version) => version.lengthMs ?? 0),
        ));
    if (!(lengthMs > 0)) throw new MusicError('failed', 'There is no music to turn off yet.');
    writeSilence(join(editDir, FILES.preview), lengthMs);
  } else if (target === 'file' || target === 'series') {
    // The music the job folder or the series brought, back after No music.
    const brought = target === 'file' ? 'supplied' : 'series';
    if (record.source !== brought || record.file == null) {
      throw new MusicError(
        'failed',
        target === 'file'
          ? 'There is no music file from the job folder to pick.'
          : 'There is no series music to pick.',
      );
    }
    placePreview(editDir, jobFile(editDir, record.file).path);
    lengthMs = probeLengthMs(join(editDir, FILES.preview));
  } else if (target === 'song') {
    // The song that was got for the video (Songs): its part, cut by the `song` call.
    const songFile = join(editDir, FILES.song);
    if (record.song == null || !existsSync(songFile)) {
      throw new MusicError('failed', 'There is no song to pick.');
    }
    copyAtomic(songFile, join(editDir, FILES.preview));
    lengthMs = songPartMs(record);
  } else {
    const version = record.versions.find((each) => each.id === target);
    if (version === undefined) {
      const known = record.versions.map((each) => each.id).join(', ') || 'none yet';
      throw new MusicError('failed', `There is no ${target} (the versions: ${known}).`);
    }
    copyAtomic(join(editDir, FILES.dir, version.file), join(editDir, FILES.preview));
    lengthMs = version.lengthMs;
  }
  recordPick(record, target);
  record.making = null;
  writeRecord(editDir, record);
  return { ok: true, id: target, lengthMs };
}

/** The file of supplied or series: inside the job folder (the edit dir's parent), as given there. */
function jobFile(editDir, given) {
  const jobDir = dirname(editDir);
  const path = isAbsolute(given) ? given : resolve(jobDir, given);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new MusicError('failed', `There is no file "${given}" in the job folder.`);
  }
  const inside = relative(realpathSync(jobDir), realpathSync(path));
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new MusicError('failed', `"${given}" is not in the job folder.`);
  }
  return { path, name: inside.split(sep).join('/') };
}

function fromFile({ editDir, target, command }) {
  const file = jobFile(editDir, target);
  placePreview(editDir, file.path);
  const record = readRecord(editDir) ?? emptyRecord();
  record.source = command === 'supplied' ? 'supplied' : 'series';
  record.reason = null;
  record.file = file.name;
  const id = command === 'supplied' ? 'file' : 'series';
  recordPick(record, id);
  record.making = null;
  writeRecord(editDir, record);
  return { ok: true, id, lengthMs: probeLengthMs(join(editDir, FILES.preview)) };
}

function none({ editDir, target, plan }) {
  // --plan: the plan is checked first, so a bad one leaves the record as it was.
  const kept = plan ? readPlan(editDir) : null;
  const record = readRecord(editDir) ?? emptyRecord();
  record.source = 'none';
  record.reason = target;
  record.file = null;
  record.picked = null;
  record.making = null;
  if (kept !== null) {
    // Silence of the plan's length: the composition keeps its music.mp3 and `pick off` has a length.
    writeSilence(join(editDir, FILES.preview), kept.lengthMs);
    record.plan = kept;
  }
  writeRecord(editDir, record);
  return { ok: true, id: 'none', lengthMs: kept === null ? null : kept.lengthMs };
}

// --- songs ---------------------------------------------------------------------------------------

/** SONG_FAILURE_CODES in the shared contract. */
export const SONG_FAILURE_CODES = [
  'not_found',
  'unavailable',
  'blocked',
  'update_needed',
  'tool_missing',
  'needs_key',
  'original_audio',
  'no_trending',
  'failed',
];

/**
 * What a part of a song is normalised to: the versions' loudness with a true-peak ceiling of -1
 * (the one linear gain, measured on the part as it will sound).
 */
export const SONG_LOUDNESS = { integratedLufs: LOUDNESS.integratedLufs, truePeakDbtp: -1 };

/** How the part is cut and how long the beat finder gets. */
export const SONG_CUT = { fadeInMs: 30, fadeOutMs: 1_000, hyperframesTimeoutMs: 180_000 };

/** What was asked for, in a few words the owner recognises (songFailure.asked). */
function askedText(args) {
  if (args.trending) return 'a trending song';
  if (args.title !== null)
    return args.artist === null ? args.title : `${args.title} by ${args.artist}`;
  return args.link ?? 'a song';
}

/** A failure as a MusicError with a song failure code and a message with no key in it. */
function asSongFailure(err) {
  const code = SONG_FAILURE_CODES.includes(err?.code) ? err.code : 'failed';
  const raw = redact(err instanceof Error ? err.message : String(err)).trim();
  return new MusicError(code, raw === '' ? 'The song could not be got.' : raw);
}

/** The module `env[name]` points at (tests), else the one next to this script. */
async function loadModule(env, name, file) {
  const override = env[name];
  const url = override ? pathToFileURL(resolve(override)) : new URL(file, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    // Not there (yet): `null`. A module that is there but broken is a failure.
    const missing =
      err?.code === 'ERR_MODULE_NOT_FOUND' &&
      String(err.message).includes(basename(fileURLToPath(url)));
    if (missing) return null;
    throw err;
  }
}

/** The getter (get-song.mjs), with the Apify key (if there is one) taken out of every message. */
async function loadGetter(env) {
  const mod = await loadModule(env, 'MUSIC_GET_SONG', './get-song.mjs');
  if (mod === null || typeof mod.getSong !== 'function') {
    throw new MusicError('failed', 'The song getter (get-song.mjs) is missing.');
  }
  try {
    const token = typeof mod.readApifyToken === 'function' ? mod.readApifyToken(env) : null;
    if (typeof token === 'string' && token !== '') secrets.add(token);
  } catch {
    // The getter reads the key itself; this only helps `redact`.
  }
  return mod;
}

/**
 * The cut's length in ms: plan.json's lengthMs (the edit run writes it before the song command, and
 * a revise that changes the cut updates it), else `--length-ms`.
 */
function cutLength(editDir, given) {
  let fromPlan = null;
  const path = join(editDir, FILES.plan);
  if (existsSync(path)) {
    try {
      const ms = JSON.parse(readFileSync(path, 'utf8'))?.lengthMs;
      if (isWholeMs(ms) && ms >= LIMITS.lengthMinMs && ms <= LIMITS.lengthMaxMs) fromPlan = ms;
    } catch {
      // Not a plan: --length-ms, if there is one.
    }
  }
  const ms = fromPlan ?? given;
  if (ms === null) {
    throw new MusicError(
      'failed',
      `There is no cut length for the song: write edit/${FILES.plan} (its lengthMs is the cut's length in ms) before the song command, or pass --length-ms.`,
    );
  }
  return ms;
}

/** The plan for a song-only record: a plain one of the cut's length, in sections of at most 2 minutes. */
export function plainPlan(lengthMs) {
  const count = Math.ceil(lengthMs / LIMITS.sectionMaxMs);
  const each = Math.floor(lengthMs / count);
  const extra = lengthMs - each * count;
  return {
    lengthMs,
    styles: ['instrumental background music'],
    avoid: [],
    sections: Array.from({ length: count }, (_, i) => ({
      name: count === 1 ? 'Music' : `Music ${i + 1}`,
      ms: each + (i < extra ? 1 : 0),
      styles: [],
      avoid: [],
    })),
    describe: 'Music that fits the video, made instead of the song.',
  };
}

/** The plan the record keeps with a song: plan.json's when the edit wrote a good one, else a plain one. */
function planForSong(editDir, record, cutMs) {
  const path = join(editDir, FILES.plan);
  if (existsSync(path)) {
    try {
      const plan = JSON.parse(readFileSync(path, 'utf8'));
      if (planProblem(plan) === null) return cleanPlan(plan);
    } catch {
      // Not a plan: the record's, or a plain one.
    }
  }
  if (record.plan != null && planProblem(record.plan) === null && record.plan.lengthMs === cutMs) {
    return cleanPlan(record.plan);
  }
  return plainPlan(cutMs);
}

/** The tempo and the drop the plan promises, for the trending pick's fit check. */
function planShape(editDir) {
  try {
    const plan = JSON.parse(readFileSync(join(editDir, FILES.plan), 'utf8'));
    if (planProblem(plan) !== null) return { bpm: null, dropMs: null };
    const bpm = /(\d{2,3})\s*bpm/i.exec([...plan.styles, plan.describe].join(' '));
    let at = 0;
    let dropMs = null;
    for (const section of plan.sections) {
      if (dropMs === null && /drop|chorus|hook/i.test(section.name)) dropMs = at;
      at += section.ms;
    }
    return { bpm: bpm === null ? null : Number(bpm[1]), dropMs };
  } catch {
    return { bpm: null, dropMs: null };
  }
}

/** The "Reels niche:" line of the job's frozen style or its client's _Style, as "#a #b @c", or `null`. */
function readNiche(editDir) {
  const files = [
    join(editDir, 'style', 'style.md'),
    join(dirname(dirname(editDir)), '_Style', 'style.md'),
  ];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const line = /reels niche\W*[:：]\s*([^\n]+)/i.exec(text)?.[1];
    const tags = (line?.match(/[#@][\p{L}\p{N}_.]*[\p{L}\p{N}_]/gu) ?? []).slice(0, 12);
    if (tags.length > 0) return tags.join(' ');
  }
  return null;
}

/** The client's id as the engine makes it (clientIdFor): 12 hex of sha1 of the folder's NFC name. */
function clientIdOf(name) {
  return createHash('sha1').update(name.normalize('NFC'), 'utf8').digest('hex').slice(0, 12);
}

/**
 * The song the editor picks for "a trending song": ./trending-pick.mjs (SG10) asks Instagram's own
 * numbers for the client's niche. Answers { title, artist, link, trending, note, event }: the song
 * to get by name, its numbers for song.trending, a sentence for the line when it fits the cut badly
 * and the `music.song.trending` event. A module that is missing (tests) answers `no_trending`.
 */
async function trendingPick(args, { env, editDir, cutMs, home }) {
  const mod = await loadModule(env, 'MUSIC_TRENDING_PICK', './trending-pick.mjs');
  if (mod === null || typeof mod.pickTrending !== 'function') {
    throw new MusicError('no_trending', "Trending picks aren't built yet.");
  }
  const niche = readNiche(editDir) ?? args.niche;
  const client = basename(dirname(dirname(editDir)));
  const { bpm, dropMs } = planShape(editDir);
  const dataDir = join(home, '.studio-engine');
  const pick = await mod.pickTrending({
    clientId: clientIdOf(client),
    client,
    niche,
    lengthMs: cutMs,
    cutBpm: bpm,
    dropMs,
    env,
    dataDir,
    cacheDir: join(dataDir, 'songs-cache'),
  });
  const named = typeof pick?.title === 'string' && pick.title.trim() !== '';
  const linked = typeof pick?.link === 'string' && pick.link.trim() !== '';
  if (!named && !linked) {
    throw new MusicError('no_trending', 'Instagram’s numbers gave no song that fits.');
  }
  return {
    title: named ? pick.title.trim() : null,
    artist:
      typeof pick.artist === 'string' && pick.artist.trim() !== '' ? pick.artist.trim() : null,
    link: linked ? pick.link.trim() : null,
    trending: pick.trending != null && typeof pick.trending === 'object' ? pick.trending : null,
    note: typeof pick.note === 'string' && pick.note.trim() !== '' ? pick.note.trim() : null,
    event: pick.event != null && typeof pick.event === 'object' ? pick.event : null,
  };
}

const fold = (text) => String(text).normalize('NFC').trim().toLowerCase();

/** Whether the request is for the song the record already has (so its kept download is the song). */
function isKeptSong(editDir, record, request) {
  const kept = record.song;
  if (kept == null || !existsSync(join(editDir, FILES.songFull))) return false;
  const byLink =
    request.link !== null &&
    (request.link === kept.asked?.url || request.link === kept.source?.url);
  const byName =
    request.title !== null &&
    fold(request.title) === fold(kept.title) &&
    (request.artist === null || fold(request.artist) === fold(kept.artist));
  const version = request.version === null || request.version === kept.version;
  return (byLink || byName) && version;
}

// --- the song's audio ----------------------------------------------------------------------------

let soxr = null;

/** aresample to `rate`, with soxr when this ffmpeg has it. */
function resampleTo(rate) {
  if (soxr === null) {
    const bin = findTool('ffmpeg');
    const probe =
      bin === null
        ? null
        : spawnSync(
            bin,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-nostdin',
              '-f',
              'lavfi',
              '-i',
              'anullsrc=r=44100:cl=stereo',
              '-t',
              '0.05',
              '-af',
              `aresample=${rate}:resampler=soxr`,
              '-f',
              'null',
              '-',
            ],
            { timeout: 15_000 },
          );
    soxr = probe !== null && probe.status === 0;
  }
  return soxr ? `aresample=${rate}:resampler=soxr` : `aresample=${rate}`;
}

/** m:ss for messages. */
function clock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Cuts `frames` of the WAV from `startFrame` to an mp3 at `out`: a 30 ms fade in unless the start is
 * silent, a 1 s fade out, one linear gain to the target (measured on the part as it sounds, with the
 * fades), encoded once. Answers the loudness of the mp3 it wrote.
 */
function cutPart({ wav, info, startFrame, frames, out }) {
  const peak = peakAt(wav, info, startFrame, Math.round((info.rate * SONG_CUT.fadeInMs) / 1000));
  const lengthSec = frames / info.rate;
  const chain = [
    `atrim=start_sample=${startFrame}:end_sample=${startFrame + frames}`,
    'asetpts=N/SR/TB',
    ...(peak > PART.silentPeak ? [`afade=t=in:st=0:d=${SONG_CUT.fadeInMs / 1000}`] : []),
    `afade=t=out:st=${Math.max(0, lengthSec - SONG_CUT.fadeOutMs / 1000)}:d=${Math.min(lengthSec, SONG_CUT.fadeOutMs / 1000)}`,
  ].join(',');
  const { integrated, truePeak } = measureLoudness(wav, chain);
  if (!Number.isFinite(integrated) || integrated < -70) {
    throw new MusicError('failed', 'The part of the song is silent.');
  }
  const gain = loudnessGain(integrated, truePeak, SONG_LOUDNESS.truePeakDbtp);
  writeMp3(out, ['-i', wav, '-af', `${chain},volume=${gain}dB`], ELEVENLABS.bitrate, info.rate);
  return Math.round(measureLoudness(out).integrated * 10) / 10;
}

/**
 * The energy envelope of the song's low band (30 to 150 Hz), from a second, tiny decode of the song's
 * WAV (`LOW_BAND_FILTER`): the drop is where the bass comes in. `null` when that decode fails: the
 * song is then used without it and `dropMs` stays at the loudness step.
 */
function lowBandEnvelope(wav, work) {
  const low = join(work, 'song-low.wav');
  try {
    ffmpeg([
      '-i',
      wav,
      '-vn',
      '-ac',
      '2',
      '-af',
      LOW_BAND_FILTER,
      '-c:a',
      'pcm_f32le',
      '-f',
      'wav',
      low,
    ]);
    return energyEnvelope(low, readWavInfo(low), PART.lowHopMs);
  } catch {
    return null;
  } finally {
    rmSync(low, { force: true });
  }
}

// --- the song command ----------------------------------------------------------------------------

/**
 * Where the song's first word starts, as `{ ms, why }` (ms from the song's start; `ms: null` and
 * why not when it cannot be found): Scribe listens to the first two minutes of the decoded `wav`,
 * cut to a small mp3 in `work`. Never throws: the part is then found by loudness instead.
 */
async function listenForFirstWord({ wav, work, env }) {
  try {
    const mod = await loadModule(env, 'MUSIC_SPEECH', './song-words.mjs');
    if (mod === null || typeof mod.firstSungWordMs !== 'function') {
      return { ms: null, why: 'the word finder (song-words.mjs) is missing' };
    }
    const file = join(work, 'song-start.mp3');
    writeMp3(file, ['-i', wav, '-t', String(WORDS.listenMs / 1000)], '64k', 16_000);
    return await mod.firstSungWordMs({
      file,
      key: readKey(env),
      base: env.MUSIC_API_BASE || undefined,
      timeoutMs: wholeMs(env.MUSIC_TIMEOUT_MS, WORDS.timeoutMs),
    });
  } catch (err) {
    return { ms: null, why: redact(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * Gets the song, finds its part, cuts it, and answers the line to print. Everything is made in
 * `work` first: nothing of the job changes until the part is cut.
 */
async function makeSong(args, { env, record, work }) {
  const { editDir } = args;
  const home = env.HOME || homedir();
  if (findTool('ffmpeg', env) === null) {
    throw new MusicError('tool_missing', 'ffmpeg is not installed (brew install ffmpeg).');
  }
  const cutMs = cutLength(editDir, args.lengthMs);

  // Which song: the one named or linked, or the editor's trending pick.
  let request = {
    title: args.title,
    artist: args.artist,
    version: args.version,
    link: args.link,
  };
  let trending = null;
  let pickNote = null;
  let trendingEvent = null;
  if (args.trending) {
    const pick = await trendingPick(args, { env, editDir, cutMs, home });
    request = {
      title: pick.title,
      artist: pick.artist,
      version: null,
      link: pick.title === null ? pick.link : null,
    };
    trending = pick.trending;
    pickNote = pick.note;
    trendingEvent = pick.event;
  }

  // Got now, or kept from the earlier call for this song (a re-cut for a new length needs no download).
  const kept = !args.trending && isKeptSong(editDir, record, request);
  let fullFile;
  let got = null;
  if (kept) {
    fullFile = join(editDir, FILES.songFull);
  } else {
    const getter = await loadGetter(env);
    got = await getter.getSong({
      title: request.title,
      artist: request.artist,
      version: request.version,
      link: request.link,
      workDir: work,
      tools: {
        ...(env.STUDIO_YT_DLP ? { ytDlp: env.STUDIO_YT_DLP } : {}),
        ...(env.STUDIO_DENO ? { deno: env.STUDIO_DENO } : {}),
      },
      env,
      cacheDir: join(home, '.studio-engine', 'songs-cache'),
    });
    fullFile = got.full;
  }
  const who = kept
    ? `${record.song.title} by ${record.song.artist}`
    : `${got.meta.title} by ${got.meta.artist}`;

  // Decode once; measure what is in it.
  const wav = join(work, 'song.wav');
  ffmpeg([
    '-i',
    fullFile,
    '-vn',
    '-ac',
    '2',
    '-af',
    resampleTo(PART.sampleRate),
    '-c:a',
    'pcm_f32le',
    '-f',
    'wav',
    wav,
  ]);
  const info = readWavInfo(wav);
  const durationMs = (info.frames * 1000) / info.rate;
  if (durationMs < LIMITS.sectionMinMs) {
    throw new MusicError(
      'failed',
      `${who} is only ${Math.round(durationMs / 100) / 10} seconds long: too short to use.`,
    );
  }
  const envelope = energyEnvelope(wav, info);
  const lowEnvelope = lowBandEnvelope(wav, work);
  const beats = await findBeats(wav, env, work, {
    findTool,
    timeoutMs: SONG_CUT.hyperframesTimeoutMs,
  });
  const asIs = got !== null && got.reel !== null && got.full === got.reel;
  // With --lyrics-at the part is cut around the song's first word (so the song's own intro leads in
  // to it); without it, or when the word cannot be found, on the song's drop.
  let lyricsNote = null;
  let around = null;
  let firstWordAt = null;
  if (args.lyricsAtMs !== null) {
    if (asIs) {
      lyricsNote = 'Only the reel’s own audio could be had, so its words start where it starts.';
    } else {
      const heard = await listenForFirstWord({ wav, work, env });
      if (heard.ms === null) {
        lyricsNote = `Could not find where the words start (${heard.why}), so the part is the one found by loudness.`;
      } else {
        firstWordAt = heard.ms;
        around = partAroundFirstWord({
          durationMs,
          cutMs,
          firstMs: heard.ms,
          lyricsAtMs: args.lyricsAtMs,
        });
        if (around === null) {
          lyricsNote = `The song is no longer than the cut, so its words cannot be placed at ${seconds(args.lyricsAtMs)} s.`;
        }
      }
    }
  }
  // With --start-ms the part starts at that moment of the song: nothing to listen for or measure.
  let startNote = null;
  let fromStart = null;
  if (args.startMs !== null && !asIs) {
    fromStart = partFromStart({ durationMs, cutMs, startMs: args.startMs });
    if (fromStart === null) {
      startNote = `The song is no longer than the cut, so its part cannot start at ${seconds(args.startMs)} s.`;
    } else if (fromStart.startMs < args.startMs) {
      startNote = `The song ends ${seconds(durationMs - args.startMs)} s after the ${seconds(args.startMs)} s asked, less than the ${seconds(fromStart.lengthMs)} s part, so the part starts at ${seconds(fromStart.startMs)} s of the song instead.`;
    }
  }
  const chosen =
    around ??
    fromStart ??
    choosePart({
      durationMs,
      cutMs,
      envelope,
      beatsMs: beats.data?.beatsMs ?? [],
      downbeatsMs: beats.data?.downbeatsMs ?? [],
      sectionStartsMs: beats.data?.sectionStartsMs ?? [],
      bpm: beats.data?.bpm ?? null,
      asIs,
      lowEnvelope,
    });

  // Cut it, level it.
  const startFrame = Math.min(
    Math.round((chosen.startMs * info.rate) / 1000),
    Math.max(0, info.frames - Math.round((chosen.lengthMs * info.rate) / 1000)),
  );
  const frames =
    chosen.how === 'whole' && chosen.lengthMs >= durationMs
      ? info.frames
      : Math.min(Math.round((chosen.lengthMs * info.rate) / 1000), info.frames - startFrame);
  const startMs = Math.round((startFrame * 1000) / info.rate);
  const lengthMs =
    chosen.how === 'whole' && frames === info.frames ? Math.round(durationMs) : chosen.lengthMs;
  const offset = (startFrame * 1000) / info.rate;
  const inPart = (list) =>
    list
      .filter((at) => at >= offset && at < offset + lengthMs)
      .map((at) => Math.round(at - offset));
  const beatsInPart = inPart(beats.data?.beatsMs ?? []);
  // Where the first word is heard in the part (ms from its start), when the part was cut around it.
  const lyricsMs =
    around === null || firstWordAt === null ? null : Math.round(firstWordAt - offset);
  if (lyricsMs !== null && lyricsMs < args.lyricsAtMs) {
    lyricsNote = `The song’s words start ${seconds(lyricsMs)} s into the part, sooner than the ${seconds(args.lyricsAtMs)} s asked (the song has no longer intro): start the part ${seconds(args.lyricsAtMs - lyricsMs)} s into the cut.`;
  } else if (lyricsMs !== null && lyricsMs > args.lyricsAtMs) {
    lyricsNote = `The song’s words start ${seconds(lyricsMs)} s into the part, later than the ${seconds(args.lyricsAtMs)} s asked (the song ends too soon after them to start the part earlier): start the part ${seconds(lyricsMs - args.lyricsAtMs)} s before the cut starts, or let the words come in later.`;
  }
  // beatCount: how many beats the finder found inside the part; 0 says it has no steady beat (Review
  // then does not say the cuts sit on its beat).
  const part = {
    startMs,
    endMs: startMs + lengthMs,
    how: chosen.how,
    beatCount: beatsInPart.length,
  };
  const partMp3 = join(work, 'song.mp3');
  const lufs = cutPart({ wav, info, startFrame, frames, out: partMp3 });

  // The song as the record keeps it.
  const meta = kept ? null : got.meta;
  const base = kept
    ? record.song
    : {
        title: clip(String(meta.title || request.title || 'Untitled'), SONG_LIMITS.titleMax),
        artist: clip(String(meta.artist || request.artist || 'Unknown'), SONG_LIMITS.artistMax),
        version: request.version,
        asked: { from: args.from, file: args.file, url: args.link, by: args.by },
        source: { site: meta.site, via: meta.via, url: meta.url, id: String(meta.id) },
        trending,
        gotAt: now(),
      };
  const song = {
    title: base.title,
    artist: base.artist,
    version: base.version,
    asked: base.asked,
    source: base.source,
    fullMs: Math.round(durationMs),
    part,
    trending: base.trending,
    file: 'song.mp3',
    instagramLine: instagramLine({ title: base.title, artist: base.artist, part }),
    gotAt: base.gotAt,
  };

  const notes = [];
  if (pickNote !== null) notes.push(pickNote);
  if (lyricsNote !== null) notes.push(lyricsNote);
  if (startNote !== null) notes.push(startNote);
  if (chosen.how === 'whole' && asIs) {
    notes.push('Only the reel’s own audio could be had, so the part is the start of it.');
  }
  if (chosen.how === 'whole' && lengthMs < cutMs) {
    notes.push(
      `The song is ${clock(durationMs)}, shorter than the ${clock(cutMs)} cut: loop it on a bar line of its beats or let it end with a ramp-out.`,
    );
  } else if (cutMs > PART.maxMs) {
    notes.push(
      `The cut is longer than the ${clock(PART.maxMs)} a song's part can be, so the part is ${clock(PART.maxMs)} long: loop it on a bar line or let it end with a ramp-out.`,
    );
  }
  if (beats.data === null) {
    notes.push(
      `The beat finder did not give its beats (${beats.why}), so there are none; the part was found by loudness alone.`,
    );
  } else if (around === null && fromStart === null && chosen.how === 'measured' && !chosen.clear) {
    notes.push('The song has no clear drop, so the part starts after its intro.');
  }

  // Nothing failed: put it all in the job.
  const musicDir = join(editDir, FILES.dir);
  if (!kept) {
    renameSync(got.full, join(editDir, FILES.songFull));
    const reelFile = join(editDir, FILES.songReel);
    if (got.reel === null) rmSync(reelFile, { force: true });
    else if (got.reel === got.full) copyFileSync(join(editDir, FILES.songFull), reelFile);
    else renameSync(got.reel, reelFile);
  }
  renameSync(partMp3, join(musicDir, 'song.mp3'));
  copyAtomic(join(editDir, FILES.song), join(editDir, FILES.preview));
  record.source = 'song';
  record.reason = null;
  record.file = null;
  record.plan = planForSong(editDir, record, cutMs);
  record.song = song;
  record.songFailure = null;
  if (record.picked !== 'song') recordPick(record, 'song');
  record.making = null;
  writeRecord(editDir, record);

  return {
    ok: true,
    command: 'song',
    id: 'song',
    lengthMs,
    part,
    beats: beatsInPart,
    downbeats: inPart(beats.data?.downbeatsMs ?? []),
    bpm: beats.data?.bpm ?? null,
    dropMs: chosen.dropMs === null ? null : Math.round(chosen.dropMs - offset),
    lyricsMs,
    fullMs: song.fullMs,
    lufs,
    cutMs,
    title: song.title,
    artist: song.artist,
    instagramLine: song.instagramLine,
    trending: song.trending,
    trendingEvent,
    reused: kept,
    note: notes.length === 0 ? null : notes.join(' '),
  };
}

/** The `song` command: makes the part, or records why it could not (the earlier pick stays). */
async function song(args) {
  const { editDir } = args;
  const env = args.env ?? process.env;
  const record = readRecord(editDir) ?? emptyRecord();
  const musicDir = join(editDir, FILES.dir);
  mkdirSync(musicDir, { recursive: true });
  // What an earlier call that was killed left behind (this one holds the lock).
  for (const name of readdirSync(musicDir)) {
    if (name.startsWith('.song-')) rmSync(join(musicDir, name), { recursive: true, force: true });
  }
  const work = join(musicDir, `.song-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    return await makeSong(args, { env, record, work });
  } catch (err) {
    const failure = asSongFailure(err);
    try {
      const latest = readRecord(editDir) ?? emptyRecord();
      latest.songFailure = {
        asked: askedText(args),
        code: failure.code,
        message: failure.message,
        at: now(),
      };
      writeRecord(editDir, latest);
    } catch {
      // The failure being printed matters more than the record of it.
    }
    throw failure;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * What the record says when the screenshot's label is "Original audio · <account>": the words the owner
 * recognises (`asked`, which Review and the sheet read the account from) and one plain sentence.
 */
function originalAudioFailure(account) {
  const asked = account === null ? 'Original audio' : `Original audio · ${account}`;
  return {
    asked,
    code: 'original_audio',
    message: `The screenshot says “${asked}”, so there is no song to look up. Send the reel’s link or the song’s name.`,
  };
}

/**
 * The `song-note` command (RGM1): the screenshot's audio is "Original audio", so there is no song
 * to get and none is guessed. It only records `songFailure` next to the music the edit run made; the
 * pick, the versions and the preview stay as they are. A record that already has a song is left alone.
 */
function songNote({ editDir, original }) {
  const record = readRecord(editDir) ?? emptyRecord();
  const failure = originalAudioFailure(original);
  const recorded = record.song == null;
  if (recorded) {
    record.songFailure = { ...failure, at: now() };
    writeRecord(editDir, record);
  }
  return {
    ok: true,
    command: 'song-note',
    id: record.picked ?? 'none',
    lengthMs: null,
    asked: failure.asked,
    recorded,
  };
}

function asMusicError(err) {
  if (err instanceof MusicError) return err;
  return new MusicError('failed', redact(err instanceof Error ? err.message : String(err)));
}

/** Runs one call and answers its line; throws a MusicError for the failure line. */
export async function run(args) {
  if (!existsSync(args.editDir) || !statSync(args.editDir).isDirectory()) {
    throw new MusicError('failed', `There is no edit dir at ${args.editDir}.`);
  }
  const release = takeLock(args.editDir);
  try {
    switch (args.command) {
      case 'make':
        return await make(args);
      case 'pick':
        return pick(args);
      case 'supplied':
      case 'series':
        return fromFile(args);
      case 'none':
        return none(args);
      case 'song':
        return await song(args);
      case 'song-note':
        return songNote(args);
      default:
        throw new MusicError('failed', USAGE);
    }
  } finally {
    release();
  }
}

function print(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  if ('error' in args) {
    print({ ok: false, code: 'failed', message: args.error });
    process.exitCode = EXIT.failed;
    return;
  }
  try {
    print(await run(args));
    process.exitCode = EXIT.ok;
  } catch (err) {
    const failure = asMusicError(err);
    print({ ok: false, code: failure.code, message: redact(failure.message) });
    process.exitCode = exitCodeFor(failure.code);
  }
}

/** Whether this file is the script node was asked to run (not a module imported by a test). */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();
