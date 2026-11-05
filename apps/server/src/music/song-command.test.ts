import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MUSIC_FILES,
  MUSIC_LIMITS,
  type MusicRecord,
  musicExitCode,
  musicPlanSchema,
  musicRecordSchema,
  musicScriptLineSchema,
  SONG_ASKED_BY,
  SONG_ASKED_FROM,
  SONG_FAILURE_CODES,
  SONG_LIMITS,
  SONG_VERSIONS,
  instagramLine as sharedInstagramLine,
  songTrendingEventSchema,
  trendingCacheFile,
  trendingCacheSchema,
} from '@studio/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  EXIT,
  exitCodeFor,
  type MusicArgs,
  parseArgs,
  plainPlan,
  SONG_ASKED_BY as SCRIPT_ASKED_BY,
  SONG_ASKED_FROM as SCRIPT_ASKED_FROM,
  SONG_FAILURE_CODES as SCRIPT_FAILURE_CODES,
  SONG_LIMITS as SCRIPT_LIMITS,
  SONG_VERSIONS as SCRIPT_VERSIONS,
  SONG_LOUDNESS,
} from '../../assets/music/make-music.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { MUSIC_SCRIPT } from './music-assets.js';

// The music script's `song` command (Songs, SG3), run for real in a temp job folder against a fake
// getter (testdata/fake-get-song.mjs, where MUSIC_GET_SONG points the script), a fake beat finder
// (testdata/fake-hyperframes.mjs) and audio made with ffmpeg: a quiet verse and a loud drop. What
// it writes is read back through the shared schemas. Nothing here touches the network, the real
// inbox or the real home folder. STUDIO_TEST_HYPERFRAMES=1 also runs it against the real
// `npx hyperframes audio` (it needs the tool installed and the Mac online or its cache warm).

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn('song-command.test.ts: ffmpeg/ffprobe not found; skipping the runs that need them');
}

const TESTDATA = fileURLToPath(new URL('./testdata/', import.meta.url));
const PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url));
const GETTER = join(TESTDATA, 'fake-get-song.mjs');
const TRENDING = join(TESTDATA, 'fake-trending-pick.mjs');
const REAL_PICK = join(TESTDATA, 'fake-apify-pick.mjs');
const HYPERFRAMES = join(TESTDATA, 'fake-hyperframes.mjs');
const SPEECH = join(TESTDATA, 'fake-speech.mjs');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-song-'));
  temps.push(dir);
  return dir;
}

// --- audio ---------------------------------------------------------------------------------------

function ff(args: string[]): void {
  const made = spawnSync(ffmpeg as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  expect(made.status, made.stderr).toBe(0);
}

/**
 * A stereo m4a of `seconds`: a quiet sine until `dropAt` s, then a loud one over it (20 dB up), or
 * only the quiet one for `null`. `gain` scales both, to test levelling.
 */
function writeSong(path: string, seconds: number, dropAt: number | null = 20, gain = 1): void {
  const quiet = `sine=frequency=220:sample_rate=48000:duration=${seconds}`;
  if (dropAt === null) {
    ff([
      '-f',
      'lavfi',
      '-i',
      quiet,
      '-af',
      `volume=${0.24 * gain},aformat=channel_layouts=stereo`,
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      path,
    ]);
    return;
  }
  const loud = `sine=frequency=110:sample_rate=48000:duration=${seconds - dropAt}`;
  ff([
    '-f',
    'lavfi',
    '-i',
    quiet,
    '-f',
    'lavfi',
    '-i',
    loud,
    '-filter_complex',
    `[0:a]volume=${0.24 * gain}[q];[1:a]volume=${2.4 * gain},adelay=${dropAt * 1000}|${dropAt * 1000}[l];[q][l]amix=inputs=2:duration=first:normalize=0,aformat=channel_layouts=stereo`,
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    path,
  ]);
}

/**
 * A stereo m4a of `seconds` where the loudness steps before the bass is heard (C73): a quiet 220 Hz
 * sine, a loud 1 kHz one from `midAt` s (the loudness steps, the low band hardly moves) and a loud
 * 70 Hz one from `bassAt` s (the bass comes in).
 */
function writeBassSong(path: string, seconds: number, midAt: number, bassAt: number): void {
  const tone = (frequency: number, duration: number) =>
    `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`;
  ff([
    '-f',
    'lavfi',
    '-i',
    tone(220, seconds),
    '-f',
    'lavfi',
    '-i',
    tone(1000, seconds - midAt),
    '-f',
    'lavfi',
    '-i',
    tone(70, seconds - bassAt),
    '-filter_complex',
    `[0:a]volume=0.24[q];[1:a]volume=2.4,adelay=${midAt * 1000}|${midAt * 1000}[m];[2:a]volume=2.4,adelay=${bassAt * 1000}|${bassAt * 1000}[b];[q][m][b]amix=inputs=3:duration=first:normalize=0,aformat=channel_layouts=stereo`,
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    path,
  ]);
}

/** What `hyperframes audio --json` says for such a song: 120 BPM, a bar every 2 s, two sections. */
function beatFinderAnswer(seconds: number, dropAt: number | null = 20): string {
  const every = (first: number, step: number) => {
    const out: number[] = [];
    for (let t = first; t < seconds; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  };
  const spans =
    dropAt === null
      ? [{ start: 0, end: seconds, label: 'A' }]
      : [
          { start: 0, end: dropAt + 0.1, label: 'A' },
          { start: dropAt + 0.1, end: seconds, label: 'B' },
        ];
  return JSON.stringify({
    version: 1,
    items: [
      {
        file: 'song.wav',
        duration: seconds,
        beats: { times: every(0.1, 0.5), confidence: 0.98 },
        downbeats: { times: every(0.1, 2), meter: 4, confidence: 'low' },
        bpm: { value: 120, curve: [] },
        sections: { spans },
      },
    ],
    _meta: { version: '0.8.198' },
  });
}

function probeMs(file: string): number {
  const out = spawnSync(ffprobe as string, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return Math.round(Number.parseFloat(out.stdout.toString()) * 1000);
}

function loudness(file: string): { integrated: number; truePeak: number } {
  const out = spawnSync(ffmpeg as string, [
    '-hide_banner',
    '-nostdin',
    '-i',
    file,
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]).stderr.toString();
  const summary = out.slice(out.lastIndexOf('Summary:'));
  return {
    integrated: Number.parseFloat(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? 'NaN'),
    truePeak: Number.parseFloat(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? 'NaN'),
  };
}

/** The mp3's samples (mono mix, 48 kHz). */
function samples(file: string): Float32Array {
  const out = spawnSync(
    ffmpeg as string,
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const bytes = out.stdout;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

function rms(data: Float32Array, fromSec: number, toSec: number): number {
  const part = data.slice(Math.round(fromSec * 48_000), Math.round(toSec * 48_000));
  let sum = 0;
  for (const value of part) sum += value * value;
  return Math.sqrt(sum / Math.max(1, part.length));
}

// --- the bench -----------------------------------------------------------------------------------

interface SongLine {
  ok: boolean;
  [key: string]: unknown;
}

interface Ran {
  status: number | null;
  line: SongLine;
  stdout: string;
  stderr: string;
}

interface Scenario {
  full?: string;
  reel?: string;
  fail?: { code: string; message: string };
  title?: string;
  artist?: string;
  trending?: unknown;
  trendingFail?: { code: string; message: string };
  /** For the real pick (fake-apify-pick.mjs): what each Apify actor answers, and where the calls are logged. */
  apify?: { hashtags?: unknown[]; accounts?: unknown[]; sounds?: unknown[] };
  apifyLog?: string;
}

function plan(lengthMs: number, bpm = 120) {
  return {
    lengthMs,
    styles: ['intense cinematic electronic', `${bpm} BPM`],
    avoid: ['vocals'],
    sections: [
      { name: 'Build', ms: 7_000, styles: ['rising'], avoid: [] },
      { name: 'Drop', ms: lengthMs - 7_000, styles: ['full drop'], avoid: [] },
    ],
    describe: 'Intense cinematic electronic. Drops at 0:07.',
  };
}

class Bench {
  readonly root = tempDir();
  readonly home = join(this.root, 'home');
  readonly jobDir = join(this.root, 'inbox', 'Horizon FPV', 'Demo');
  readonly editDir = join(this.jobDir, 'edit');
  readonly scenarioFile = join(this.root, 'scenario.json');
  readonly log = join(this.root, 'getter.jsonl');
  readonly trendingLog = join(this.root, 'trending.jsonl');
  readonly beatFile = join(this.root, 'beats.json');
  readonly speechFile = join(this.root, 'speech.json');
  readonly speechLog = join(this.root, 'speech.jsonl');
  readonly beatBin = join(this.root, 'bin', 'hyperframes');
  readonly songs = new Map<string, string>();

  constructor() {
    mkdirSync(join(this.editDir, 'music'), { recursive: true });
    mkdirSync(this.home, { recursive: true });
    mkdirSync(join(this.root, 'bin'), { recursive: true });
    writeFileSync(this.log, '');
    writeFileSync(this.trendingLog, '');
    writeFileSync(this.speechLog, '');
    writeFileSync(this.beatBin, `#!/bin/sh\nexec "${process.execPath}" "${HYPERFRAMES}" "$@"\n`);
    chmodSync(this.beatBin, 0o755);
  }

  /** A song file (an m4a of `seconds`) kept under `name`, with the beat finder's answer for it. */
  song(name: string, seconds = 40, dropAt: number | null = 20, gain = 1): string {
    const file = join(this.root, `${name}.m4a`);
    writeSong(file, seconds, dropAt, gain);
    this.songs.set(name, file);
    return file;
  }

  /** What the fake getter and the fake trending pick do from now on. */
  scenario(scenario: Scenario): void {
    writeFileSync(
      this.scenarioFile,
      JSON.stringify({ log: this.log, trendingLog: this.trendingLog, ...scenario }),
    );
  }

  /** What the stand-in for the word finder (Scribe) answers from now on: where the first word is, or why not. */
  speech(answer: { ms?: number | null; why?: string; throws?: string }): void {
    writeFileSync(this.speechFile, JSON.stringify({ log: this.speechLog, ...answer }));
  }

  speechCalls(): Record<string, unknown>[] {
    return readFileSync(this.speechLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beats(seconds = 40, dropAt: number | null = 20): void {
    writeFileSync(this.beatFile, beatFinderAnswer(seconds, dropAt));
  }

  writePlan(value: unknown = plan(15_000)): void {
    writeFileSync(join(this.editDir, MUSIC_FILES.plan), JSON.stringify(value));
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (name === 'ELEVENLABS_API_KEY' || name === 'APIFY_TOKEN') continue;
      if (name.startsWith('MUSIC_') || name.startsWith('STUDIO_') || name.startsWith('FAKE_'))
        continue;
      env[name] = value;
    }
    return {
      ...env,
      HOME: this.home,
      MUSIC_GET_SONG: GETTER,
      MUSIC_TRENDING_PICK: join(this.root, 'no-trending-pick.mjs'),
      MUSIC_HYPERFRAMES: this.beatBin,
      MUSIC_SPEECH: SPEECH,
      FAKE_SONG_SCENARIO: this.scenarioFile,
      FAKE_SPEECH_SCENARIO: this.speechFile,
      FAKE_HF_JSON: this.beatFile,
      ...extra,
    };
  }

  /** Runs the script's `song` command as the edit run would, and waits. */
  run(args: string[], extra: Record<string, string> = {}): Ran {
    return this.exec('song', args, extra);
  }

  /** Runs the script's `song-note` command (RGM1), and waits. */
  note(args: string[], extra: Record<string, string> = {}): Ran {
    return this.exec('song-note', args, extra);
  }

  private exec(command: string, args: string[], extra: Record<string, string>): Ran {
    const result = spawnSync(process.execPath, [MUSIC_SCRIPT, command, this.editDir, ...args], {
      encoding: 'utf8',
      env: this.env(extra),
      timeout: 120_000,
    });
    const lines = result.stdout.trim().split('\n');
    expect(lines, `one line on stdout: ${result.stdout}${result.stderr}`).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '') as SongLine;
    // The shared contract reads the line, and the exit code is the contract's for it.
    const known = musicScriptLineSchema.parse(line);
    expect(result.status).toBe(known.ok ? 0 : musicExitCode(known.code));
    return { status: result.status, line, stdout: result.stdout, stderr: result.stderr };
  }

  record(): MusicRecord {
    return musicRecordSchema.parse(
      JSON.parse(readFileSync(join(this.editDir, MUSIC_FILES.record), 'utf8')),
    );
  }

  file(path: string): string {
    return join(this.editDir, path);
  }

  bytes(path: string): Buffer {
    return readFileSync(this.file(path));
  }

  getterCalls(): Record<string, unknown>[] {
    return readFileSync(this.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  trendingCalls(): Record<string, unknown>[] {
    return readFileSync(this.trendingLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Nothing is left in edit/music/ but the files the contract names and the plan. */
  expectTidy(): void {
    const names = readdirSync(this.file('music')).sort();
    expect(names.filter((name) => name.startsWith('.'))).toEqual([]);
  }
}

/** Songs made once for the whole file (making audio is the slow part of a test). */
const shared = new Map<string, string>();
let sharedDir = '';

function sharedSong(name: string, seconds: number, dropAt: number | null): string {
  const known = shared.get(name);
  if (known !== undefined) return known;
  if (sharedDir === '') sharedDir = mkdtempSync(join(tmpdir(), 'studio-song-shared-'));
  const file = join(sharedDir, `${name}.m4a`);
  writeSong(file, seconds, dropAt);
  shared.set(name, file);
  return file;
}

afterAll(() => {
  if (sharedDir !== '') rmSync(sharedDir, { recursive: true, force: true });
});

/** The usual bench: a 40 s song with its drop at 20 s, a 15 s cut. */
function usual(): Bench {
  const bench = new Bench();
  const full = sharedSong('main', 40, 20);
  bench.songs.set('main', full);
  bench.scenario({ full });
  bench.beats();
  bench.writePlan();
  return bench;
}

const NAMED = [
  '--title',
  'Fake Song',
  '--artist',
  'Fake Artist',
  '--from',
  'name',
  '--by',
  'brief',
];

describe('the contract it shares', () => {
  it('names the same songs words, limits and exit codes as the shared contract', () => {
    expect(SCRIPT_VERSIONS).toEqual([...SONG_VERSIONS]);
    expect(SCRIPT_ASKED_FROM).toEqual([...SONG_ASKED_FROM]);
    expect(SCRIPT_ASKED_BY).toEqual([...SONG_ASKED_BY]);
    expect(SCRIPT_FAILURE_CODES).toEqual([...SONG_FAILURE_CODES]);
    expect(SCRIPT_LIMITS).toEqual(SONG_LIMITS);
    for (const code of SONG_FAILURE_CODES)
      expect(exitCodeFor(code), code).toBe(musicExitCode(code));
    expect(EXIT.refused).toBe(2);
  });

  it('levels a song like a version, with a true peak ceiling of -1', () => {
    expect(SONG_LOUDNESS).toEqual({ integratedLufs: -20, truePeakDbtp: -1 });
  });
});

describe('the song arguments', () => {
  const song = (...rest: string[]) => parseArgs(['song', 'edit', ...rest]);

  it('reads a named song as the Brief run asks for it', () => {
    expect(
      song(
        '--title',
        'נתתי לך בית',
        '--artist',
        'Ofek Adanek',
        '--version',
        'sped up',
        '--link',
        'https://music.youtube.com/watch?v=abc',
        '--from',
        'screenshot',
        '--file',
        'IMG_4412.PNG',
        '--by',
        'brief',
      ),
    ).toMatchObject({
      command: 'song',
      title: 'נתתי לך בית',
      artist: 'Ofek Adanek',
      version: 'sped up',
      link: 'https://music.youtube.com/watch?v=abc',
      from: 'screenshot',
      file: 'IMG_4412.PNG',
      by: 'brief',
      trending: false,
      niche: null,
      lengthMs: null,
      target: null,
    });
  });

  it('reads a link alone, a trending song, and the revise run’s calls', () => {
    expect(
      song('--link', 'https://www.instagram.com/reel/C1/', '--from', 'link', '--by', 'brief'),
    ).toMatchObject({ title: null, artist: null, link: 'https://www.instagram.com/reel/C1/' });
    expect(song('--trending', '--from', 'trending', '--by', 'editor')).toMatchObject({
      trending: true,
      from: 'trending',
      by: 'editor',
      niche: null,
    });
    expect(
      song('--trending', '--from', 'trending', '--by', 'editor', '--niche', '#fpv #fpvdrone'),
    ).toMatchObject({ niche: '#fpv #fpvdrone' });
    expect(song('--title', 'A', '--artist', 'B', '--from', 'note', '--by', 'you')).toMatchObject({
      from: 'note',
      by: 'you',
    });
    expect(song('--trending', '--from', 'trending', '--by', 'you')).toMatchObject({
      trending: true,
      by: 'you',
    });
    expect(song('--title', 'A', '--length-ms', '45000')).toMatchObject({ lengthMs: 45_000 });
  });

  it('fills in how and by whom when they are left out', () => {
    expect(song('--title', 'A', '--artist', 'B')).toMatchObject({ from: 'name', by: 'brief' });
    expect(song('--link', 'https://youtu.be/abc')).toMatchObject({ from: 'link', by: 'brief' });
    expect(song('--trending')).toMatchObject({ from: 'trending', by: 'editor' });
    // A trending pick is always asked "from trending".
    expect(song('--trending', '--from', 'name')).toMatchObject({ from: 'trending' });
  });

  it('reads --lyrics-at as the moment of the cut where the words start, in whole ms', () => {
    expect(song('--title', 'A', '--lyrics-at', '7000')).toMatchObject({ lyricsAtMs: 7000 });
    expect(song('--trending', '--lyrics-at', ' 12500 ')).toMatchObject({
      trending: true,
      lyricsAtMs: 12_500,
    });
    expect(song('--title', 'A')).toMatchObject({ lyricsAtMs: null });
    expect(parseArgs(['make', 'edit', '--lyrics-at', '7000'])).toHaveProperty('error');
  });

  it('reads --start-ms as the moment of the song where the part starts, in whole ms', () => {
    expect(song('--title', 'A', '--start-ms', '37000')).toMatchObject({
      startMs: 37_000,
      lyricsAtMs: null,
    });
    expect(song('--title', 'A', '--start-ms', ' 0 ')).toMatchObject({ startMs: 0 });
    expect(song('--trending', '--start-ms', '90000')).toMatchObject({
      trending: true,
      startMs: 90_000,
    });
    expect(song('--title', 'A')).toMatchObject({ startMs: null });
    expect(parseArgs(['make', 'edit', '--start-ms', '7000'])).toHaveProperty('error');
  });

  it('leaves out an option whose value is blank', () => {
    expect(song('--title', 'A', '--artist', '  ', '--version', '', '--link', ' ')).toMatchObject({
      title: 'A',
      artist: null,
      version: null,
      link: null,
    });
  });

  it('says what is wrong with a call it cannot use', () => {
    for (const argv of [
      [],
      ['--artist', 'B'],
      ['--version', 'sped up'],
      ['--title'],
      ['--title', 'A', '--version', 'nightcore'],
      ['--title', 'A', '--from', 'dream'],
      ['--title', 'A', '--by', 'edit'],
      ['--title', 'A', '--by', 'claude'],
      ['--title', 'A', '--length-ms', '2999'],
      ['--title', 'A', '--length-ms', String(MUSIC_LIMITS.lengthMaxMs + 1)],
      ['--title', 'A', '--length-ms', '45s'],
      ['--title', 'A', '--lyrics-at', '499'],
      ['--title', 'A', '--lyrics-at', '7s'],
      ['--title', 'A', '--lyrics-at', '-7000'],
      ['--title', 'A', '--lyrics-at', String(MUSIC_LIMITS.lengthMaxMs + 1)],
      ['--title', 'A', '--lyrics-at'],
      ['--title', 'A', '--start-ms', '37s'],
      ['--title', 'A', '--start-ms', '-1'],
      ['--title', 'A', '--start-ms', '3600001'],
      ['--title', 'A', '--start-ms'],
      ['--title', 'A', '--start-ms', '37000', '--lyrics-at', '7000'],
      ['--trending', '--title', 'A'],
      ['--trending', '--artist', 'B'],
      ['--trending', '--link', 'https://youtu.be/abc'],
      ['--trending', '--version', 'remix'],
      ['--title', 'A', '--again'],
      ['--title', 'A', '--ask', 'darker'],
      ['--title', 'A', '--loud'],
    ]) {
      expect(song(...argv), argv.join(' ')).toHaveProperty('error');
    }
    expect(parseArgs(['song'])).toHaveProperty('error');
    expect(parseArgs(['song', 'edit', 'extra', '--title', 'A'])).toHaveProperty('error');
  });

  it('accepts every song call the edit and revise prompts make', () => {
    const PLACEHOLDERS: Record<string, string> = {
      '--title': 'Song',
      '--artist': 'Artist',
      '--version': 'remix',
      '--link': 'https://youtu.be/abc',
      '--file': 'IMG_1.PNG',
    };
    const calls: string[][] = [];
    for (const name of ['music-songs', 'music-revise-songs']) {
      const text = readFileSync(join(PROMPTS, `${name}.md`), 'utf8');
      for (const match of text.matchAll(/`node "\{\{musicScript\}\}" song ([^`]*)`/g)) {
        const words = [...(match[1] ?? '').replace(/[[\]]/g, '').matchAll(/"[^"]*"|\S+/g)].map(
          (word) => word[0].replace(/^"|"$/g, ''),
        );
        calls.push(
          words.map((word, i) => {
            const given = /^<(.*)>$/.exec(word)?.[1];
            if (given === undefined || given === 'edit dir')
              return word === '<edit dir>' ? 'edit' : word;
            return given.includes('|')
              ? (given.split('|')[0] as string)
              : (PLACEHOLDERS[words[i - 1] ?? ''] ?? given);
          }),
        );
      }
    }
    // Two named-song calls, three trending ones and a link (edit and revise), as SG4 wrote them.
    expect(calls).toHaveLength(5);
    for (const words of calls) {
      const parsed = parseArgs(['song', ...words]);
      expect(parsed, words.join(' ')).not.toHaveProperty('error');
      expect(parsed).toMatchObject({ command: 'song' });
    }
    expect(calls.filter((words) => words.includes('--trending'))).toHaveLength(2);
  });

  it('keeps the song options to song, and --by edit|revise|you to the others', () => {
    for (const argv of [
      ['make', 'edit', '--title', 'A'],
      ['make', 'edit', '--trending'],
      ['pick', 'edit', 'v1', '--from', 'note'],
      ['none', 'edit', 'reason', '--length-ms', '9000'],
    ]) {
      expect(parseArgs(argv), argv.join(' ')).toHaveProperty('error');
    }
    expect(parseArgs(['make', 'edit', '--by', 'revise'])).toMatchObject({ by: 'revise' });
    expect(parseArgs(['make', 'edit', '--by', 'brief'])).toHaveProperty('error');
    expect((parseArgs(['make', 'edit']) as MusicArgs).by).toBe('edit');
  });
});

describe('the song-note arguments (RGM1)', () => {
  const note = (...rest: string[]) => parseArgs(['song-note', '/tmp/edit', ...rest]);

  it('reads the account under the Original audio label', () => {
    expect(note('--original', '@reels.creator')).toMatchObject({
      command: 'song-note',
      editDir: '/tmp/edit',
      original: '@reels.creator',
    });
    expect(note('--original', '  @reels.creator ')).toMatchObject({ original: '@reels.creator' });
  });

  it('takes a blank account as no account', () => {
    expect(note('--original', '')).toMatchObject({ original: null });
    expect(note('--original', '   ')).toMatchObject({ original: null });
  });

  it('says what is wrong with a call it cannot use', () => {
    for (const argv of [
      [],
      ['--original'],
      ['--original', '@x', 'extra'],
      ['--original', '@x', '--title', 'A'],
      ['--original', '@x', '--link', 'https://youtu.be/abc'],
      ['--original', '@x', '--from', 'screenshot'],
      ['--original', '@x', '--by', 'brief'],
      ['--original', '@x', '--trending'],
      ['--original', '@x', '--again'],
      ['--original', '@x', '--ask', 'darker'],
      ['--original', '@x', '--loud'],
    ]) {
      expect(note(...argv), argv.join(' ')).toHaveProperty('error');
    }
    expect(parseArgs(['song-note'])).toHaveProperty('error');
  });

  it('keeps --original to song-note', () => {
    for (const argv of [
      ['song', '/tmp/edit', '--title', 'A', '--original', '@x'],
      ['make', '/tmp/edit', '--original', '@x'],
      ['pick', '/tmp/edit', 'v1', '--original', '@x'],
    ]) {
      expect(parseArgs(argv), argv.join(' ')).toHaveProperty('error');
    }
  });

  it('accepts the song-note call the edit prompt makes', () => {
    const text = readFileSync(join(PROMPTS, 'music-songs-sources.md'), 'utf8');
    const calls = [...text.matchAll(/`node "\{\{musicScript\}\}" song-note ([^`]*)`/g)];
    expect(calls).toHaveLength(1);
    const argv = [...(calls[0]?.[1] ?? '').matchAll(/"[^"]*"|\S+/g)]
      .map((word) => word[0].replace(/^"|"$/g, ''))
      .map((word) =>
        word === '<edit dir>' ? '/tmp/edit' : word === '<the account>' ? '@reels.creator' : word,
      );
    expect(parseArgs(['song-note', ...argv])).toMatchObject({
      command: 'song-note',
      editDir: '/tmp/edit',
      original: '@reels.creator',
    });
  });
});

describe('the song-note command (RGM1)', () => {
  it('records that the screenshot says Original audio, and nothing else', () => {
    const bench = new Bench();
    const ran = bench.note(['--original', '@reels.creator']);
    expect(ran.status).toBe(0);
    expect(ran.line).toEqual({
      ok: true,
      command: 'song-note',
      id: 'none',
      lengthMs: null,
      asked: 'Original audio · @reels.creator',
      recorded: true,
    });
    const record = bench.record();
    expect(record.songFailure).toMatchObject({
      asked: 'Original audio · @reels.creator',
      code: 'original_audio',
      message:
        'The screenshot says “Original audio · @reels.creator”, so there is no song to look up. Send the reel’s link or the song’s name.',
    });
    expect(record).toMatchObject({
      source: 'made',
      picked: null,
      plan: null,
      versions: [],
      song: null,
      making: null,
      failure: null,
    });
    // Review and the sheet read the account out of `asked`.
    expect(/@[\w.]+/.exec(record.songFailure?.asked ?? '')?.[0]).toBe('@reels.creator');
    // Nothing else is written: no music, no preview, no lock, no leftovers.
    expect(readdirSync(bench.file('music')).sort()).toEqual(['music.json']);
    expect(existsSync(bench.file(MUSIC_FILES.preview))).toBe(false);
  });

  it('says Original audio alone when the label names no account', () => {
    const bench = new Bench();
    const ran = bench.note(['--original', '']);
    expect(ran.line).toMatchObject({ ok: true, asked: 'Original audio' });
    expect(bench.record().songFailure).toMatchObject({
      asked: 'Original audio',
      code: 'original_audio',
      message:
        'The screenshot says “Original audio”, so there is no song to look up. Send the reel’s link or the song’s name.',
    });
  });

  it('replaces its own note when it is run again', () => {
    const bench = new Bench();
    bench.note(['--original', '@reels.creator']);
    const first = bench.record().songFailure;
    bench.note(['--original', '@other.account']);
    const second = bench.record().songFailure;
    expect(first?.asked).toBe('Original audio · @reels.creator');
    expect(second?.asked).toBe('Original audio · @other.account');
  });

  it('does not run while another call holds the lock, and records nothing', () => {
    const bench = new Bench();
    writeFileSync(
      bench.file(MUSIC_FILES.lock),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    const ran = bench.note(['--original', '@x']);
    expect(ran.line).toMatchObject({ ok: false, code: 'failed' });
    expect(String(ran.line.message)).toMatch(/already being made or picked/);
    expect(existsSync(bench.file(MUSIC_FILES.record))).toBe(false);
  });

  it('fails on a call it cannot use, and records nothing', () => {
    const bench = new Bench();
    const ran = bench.note([]);
    expect(ran.line).toMatchObject({ ok: false, code: 'failed' });
    expect(existsSync(bench.file(MUSIC_FILES.record))).toBe(false);
  });
});

describe('the plain plan', () => {
  it('is the cut long, in sections of at most two minutes, and the schema reads it', () => {
    for (const lengthMs of [3_000, 12_000, 120_000, 120_001, 239_999, 359_999, 600_000]) {
      const plain = plainPlan(lengthMs);
      expect(musicPlanSchema.safeParse(plain).success, `${lengthMs}`).toBe(true);
      expect(plain.lengthMs).toBe(lengthMs);
      expect(plain.sections.reduce((sum, section) => sum + section.ms, 0)).toBe(lengthMs);
    }
    expect(plainPlan(12_000).sections).toHaveLength(1);
    expect(plainPlan(120_001).sections).toHaveLength(2);
  });
});

describe.skipIf(!haveTools)(
  'the song-note command next to music (RGM1)',
  { timeout: 60_000 },
  () => {
    /** `make --fake` (an ffmpeg tone, no network): the version the edit run makes. */
    function make(bench: Bench): Record<string, unknown> {
      const made = spawnSync(process.execPath, [MUSIC_SCRIPT, 'make', bench.editDir, '--fake'], {
        encoding: 'utf8',
        env: bench.env(),
      });
      return JSON.parse(made.stdout.trim()) as Record<string, unknown>;
    }

    it('sits next to the v1 the edit run made: the pick, the version and the preview stay', () => {
      const bench = new Bench();
      bench.writePlan();
      expect(make(bench)).toMatchObject({ ok: true, id: 'v1' });
      const before = { record: bench.record(), preview: bench.bytes(MUSIC_FILES.preview) };

      const ran = bench.note(['--original', '@reels.creator']);
      expect(ran.line).toMatchObject({ ok: true, id: 'v1', recorded: true });

      const record = bench.record();
      expect(record.songFailure).toMatchObject({
        asked: 'Original audio · @reels.creator',
        code: 'original_audio',
      });
      expect({ ...record, songFailure: null }).toEqual(before.record);
      expect(record).toMatchObject({ source: 'made', picked: 'v1', song: null });
      expect(record.versions.map((version) => version.id)).toEqual(['v1']);
      expect(bench.bytes(MUSIC_FILES.preview).equals(before.preview)).toBe(true);
      bench.expectTidy();
    });

    it('is kept by a make after it (Make another in Review), in either order', () => {
      const bench = new Bench();
      bench.writePlan();
      bench.note(['--original', '@reels.creator']);
      expect(make(bench)).toMatchObject({ ok: true, id: 'v1' });
      expect(make(bench)).toMatchObject({ ok: true, id: 'v2' });
      expect(bench.record()).toMatchObject({
        picked: 'v2',
        songFailure: { asked: 'Original audio · @reels.creator', code: 'original_audio' },
      });
    });

    it('is kept when the make failed: the record has the note and the make’s failure', () => {
      const bench = new Bench();
      // No plan.json: the make fails with bad_plan and says why in the record.
      expect(make(bench)).toMatchObject({ ok: false, code: 'bad_plan' });
      bench.note(['--original', '@reels.creator']);
      expect(bench.record()).toMatchObject({
        picked: null,
        failure: { code: 'bad_plan' },
        songFailure: { code: 'original_audio' },
      });
    });

    it('leaves a record that has a song alone: the song was got, so there is nothing to ask for', () => {
      const bench = usual();
      expect(bench.run(NAMED).line.ok).toBe(true);
      const before = readFileSync(bench.file(MUSIC_FILES.record), 'utf8');
      const ran = bench.note(['--original', '@reels.creator']);
      expect(ran.line).toMatchObject({ ok: true, id: 'song', recorded: false });
      expect(readFileSync(bench.file(MUSIC_FILES.record), 'utf8')).toBe(before);
      expect(bench.record().songFailure).toBeNull();
    });

    it('is cleared by the song that is got afterwards (the reel’s link the owner sends)', () => {
      const bench = usual();
      bench.note(['--original', '@reels.creator']);
      expect(bench.record().songFailure).not.toBeNull();
      expect(bench.run(NAMED).line.ok).toBe(true);
      expect(bench.record()).toMatchObject({ picked: 'song', songFailure: null });
    });
  },
);

describe.skipIf(!haveTools)('the song command', { timeout: 60_000 }, () => {
  it('gets the song, finds the part on its drop, levels it and records it', () => {
    const bench = usual();
    const ran = bench.run([...NAMED, '--file', 'IMG_4412.PNG']);
    const line = ran.line;
    expect(line).toMatchObject({
      ok: true,
      command: 'song',
      id: 'song',
      lengthMs: 15_000,
      part: { startMs: 20_100, endMs: 35_100, how: 'measured' },
      bpm: 120,
      dropMs: 0,
      cutMs: 15_000,
      title: 'Fake Song',
      artist: 'Fake Artist',
      trending: null,
      reused: false,
      note: null,
    });
    // The beats and the bars are in ms from the part's start.
    expect((line.beats as number[]).slice(0, 4)).toEqual([0, 500, 1000, 1500]);
    expect(line.beats).toHaveLength(30);
    // The part says how many beats it has (C73): Review says "on its beat" only when there are some.
    expect((line.part as { beatCount: number }).beatCount).toBe(30);
    expect(line.downbeats).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000]);
    expect(Math.abs((line.fullMs as number) - 40_000)).toBeLessThan(100);
    expect(Math.abs((line.lufs as number) + 20)).toBeLessThan(0.5);

    // The files: the part at -20 LUFS, the preview a copy of it, the whole song kept.
    expect(Math.abs(probeMs(bench.file(MUSIC_FILES.song)) - 15_000)).toBeLessThan(100);
    const level = loudness(bench.file(MUSIC_FILES.song));
    expect(Math.abs(level.integrated + 20)).toBeLessThan(0.5);
    expect(level.truePeak).toBeLessThan(-0.5);
    expect(bench.bytes(MUSIC_FILES.preview).equals(bench.bytes(MUSIC_FILES.song))).toBe(true);
    expect(existsSync(bench.file(MUSIC_FILES.songFull))).toBe(true);
    expect(existsSync(bench.file(MUSIC_FILES.songReel))).toBe(false);
    bench.expectTidy();
    expect(existsSync(bench.file(MUSIC_FILES.lock))).toBe(false);

    // The record is the shared contract's, with the plan the edit wrote.
    const record = bench.record();
    expect(record).toMatchObject({
      v: 1,
      source: 'song',
      reason: null,
      file: null,
      plan: plan(15_000),
      picked: 'song',
      versions: [],
      making: null,
      failure: null,
      songFailure: null,
    });
    expect(record.picks.map((pick) => pick.id)).toEqual(['song']);
    expect(record.song).toMatchObject({
      title: 'Fake Song',
      artist: 'Fake Artist',
      version: null,
      asked: { from: 'name', file: 'IMG_4412.PNG', url: null, by: 'brief' },
      source: { site: 'youtube-music', via: 'yt-dlp', id: 'fake0000001' },
      part: { startMs: 20_100, endMs: 35_100, how: 'measured', beatCount: 30 },
      trending: null,
      file: 'song.mp3',
    });
    expect(record.song?.instagramLine).toBe(
      sharedInstagramLine({
        title: 'Fake Song',
        artist: 'Fake Artist',
        part: { startMs: 20_100, endMs: 35_100, how: 'measured' },
      }),
    );
    expect(record.song?.instagramLine).toContain('start at 0:20.');
  });

  describe('--lyrics-at: the words come in at a moment of the cut', () => {
    it('cuts the part to start that long before the first word, so the intro leads in', () => {
      const bench = usual();
      bench.speech({ ms: 16_000 });
      const ran = bench.run([...NAMED, '--lyrics-at', '7000']);
      expect(ran.line).toMatchObject({
        ok: true,
        lengthMs: 15_000,
        part: { startMs: 9_000, endMs: 24_000, how: 'measured', beatCount: 30 },
        dropMs: null,
        lyricsMs: 7_000,
        note: null,
      });
      // The word finder listened once, to a small file cut from the song's start.
      const calls = bench.speechCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ file: true });
      expect(calls[0]?.bytes as number).toBeGreaterThan(1_000);
      // The record and the line for Instagram follow the part's start.
      expect(bench.record().song?.part).toMatchObject({ startMs: 9_000, endMs: 24_000 });
      expect(bench.record().song?.instagramLine).toContain('start at 0:09.');
      // The part is the song's quiet intro until the loud entry at 20 s (11 s into the part).
      const data = samples(bench.file(MUSIC_FILES.preview));
      expect(rms(data, 8, 10)).toBeLessThan(rms(data, 12, 14) / 3);
      expect(Math.abs(probeMs(bench.file(MUSIC_FILES.song)) - 15_000)).toBeLessThan(100);
      bench.expectTidy();
    });

    it('starts at the song’s start, and says so, when the first word comes sooner than asked', () => {
      const bench = usual();
      bench.speech({ ms: 3_000 });
      const ran = bench.run([...NAMED, '--lyrics-at', '7000']);
      expect(ran.line).toMatchObject({
        ok: true,
        part: { startMs: 0, endMs: 15_000 },
        dropMs: null,
        lyricsMs: 3_000,
      });
      expect(String(ran.line.note)).toMatch(
        /words start 3 s into the part, sooner than the 7 s asked.*start the part 4 s into the cut/,
      );
    });

    it('slides earlier at the song’s end, and says the words then come later than asked', () => {
      const bench = usual();
      bench.speech({ ms: 38_000 });
      const ran = bench.run([...NAMED, '--lyrics-at', '7000']);
      const part = ran.line.part as { startMs: number; endMs: number };
      expect(part.endMs - part.startMs).toBe(15_000);
      expect(part.endMs).toBeLessThanOrEqual(40_100);
      expect(Math.abs((ran.line.lyricsMs as number) - (38_000 - part.startMs))).toBeLessThan(2);
      expect(ran.line.lyricsMs as number).toBeGreaterThan(7_000);
      expect(String(ran.line.note)).toMatch(/later than the 7 s asked/);
    });

    it('goes on with the part found by loudness, and says why, when no word is found', () => {
      const bench = usual();
      bench.speech({ ms: null, why: 'no words were heard in the first two minutes' });
      const ran = bench.run([...NAMED, '--lyrics-at', '7000']);
      expect(ran.line).toMatchObject({
        ok: true,
        part: { startMs: 20_100, endMs: 35_100 },
        dropMs: 0,
        lyricsMs: null,
      });
      expect(String(ran.line.note)).toBe(
        'Could not find where the words start (no words were heard in the first two minutes), so the part is the one found by loudness.',
      );
      expect(bench.record().songFailure).toBeNull();
    });

    it('goes on the same way when the word finder breaks', () => {
      const bench = usual();
      bench.speech({ throws: 'the finder broke' });
      const ran = bench.run([...NAMED, '--lyrics-at', '7000']);
      expect(ran.line).toMatchObject({ ok: true, part: { startMs: 20_100 }, lyricsMs: null });
      expect(String(ran.line.note)).toContain('Could not find where the words start (');
    });

    it('does not listen at all without --lyrics-at', () => {
      const bench = usual();
      bench.speech({ ms: 16_000 });
      const ran = bench.run(NAMED);
      expect(ran.line).toMatchObject({ ok: true, part: { startMs: 20_100 }, lyricsMs: null });
      expect(bench.speechCalls()).toHaveLength(0);
    });

    it('says a song no longer than the cut cannot place its words, and uses it whole', () => {
      const bench = usual();
      bench.scenario({ full: sharedSong('short', 8, null) });
      bench.beats(8, null);
      bench.speech({ ms: 2_000 });
      const ran = bench.run([...NAMED, '--lyrics-at', '7000']);
      expect(ran.line).toMatchObject({
        ok: true,
        part: { startMs: 0, how: 'whole' },
        lyricsMs: null,
      });
      expect(String(ran.line.note)).toContain('cannot be placed at 7 s');
    });

    it('uses the moment again for the kept song, without getting it again', () => {
      const bench = usual();
      bench.speech({ ms: 16_000 });
      bench.run([...NAMED, '--lyrics-at', '7000']);
      bench.scenario({
        full: bench.songs.get('main'),
        fail: { code: 'blocked', message: 'Offline.' },
      });
      bench.speech({ ms: 16_000 });
      const again = bench.run([...NAMED, '--lyrics-at', '9000']);
      expect(again.line).toMatchObject({
        ok: true,
        reused: true,
        part: { startMs: 7_000, endMs: 22_000 },
        lyricsMs: 9_000,
      });
      expect(bench.getterCalls()).toHaveLength(1);
    });
  });

  describe('--start-ms: the part starts at a moment of the song', () => {
    it('cuts the part to start exactly there, without listening or looking for a drop', () => {
      const bench = usual();
      bench.speech({ ms: 16_000 });
      const ran = bench.run([...NAMED, '--start-ms', '12000']);
      expect(ran.line).toMatchObject({
        ok: true,
        lengthMs: 15_000,
        part: { startMs: 12_000, endMs: 27_000, how: 'measured' },
        dropMs: null,
        lyricsMs: null,
        note: null,
      });
      expect(bench.speechCalls()).toHaveLength(0);
      // The record and the line for Instagram follow the part's start.
      expect(bench.record().song?.part).toMatchObject({ startMs: 12_000, endMs: 27_000 });
      expect(bench.record().song?.instagramLine).toContain('start at 0:12.');
      expect(Math.abs(probeMs(bench.file(MUSIC_FILES.song)) - 15_000)).toBeLessThan(100);
      bench.expectTidy();
    });

    it('starts at the song’s start with --start-ms 0', () => {
      const bench = usual();
      const ran = bench.run([...NAMED, '--start-ms', '0']);
      expect(ran.line).toMatchObject({ ok: true, part: { startMs: 0, endMs: 15_000 } });
    });

    it('slides earlier at the song’s end, and says so', () => {
      const bench = usual();
      const ran = bench.run([...NAMED, '--start-ms', '38000']);
      const part = ran.line.part as { startMs: number; endMs: number };
      expect(part.endMs - part.startMs).toBe(15_000);
      expect(part.endMs).toBeLessThanOrEqual(40_100);
      expect(part.startMs).toBeLessThan(38_000);
      expect(String(ran.line.note)).toMatch(
        /less than the 15 s part, so the part starts at [\d.]+ s of the song instead/,
      );
    });

    it('says a song no longer than the cut cannot start there, and uses it whole', () => {
      const bench = usual();
      bench.scenario({ full: sharedSong('short', 8, null) });
      bench.beats(8, null);
      const ran = bench.run([...NAMED, '--start-ms', '2000']);
      expect(ran.line).toMatchObject({ ok: true, part: { startMs: 0, how: 'whole' } });
      expect(String(ran.line.note)).toContain('cannot start at 2 s');
    });

    it('uses the moment again for the kept song, without getting it again', () => {
      const bench = usual();
      bench.run([...NAMED, '--start-ms', '5000']);
      bench.scenario({
        full: bench.songs.get('main'),
        fail: { code: 'blocked', message: 'Offline.' },
      });
      const again = bench.run([...NAMED, '--start-ms', '9000']);
      expect(again.line).toMatchObject({
        ok: true,
        reused: true,
        part: { startMs: 9_000, endMs: 24_000 },
      });
      expect(bench.getterCalls()).toHaveLength(1);
    });
  });

  it('hands the getter the song, the tools the engine passed and the songs cache', () => {
    const bench = usual();
    bench.run([...NAMED, '--version', 'sped up'], {
      STUDIO_YT_DLP: '/opt/homebrew/bin/yt-dlp',
      STUDIO_DENO: '/opt/homebrew/bin/deno',
    });
    const [call, ...more] = bench.getterCalls();
    expect(more).toEqual([]);
    expect(call).toMatchObject({
      title: 'Fake Song',
      artist: 'Fake Artist',
      version: 'sped up',
      link: null,
      tools: { ytDlp: '/opt/homebrew/bin/yt-dlp', deno: '/opt/homebrew/bin/deno' },
      cacheDir: join(bench.home, '.studio-engine', 'songs-cache'),
    });
    // It works in a folder inside edit/music/, which is gone when the run is.
    expect(String(call?.workDir).startsWith(bench.file(MUSIC_FILES.dir))).toBe(true);
    expect(existsSync(String(call?.workDir))).toBe(false);
    expect(bench.record().song?.version).toBe('sped up');
  });

  it('passes no tools when the engine passed none (the getter then has its own defaults)', () => {
    const bench = usual();
    bench.run(NAMED);
    expect(bench.getterCalls()[0]?.tools).toEqual({});
  });

  it('asks for a song by its link alone', () => {
    const bench = usual();
    const link = 'https://www.instagram.com/reel/C1abc/';
    const ran = bench.run(['--link', link, '--from', 'link', '--by', 'brief']);
    expect(ran.line).toMatchObject({ ok: true });
    expect(bench.getterCalls()[0]).toMatchObject({ title: null, artist: null, link });
    expect(bench.record().song).toMatchObject({ asked: { from: 'link', url: link, by: 'brief' } });
  });

  it.each([
    ['a quiet song', 0.05],
    ['a loud one', 2.5],
  ])('brings %s to -20 LUFS with one gain', (_name, gain) => {
    const bench = usual();
    bench.scenario({ full: bench.song('gain', 40, 20, gain) });
    const ran = bench.run(NAMED);
    expect(ran.line.ok).toBe(true);
    const level = loudness(bench.file(MUSIC_FILES.song));
    expect(Math.abs(level.integrated + 20)).toBeLessThan(0.5);
    expect(level.truePeak).toBeLessThanOrEqual(-0.5);
  });

  it('fades the part in and out so the cut never clicks', () => {
    const bench = usual();
    bench.run(NAMED);
    const data = samples(bench.file(MUSIC_FILES.song));
    const middle = rms(data, 6, 8);
    expect(rms(data, 0, 0.005)).toBeLessThan(middle * 0.5);
    expect(rms(data, 14.9, 15)).toBeLessThan(middle * 0.2);
    expect(rms(data, 13.5, 13.6)).toBeGreaterThan(middle * 0.4);
  });

  it('uses the whole song, and says so, when it is shorter than the cut', () => {
    const bench = usual();
    bench.scenario({ full: sharedSong('short', 8, null) });
    bench.beats(8, null);
    const ran = bench.run(NAMED);
    expect(ran.line).toMatchObject({
      ok: true,
      part: { startMs: 0, how: 'whole' },
      cutMs: 15_000,
    });
    const part = ran.line.part as { endMs: number };
    expect(Math.abs(part.endMs - 8_000)).toBeLessThan(60);
    expect(ran.line.lengthMs).toBe(part.endMs);
    expect(String(ran.line.note)).toMatch(/shorter than the 0:15 cut.*loop it on a bar line/);
    expect(Math.abs(probeMs(bench.file(MUSIC_FILES.song)) - part.endMs)).toBeLessThan(100);
    expect(bench.record().song?.part.how).toBe('whole');
    expect(bench.record().song?.instagramLine).toContain('start at 0:00.');
  });

  it('refuses a song too short to be a part', () => {
    const bench = usual();
    bench.scenario({ full: sharedSong('tiny', 2, null) });
    bench.beats(2, null);
    const ran = bench.run(NAMED);
    expect(ran.line).toMatchObject({ ok: false, code: 'failed' });
    expect(String(ran.line.message)).toMatch(/only 2 seconds long/);
  });

  it('starts a reel’s own audio at its start and keeps it as song-reel.m4a', () => {
    const bench = usual();
    bench.scenario({ full: sharedSong('main', 40, 20), reel: 'same' });
    const ran = bench.run(['--link', 'https://www.instagram.com/reel/C1abc/', '--from', 'link']);
    expect(ran.line).toMatchObject({ ok: true, part: { startMs: 0, endMs: 15_000, how: 'whole' } });
    expect(String(ran.line.note)).toMatch(/reel’s own audio/);
    expect(bench.bytes(MUSIC_FILES.songReel).equals(bench.bytes(MUSIC_FILES.songFull))).toBe(true);
  });

  it('measures a clean track and keeps the reel’s audio beside it', () => {
    const bench = usual();
    const reel = join(bench.root, 'reel.m4a');
    writeSong(reel, 12, null);
    bench.scenario({ full: sharedSong('main', 40, 20), reel });
    const ran = bench.run(['--link', 'https://www.instagram.com/reel/C1abc/', '--from', 'link']);
    expect(ran.line).toMatchObject({ ok: true, part: { startMs: 20_100, how: 'measured' } });
    expect(bench.bytes(MUSIC_FILES.songReel).equals(readFileSync(reel))).toBe(true);
    expect(bench.bytes(MUSIC_FILES.songReel).equals(bench.bytes(MUSIC_FILES.songFull))).toBe(false);
    // The next song has no reel: the earlier one's audio goes.
    bench.scenario({ full: sharedSong('main', 40, 20) });
    bench.run(['--title', 'Other', '--artist', 'Someone']);
    expect(existsSync(bench.file(MUSIC_FILES.songReel))).toBe(false);
  });

  it('cuts down to two minutes when the cut is longer than any part can be', () => {
    const bench = usual();
    bench.scenario({ full: sharedSong('long', 140, 30) });
    bench.beats(140, 30);
    bench.writePlan({
      ...plan(150_000),
      sections: [
        { name: 'Build', ms: 75_000, styles: [], avoid: [] },
        { name: 'Drop', ms: 75_000, styles: [], avoid: [] },
      ],
    });
    const ran = bench.run(NAMED);
    expect(ran.line).toMatchObject({ ok: true, lengthMs: 120_000, cutMs: 150_000 });
    expect(String(ran.line.note)).toMatch(/longer than the 2:00 a song's part can be/);
    const part = bench.record().song?.part;
    expect((part?.endMs ?? 0) - (part?.startMs ?? 0)).toBe(120_000);
    expect(part?.endMs).toBeLessThanOrEqual(140_000);
  }, 60_000);

  it('goes on without the beat finder, by loudness alone, and says so', () => {
    const bench = usual();
    const ran = bench.run(NAMED, { FAKE_HF_EXIT: '3' });
    expect(ran.line).toMatchObject({ ok: true, beats: [], downbeats: [], bpm: null });
    expect(String(ran.line.note)).toMatch(
      /beat finder did not give its beats \(it stopped with 3\)/,
    );
    const part = ran.line.part as { startMs: number; how: string };
    expect(part.how).toBe('measured');
    expect(Math.abs(part.startMs - 20_000)).toBeLessThanOrEqual(1_000);
    // The part says it has no beats (C73), in the line and in the record.
    expect(part).toMatchObject({ beatCount: 0 });
    expect(bench.record().song?.part.beatCount).toBe(0);
    // An answer it cannot read is the same.
    writeFileSync(bench.beatFile, 'not an answer');
    expect(bench.run(NAMED).line).toMatchObject({ ok: true, beats: [], part: { beatCount: 0 } });
  });

  it('counts only the beats inside the part, and says 0 for a ballad the finder gave none for (C73)', () => {
    const bench = usual();
    // The finder answers, but with a beat list that is empty and nothing in the part: no steady beat.
    const answer = JSON.parse(beatFinderAnswer(40, 20));
    answer.items[0].beats.times = [1, 2, 3];
    answer.items[0].downbeats.times = [1.1];
    writeFileSync(bench.beatFile, JSON.stringify(answer));
    const ran = bench.run(NAMED);
    expect(ran.line).toMatchObject({ ok: true, beats: [], part: { beatCount: 0 } });
    expect(bench.record().song?.part).toMatchObject({ how: 'measured', beatCount: 0 });
    // Beats before the part do not count for it; the ones inside do, whatever the song has.
    answer.items[0].beats.times = [1, 2, 3, 20.5, 21, 22];
    writeFileSync(bench.beatFile, JSON.stringify(answer));
    const again = bench.run([...NAMED, '--length-ms', '15000']);
    expect(again.line).toMatchObject({ ok: true, part: { beatCount: 3 } });
    expect((again.line.beats as number[]).length).toBe(3);
    expect(bench.record().song?.part.beatCount).toBe(3);
  });

  it('puts dropMs on the bass, not on the loudness step before it (C73)', () => {
    const bench = usual();
    // The loudness steps at 19.2 s (a mid tone); the bass is heard at 20.0 s.
    const file = join(tempDir(), 'bass-mid.m4a');
    writeBassSong(file, 40, 19.2, 20);
    bench.scenario({ full: file });
    const ran = bench.run(NAMED);
    const part = ran.line.part as { startMs: number };
    // The part starts on a bar before the drop; the drop is 20.0 s into the song.
    expect(part.startMs).toBeLessThanOrEqual(19_200);
    const heard = 20_000 - part.startMs;
    expect(Math.abs((ran.line.dropMs as number) - heard)).toBeLessThanOrEqual(60);
    expect(ran.line.dropMs as number).toBeGreaterThan(19_200 - part.startMs + 400);
  });

  describe('the cut’s length', () => {
    it('is plan.json’s lengthMs, and --length-ms only when there is none', () => {
      const bench = usual();
      expect(bench.run([...NAMED, '--length-ms', '9000']).line).toMatchObject({
        ok: true,
        lengthMs: 15_000,
        cutMs: 15_000,
      });
      rmSync(bench.file(MUSIC_FILES.plan));
      const again = bench.run([...NAMED, '--length-ms', '9000']);
      expect(again.line).toMatchObject({ ok: true, lengthMs: 9_000, cutMs: 9_000 });
    });

    it('leaves a plain plan in the record when the edit wrote none, so Make music instead works', () => {
      const bench = usual();
      rmSync(bench.file(MUSIC_FILES.plan));
      bench.run([...NAMED, '--length-ms', '12000']);
      const record = bench.record();
      expect(record.plan).toEqual(plainPlan(12_000));
      expect(musicPlanSchema.safeParse(record.plan).success).toBe(true);
      expect(existsSync(bench.file(MUSIC_FILES.plan))).toBe(false);
    });

    it('is not written when plan.json is not a plan: the record gets a plain one of the cut', () => {
      const bench = usual();
      bench.writePlan({ lengthMs: 15_000 });
      bench.run(NAMED);
      expect(bench.record().plan).toEqual(plainPlan(15_000));
    });

    it('fails, and records why, when there is no cut length at all', () => {
      const bench = usual();
      rmSync(bench.file(MUSIC_FILES.plan));
      const ran = bench.run(NAMED);
      expect(ran).toMatchObject({ status: 1, line: { ok: false, code: 'failed' } });
      expect(String(ran.line.message)).toMatch(
        /write edit\/music\/plan\.json .* or pass --length-ms/,
      );
      expect(bench.getterCalls()).toEqual([]);
      expect(bench.record().songFailure).toMatchObject({
        asked: 'Fake Song by Fake Artist',
        code: 'failed',
      });
    });
  });

  describe('when the song cannot be got', () => {
    const FAILURES: [code: string, exit: number][] = [
      ['needs_key', 2],
      ['tool_missing', 2],
      ['original_audio', 2],
      ['unavailable', 3],
      ['blocked', 3],
      ['not_found', 1],
      ['update_needed', 1],
      ['failed', 1],
    ];

    it('records each failure, prints it, exits with its code and leaves the pick as it was', () => {
      const bench = usual();
      bench.run(NAMED);
      const before = {
        record: bench.record(),
        song: bench.bytes(MUSIC_FILES.song),
        preview: bench.bytes(MUSIC_FILES.preview),
        full: bench.bytes(MUSIC_FILES.songFull),
      };
      const main = bench.songs.get('main');
      for (const [code, exit] of FAILURES) {
        bench.scenario({ full: main, fail: { code, message: `The ${code} message.` } });
        const ran = bench.run([
          '--title',
          'Other Song',
          '--artist',
          'Someone',
          '--from',
          'note',
          '--by',
          'you',
        ]);
        expect(ran.status, code).toBe(exit);
        expect(ran.line, code).toEqual({ ok: false, code, message: `The ${code} message.` });

        const record = bench.record();
        expect(record.songFailure, code).toMatchObject({
          asked: 'Other Song by Someone',
          code,
          message: `The ${code} message.`,
        });
        expect({ ...record, songFailure: null }, code).toEqual(before.record);
        expect(bench.bytes(MUSIC_FILES.song).equals(before.song), code).toBe(true);
        expect(bench.bytes(MUSIC_FILES.preview).equals(before.preview), code).toBe(true);
        expect(bench.bytes(MUSIC_FILES.songFull).equals(before.full), code).toBe(true);
        bench.expectTidy();
        expect(existsSync(bench.file(MUSIC_FILES.lock)), code).toBe(false);
      }

      // The next song that is got clears the failure.
      bench.scenario({ full: main });
      expect(bench.run(NAMED).line.ok).toBe(true);
      expect(bench.record().songFailure).toBeNull();
    });

    it('a blocked ask (YouTube said too many requests) is not remembered as a no: the same ask runs the getter again and gets the song (C81)', () => {
      const bench = usual();
      const said =
        'YouTube Music is refusing requests from this Mac right now (it says this Mac asked too many times lately), so "Fake Song" by Fake Artist could not be got. Try again in a while.';
      bench.scenario({ fail: { code: 'blocked', message: said } });
      const refused = bench.run(NAMED);
      expect(refused.status).toBe(3);
      expect(refused.line).toEqual({ ok: false, code: 'blocked', message: said });
      // The record has the words for Review and the sheet, and no song, so nothing is reused.
      expect(bench.record()).toMatchObject({
        song: null,
        songFailure: { asked: 'Fake Song by Fake Artist', code: 'blocked', message: said },
      });
      expect(bench.getterCalls()).toHaveLength(1);

      // YouTube answers again: the very same ask is asked again (not skipped), and the failure goes.
      bench.scenario({ full: bench.songs.get('main') });
      const again = bench.run(NAMED);
      expect(again.line).toMatchObject({ ok: true, reused: false });
      expect(bench.getterCalls()).toHaveLength(2);
      expect(bench.record().songFailure).toBeNull();
      expect(bench.record().song).toMatchObject({ title: 'Fake Song' });
    });

    it('writes the record with the failure alone when nothing was picked, and no preview', () => {
      const bench = usual();
      bench.scenario({ fail: { code: 'not_found', message: 'No such song.' } });
      expect(bench.run(NAMED).status).toBe(1);
      expect(bench.record()).toMatchObject({
        source: 'made',
        picked: null,
        plan: null,
        song: null,
        songFailure: { asked: 'Fake Song by Fake Artist', code: 'not_found' },
      });
      expect(existsSync(bench.file(MUSIC_FILES.preview))).toBe(false);
    });

    it('says what was asked for in the words the owner knows', () => {
      const bench = usual();
      bench.scenario({ fail: { code: 'not_found', message: 'Nope.' } });
      const asked = (args: string[]) => {
        bench.run(args);
        return bench.record().songFailure?.asked;
      };
      expect(asked(['--title', 'Only A Title'])).toBe('Only A Title');
      expect(asked(['--title', 'T', '--artist', 'A', '--link', 'https://youtu.be/x'])).toBe(
        'T by A',
      );
      expect(asked(['--link', 'https://youtu.be/xyz'])).toBe('https://youtu.be/xyz');
    });

    it('turns any other error into a failed, and never prints a key', () => {
      const bench = usual();
      const token = 'apify_api_SECRETSECRET0123456789';
      bench.scenario({
        fail: { code: 'ENOENT', message: `spawn broke while using ${token} for the call` },
      });
      const ran = bench.run(NAMED, { FAKE_SONG_TOKEN: token });
      expect(ran.line).toMatchObject({ ok: false, code: 'failed' });
      expect(ran.stdout).not.toContain(token);
      expect(ran.stderr).not.toContain(token);
      expect(ran.stdout).toContain('[key]');
      expect(readFileSync(bench.file(MUSIC_FILES.record), 'utf8')).not.toContain(token);
    });

    it('fails with tool_missing when ffmpeg is not there', () => {
      const bench = usual();
      const ran = bench.run(NAMED, {
        MUSIC_FFMPEG: join(bench.root, 'no-ffmpeg'),
        PATH: '/nonexistent',
      });
      expect(ran.line).toMatchObject({ ok: false });
      expect(bench.record().songFailure).toBeDefined();
    });
  });

  describe('a trending song', () => {
    const PICK = {
      title: 'Hit',
      artist: 'Star',
      link: 'https://www.instagram.com/reel/C9/',
      trending: { reels: 1200, isTrending: true, nicheTop20: 7, niche: '#fpv #fpvdrone' },
    };

    it('answers no_trending until the trending pick is built', () => {
      const bench = usual();
      bench.run(NAMED);
      const before = bench.record();
      const ran = bench.run(['--trending', '--from', 'trending', '--by', 'editor']);
      expect(ran).toMatchObject({
        status: 1,
        line: { ok: false, code: 'no_trending', message: "Trending picks aren't built yet." },
      });
      expect(bench.record().songFailure).toMatchObject({
        asked: 'a trending song',
        code: 'no_trending',
      });
      expect({ ...bench.record(), songFailure: null }).toEqual(before);
      expect(bench.getterCalls()).toHaveLength(1);
    });

    it('gets the song the pick names, with its numbers in the record', () => {
      const bench = usual();
      bench.scenario({ full: bench.songs.get('main'), trending: PICK });
      const ran = bench.run(
        ['--trending', '--from', 'trending', '--by', 'editor', '--niche', '#fpv #fpvdrone'],
        {
          MUSIC_TRENDING_PICK: TRENDING,
        },
      );
      expect(ran.line).toMatchObject({
        ok: true,
        title: 'Hit',
        artist: 'Star',
        trending: PICK.trending,
        part: { startMs: 20_100 },
      });
      // The song is asked for by its name, not the link the pick also had.
      expect(bench.getterCalls()[0]).toMatchObject({ title: 'Hit', artist: 'Star', link: null });
      const record = bench.record();
      expect(record.song).toMatchObject({
        title: 'Hit',
        artist: 'Star',
        asked: { from: 'trending', file: null, url: null, by: 'editor' },
        trending: PICK.trending,
      });
      expect(record.picked).toBe('song');
      // What the pick was told: the client, the niche, the cut and the plan’s tempo and drop.
      expect(bench.trendingCalls()).toEqual([
        {
          clientId: createHash('sha1').update('Horizon FPV').digest('hex').slice(0, 12),
          client: 'Horizon FPV',
          niche: '#fpv #fpvdrone',
          lengthMs: 15_000,
          cutBpm: 120,
          dropMs: 7_000,
          dataDir: join(bench.home, '.studio-engine'),
          cacheDir: join(bench.home, '.studio-engine', 'songs-cache'),
        },
      ]);
    });

    it('puts the pick’s note in the line and passes its event on', () => {
      const bench = usual();
      const event = {
        type: 'music.song.trending',
        at: '2026-10-25T12:00:00.000Z',
        niche: '#fpv #fpvdrone',
        looked: 3,
        pick: { title: 'Hit', artist: 'Star' },
      };
      bench.scenario({
        full: bench.songs.get('main'),
        trending: { ...PICK, note: 'None of the 3 songs fits the cut.', event },
      });
      const ran = bench.run(['--trending', '--niche', '#fpv #fpvdrone'], {
        MUSIC_TRENDING_PICK: TRENDING,
      });
      expect(ran.line.ok).toBe(true);
      expect(String(ran.line.note)).toMatch(/^None of the 3 songs fits the cut\./);
      expect(ran.line.trendingEvent).toEqual(event);
      // A named song has no pick, so no event.
      expect(bench.run(NAMED).line).toMatchObject({ note: null, trendingEvent: null });
    });

    it('takes the niche from the client’s style first, then from --niche', () => {
      const bench = usual();
      bench.scenario({
        full: bench.songs.get('main'),
        trendingFail: { code: 'no_trending', message: 'Stop here.' },
      });
      const env = { MUSIC_TRENDING_PICK: TRENDING };
      mkdirSync(bench.file('style'), { recursive: true });
      writeFileSync(
        bench.file('style/style.md'),
        '# Style: Horizon FPV\n\n- Music: upbeat\n- Reels niche: #fpv #fpvdrone @falconfpv (a guess, edit it)\n',
      );
      bench.run(['--trending', '--niche', '#other'], env);
      bench.run(['--trending'], env);
      rmSync(bench.file('style/style.md'));
      bench.run(['--trending', '--niche', '#other'], env);
      bench.run(['--trending'], env);
      expect(bench.trendingCalls().map((call) => call.niche)).toEqual([
        '#fpv #fpvdrone @falconfpv',
        '#fpv #fpvdrone @falconfpv',
        '#other',
        null,
      ]);
    });

    it('passes the pick’s own failures on, as the song codes they are', () => {
      const bench = usual();
      const env = { MUSIC_TRENDING_PICK: TRENDING };
      bench.scenario({
        full: bench.songs.get('main'),
        trendingFail: { code: 'needs_key', message: 'No Apify key.' },
      });
      expect(bench.run(['--trending'], env)).toMatchObject({
        status: 2,
        line: { ok: false, code: 'needs_key', message: 'No Apify key.' },
      });
      bench.scenario({
        full: bench.songs.get('main'),
        trendingFail: { code: 'weird', message: 'Broke.' },
      });
      expect(bench.run(['--trending'], env).line).toMatchObject({ ok: false, code: 'failed' });
      // A pick that names no song is no_trending.
      bench.scenario({
        full: bench.songs.get('main'),
        trending: { title: '', artist: '', link: null },
      });
      expect(bench.run(['--trending'], env).line).toMatchObject({ ok: false, code: 'no_trending' });
      expect(bench.getterCalls()).toEqual([]);
    });
  });

  describe('a trending song picked by the real pick (Apify answered by a fake)', () => {
    const KEY = 'apify_api_COMMANDTEST0123456789abcdef';
    const clientId = createHash('sha1').update('Horizon FPV').digest('hex').slice(0, 12);
    const HIT = { id: '901', song: 'Hit', artist: 'Star' };
    const ORIGINAL = { id: '902', song: 'Original audio', artist: 'ofek', original: true };

    function igReel(code: string, plays: number, music: typeof HIT & { original?: boolean }) {
      return {
        shortCode: code,
        id: `id-${code}`,
        type: 'Video',
        productType: 'clips',
        videoPlayCount: plays,
        timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        musicInfo: {
          artist_name: music.artist,
          song_name: music.song,
          uses_original_audio: music.original === true,
          audio_id: music.id,
        },
      };
    }

    const HASHTAGS = [
      ...Array.from({ length: 6 }, (_, i) => igReel(`H${i}`, 90_000 - i, HIT)),
      ...Array.from({ length: 2 }, (_, i) => igReel(`O${i}`, 50_000 - i, ORIGINAL)),
    ];
    const SOUNDS = [
      {
        rowType: 'sound',
        trackId: '901',
        title: 'Hit',
        artist: 'Star',
        isOriginalAudio: false,
        isTrending: true,
        trendRank: 4,
        totalReelsUsingSound: 12_345,
      },
    ];
    const NICHE_LINE =
      '# Style: Horizon FPV\n\n- Reels niche: #fpv #fpvdrone (a guess; edit it if it is wrong)\n';

    /** A bench whose scenario has Apify's answers and where the calls are logged. */
    function withApify(full?: string) {
      const bench = usual();
      const apifyLog = join(bench.root, 'apify.jsonl');
      writeFileSync(apifyLog, '');
      bench.scenario({
        full: full ?? bench.songs.get('main'),
        apifyLog,
        apify: { hashtags: HASHTAGS, sounds: SOUNDS },
      });
      mkdirSync(bench.file('style'), { recursive: true });
      writeFileSync(bench.file('style/style.md'), NICHE_LINE);
      const apifyCalls = () =>
        readFileSync(apifyLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      return { bench, apifyCalls };
    }

    const TRENDING_ARGS = ['--trending', '--from', 'trending', '--by', 'editor'];
    const REAL = { MUSIC_TRENDING_PICK: REAL_PICK, APIFY_TOKEN: KEY };

    it('cuts the song Instagram’s numbers pick, with those numbers in the record and the event in the line', () => {
      const { bench, apifyCalls } = withApify();
      const ran = bench.run(TRENDING_ARGS, REAL);
      expect(ran.line).toMatchObject({
        ok: true,
        title: 'Hit',
        artist: 'Star',
        trending: { reels: 12_345, isTrending: true, nicheTop20: 6, niche: '#fpv #fpvdrone' },
        note: null,
        trendingEvent: {
          type: 'music.song.trending',
          niche: '#fpv #fpvdrone',
          looked: 1,
          pick: { title: 'Hit', artist: 'Star' },
        },
      });
      songTrendingEventSchema.parse(ran.line.trendingEvent);
      expect(bench.record().song).toMatchObject({
        title: 'Hit',
        artist: 'Star',
        asked: { from: 'trending', file: null, url: null, by: 'editor' },
        trending: { reels: 12_345, isTrending: true, nicheTop20: 6, niche: '#fpv #fpvdrone' },
      });
      expect(bench.record().picked).toBe('song');

      // The niche is the style's line without the guess mark; Apify got the key in a header only.
      const calls = apifyCalls();
      expect(calls.map((call) => call.actor)).toEqual([
        'apify~instagram-hashtag-scraper',
        'memo23~instagram-audio-scraper',
      ]);
      expect(calls[0]).toMatchObject({
        auth: `Bearer ${KEY}`,
        body: { hashtags: ['fpv', 'fpvdrone'], resultsType: 'reels' },
      });
      expect(calls[1]).toMatchObject({ body: { trackIds: ['901'] } });
      expect(ran.stdout + ran.stderr).not.toContain(KEY);

      // The pick measured the song with the getter, then the command got it by name again.
      expect(bench.getterCalls().map((call) => [call.title, call.artist])).toEqual([
        ['Hit', 'Star'],
        ['Hit', 'Star'],
      ]);
      expect(bench.getterCalls()[0]?.cacheDir).toBe(
        join(bench.home, '.studio-engine', 'songs-cache'),
      );

      // The week's lookup is kept in the contract's file.
      const cache = trendingCacheSchema.parse(
        JSON.parse(
          readFileSync(join(bench.home, '.studio-engine', trendingCacheFile(clientId)), 'utf8'),
        ),
      );
      expect(cache).toMatchObject({ clientId, niche: '#fpv #fpvdrone' });
      expect(cache.sounds).toEqual([
        expect.objectContaining({ title: 'Hit', reels: 12_345, nicheTop20: 6, isTrending: true }),
      ]);
      bench.expectTidy();
    });

    it('asks Apify once a week: the second pick reads the cache', () => {
      const { bench, apifyCalls } = withApify();
      bench.run(TRENDING_ARGS, REAL);
      expect(apifyCalls()).toHaveLength(2);
      const again = bench.run(TRENDING_ARGS, REAL);
      expect(again.line).toMatchObject({ ok: true, title: 'Hit', trending: { reels: 12_345 } });
      expect(apifyCalls()).toHaveLength(2);
      // It also works with no key, the lookup being cached.
      const keyless = bench.run(TRENDING_ARGS, { MUSIC_TRENDING_PICK: REAL_PICK });
      expect(keyless.line.ok).toBe(true);
      expect(apifyCalls()).toHaveLength(2);
    });

    it('says in the line when the song does not fit the cut, and still cuts it', () => {
      const flat = (() => {
        const dir = mkdtempSync(join(tmpdir(), 'studio-song-flat-'));
        temps.push(dir);
        const file = join(dir, 'flat.m4a');
        writeSong(file, 40, null);
        return file;
      })();
      const { bench } = withApify(flat);
      const ran = bench.run(TRENDING_ARGS, REAL);
      expect(ran.line.ok).toBe(true);
      expect(String(ran.line.note)).toContain(
        'The one song rising on Reels in #fpv #fpvdrone does not fit the cut (it has no clear drop), but it is the pick.',
      );
      expect(ran.line.trendingEvent).toMatchObject({ looked: 1, pick: { title: 'Hit' } });
      expect(bench.record().song?.title).toBe('Hit');
    });

    it('is needs_key with no key, asking nothing, and leaves the earlier pick as it was', () => {
      const { bench, apifyCalls } = withApify();
      bench.run(NAMED);
      const before = bench.record();
      const ran = bench.run(TRENDING_ARGS, { MUSIC_TRENDING_PICK: REAL_PICK });
      expect(ran).toMatchObject({
        status: 2,
        line: { ok: false, code: 'needs_key', message: expect.stringContaining('APIFY_TOKEN') },
      });
      expect(bench.record().songFailure).toMatchObject({
        asked: 'a trending song',
        code: 'needs_key',
      });
      expect({ ...bench.record(), songFailure: null }).toEqual(before);
      expect(apifyCalls()).toEqual([]);
    });

    it('is no_trending with no niche in the style or the call, naming the client', () => {
      const { bench, apifyCalls } = withApify();
      rmSync(bench.file('style/style.md'));
      const ran = bench.run(TRENDING_ARGS, REAL);
      expect(ran).toMatchObject({
        status: 1,
        line: {
          ok: false,
          code: 'no_trending',
          message: "Add a Reels niche line to Horizon FPV's style, or name a song.",
        },
      });
      expect(apifyCalls()).toEqual([]);
      // The run's --niche is used when the style has none.
      const named = bench.run([...TRENDING_ARGS, '--niche', '#fpv #fpvdrone'], REAL);
      expect(named.line).toMatchObject({ ok: true, trending: { niche: '#fpv #fpvdrone' } });
    });
  });

  describe('the same song again', () => {
    it('cuts a new part from the kept download, without getting it again', () => {
      const bench = usual();
      const first = bench.run([...NAMED, '--file', 'IMG_4412.PNG']);
      const record = bench.record();
      expect(first.line.reused).toBe(false);

      // A revise note changed the cut: plan.json says so, and the run calls song again.
      bench.writePlan(plan(25_000));
      bench.scenario({
        full: bench.songs.get('main'),
        fail: { code: 'blocked', message: 'Offline.' },
      });
      const again = bench.run([
        '--title',
        'Fake Song',
        '--artist',
        'Fake Artist',
        '--from',
        'note',
        '--by',
        'you',
      ]);
      expect(again.line).toMatchObject({ ok: true, reused: true, lengthMs: 25_000, cutMs: 25_000 });
      expect(bench.getterCalls()).toHaveLength(1);
      // 20.1 s + 25 s is past the song's end: the window slides earlier and still holds the drop.
      const part = again.line.part as { startMs: number; endMs: number };
      expect(part.endMs - part.startMs).toBe(25_000);
      expect(part.endMs).toBeLessThanOrEqual(40_100);
      expect(part.startMs).toBe(14_100);
      // The drop is where the loudness steps, 20 s into the song, about 5.9 s into the part.
      expect(Math.abs((again.line.dropMs as number) - 5_900)).toBeLessThanOrEqual(100);
      expect(Math.abs(probeMs(bench.file(MUSIC_FILES.song)) - 25_000)).toBeLessThan(100);
      expect(bench.bytes(MUSIC_FILES.preview).equals(bench.bytes(MUSIC_FILES.song))).toBe(true);

      // The song is the same: how it was asked for stays, the part and the line follow the part.
      const next = bench.record();
      expect(next.song).toMatchObject({
        title: record.song?.title,
        asked: record.song?.asked,
        source: record.song?.source,
        gotAt: record.song?.gotAt,
        part: { startMs: 14_100, endMs: 39_100, how: 'measured' },
      });
      expect(next.song?.instagramLine).toContain('start at 0:14.');
      expect(next.picks).toHaveLength(1);
      expect(next.plan?.lengthMs).toBe(25_000);
      expect(next.songFailure).toBeNull();
    });

    it('knows the song by the record’s own words, case apart, and by its link', () => {
      const bench = usual();
      bench.run(NAMED);
      bench.scenario({
        full: bench.songs.get('main'),
        fail: { code: 'blocked', message: 'Offline.' },
      });
      expect(bench.run(['--title', 'fake song', '--artist', 'FAKE ARTIST']).line.reused).toBe(true);
      expect(bench.run(['--title', 'Fake Song']).line.reused).toBe(true);
      expect(bench.run(['--title', 'Fake Song', '--version', 'sped up']).line.ok).toBe(false);
      expect(bench.run(['--title', 'Fake Song', '--artist', 'Another Artist']).line.ok).toBe(false);
      expect(bench.run(['--link', 'https://www.youtube.com/watch?v=fake0000001']).line.reused).toBe(
        true,
      );
      expect(bench.run(['--link', 'https://www.youtube.com/watch?v=other']).line.ok).toBe(false);
      expect(bench.run(['--trending']).line.ok).toBe(false);
    });

    it('gets a different song when asked for one', () => {
      const bench = usual();
      bench.run(NAMED);
      bench.scenario({ full: sharedSong('second', 40, 10), title: 'Second', artist: 'Band' });
      bench.beats(40, 10);
      const ran = bench.run([
        '--title',
        'Second',
        '--artist',
        'Band',
        '--from',
        'note',
        '--by',
        'you',
      ]);
      expect(ran.line).toMatchObject({ ok: true, reused: false, part: { startMs: 10_100 } });
      const record = bench.record();
      expect(record.song).toMatchObject({ title: 'Second', asked: { from: 'note', by: 'you' } });
      expect(record.picks.map((pick) => pick.id)).toEqual(['song']);
    });

    it('picks the song again when something else was picked after it', () => {
      const bench = usual();
      bench.run(NAMED);
      const record = bench.record();
      writeFileSync(
        bench.file(MUSIC_FILES.record),
        JSON.stringify({
          ...record,
          picked: 'off',
          picks: [...record.picks, { id: 'off', at: record.picks[0]?.at }],
        }),
      );
      bench.run(NAMED);
      expect(bench.record().picks.map((pick) => pick.id)).toEqual(['song', 'off', 'song']);
    });
  });

  describe('with the rest of the script', () => {
    it('leaves a record Make music instead and Pick can go on from', () => {
      const bench = usual();
      bench.run(NAMED);
      const pick = (target: string) =>
        spawnSync(process.execPath, [MUSIC_SCRIPT, 'pick', bench.editDir, target], {
          encoding: 'utf8',
          env: bench.env(),
        });
      const off = JSON.parse(pick('off').stdout.trim());
      expect(off).toMatchObject({ ok: true, id: 'off', lengthMs: 15_000 });
      expect(bench.bytes(MUSIC_FILES.preview).equals(bench.bytes(MUSIC_FILES.song))).toBe(false);
      const back = JSON.parse(pick('song').stdout.trim());
      expect(back).toMatchObject({ ok: true, id: 'song', lengthMs: 15_000 });
      expect(bench.bytes(MUSIC_FILES.preview).equals(bench.bytes(MUSIC_FILES.song))).toBe(true);
      // The plan is there, so a make works from it (the fake path, no network).
      const made = spawnSync(process.execPath, [MUSIC_SCRIPT, 'make', bench.editDir, '--fake'], {
        encoding: 'utf8',
        env: bench.env(),
      });
      expect(JSON.parse(made.stdout.trim())).toMatchObject({
        ok: true,
        id: 'v1',
        lengthMs: 15_000,
      });
      expect(bench.record()).toMatchObject({ source: 'made', picked: 'v1' });
    });

    it('does not run while another call holds the lock, and records nothing', () => {
      const bench = usual();
      writeFileSync(
        bench.file(MUSIC_FILES.lock),
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
      const ran = bench.run(NAMED);
      expect(ran.line).toMatchObject({ ok: false, code: 'failed' });
      expect(String(ran.line.message)).toMatch(/already being made or picked/);
      expect(existsSync(bench.file(MUSIC_FILES.record))).toBe(false);
      expect(bench.getterCalls()).toEqual([]);
    });

    it('clears away what a call that was killed left behind', () => {
      const bench = usual();
      mkdirSync(bench.file('music/.song-99999'), { recursive: true });
      writeFileSync(bench.file('music/.song-99999/song.wav'), 'half a file');
      expect(bench.run(NAMED).line.ok).toBe(true);
      bench.expectTidy();
    });
  });

  it.skipIf(process.env.STUDIO_TEST_HYPERFRAMES !== '1')(
    'finds the drop with the real beat finder (npx hyperframes audio)',
    () => {
      const bench = new Bench();
      const file = join(bench.root, 'real.m4a');
      ff([
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='0.3*sin(2*PI*220*t)*(0.4+0.6*lt(mod(t,0.5),0.1))+if(gte(t,20),0.5*sin(2*PI*110*t)*(0.3+0.7*lt(mod(t,0.5),0.15)),0)':s=44100:d=40",
        '-ac',
        '2',
        file,
      ]);
      bench.scenario({ full: file });
      bench.writePlan();
      const realHome = process.env.HOME ?? bench.home;
      const ran = bench.run(NAMED, { HOME: realHome, MUSIC_HYPERFRAMES: '' });
      const part = ran.line.part as { startMs: number };
      expect(ran.line.ok).toBe(true);
      expect(Math.abs(part.startMs - 20_000)).toBeLessThan(600);
      expect((ran.line.beats as number[]).length).toBeGreaterThan(20);
    },
    180_000,
  );
});
