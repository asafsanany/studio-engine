import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MUSIC_EXIT_CODES,
  MUSIC_FILES,
  MUSIC_LIMITS,
  type MusicPlan,
  type MusicRecord,
  type MusicScriptLine,
  musicExitCode,
  musicPlanSchema,
  musicRecordSchema,
  musicScriptLineSchema,
  nextVersionId as sharedNextVersionId,
} from '@studio/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ALWAYS_AVOID,
  type CompositionChunk,
  ELEVENLABS,
  EXIT,
  emptyRecord,
  exitCodeFor,
  FILES,
  failureFor,
  LIMITS,
  LOUDNESS,
  loudnessGain,
  nextVersionId,
  parseArgs,
  planProblem,
  readKey,
  redact,
  restyledPlan,
  toComposition,
  versionDescribe,
} from '../../assets/music/make-music.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { MUSIC_SCRIPT } from './music-assets.js';

// The music script (assets/music/make-music.mjs): its arguments, its checks of a plan against the
// shared contract, how it maps a plan to ElevenLabs' and reads ElevenLabs' refusals, and every
// subcommand run for real in a temp job folder: on the fake path (an ffmpeg tone, no network) and
// against a local stub of ElevenLabs (MUSIC_API_BASE), with what it writes read back through the
// shared schemas. No test ever reads the real key: every run gets its own HOME.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn(
    'make-music.test.ts: ffmpeg/ffprobe not found on PATH or in /opt/homebrew/bin; skipping the runs that need them (brew install ffmpeg)',
  );
}

/** A short plan, so the tones are quick to make: 6 s in two sections. */
function shortPlan(overrides: Partial<MusicPlan> = {}): MusicPlan {
  return {
    lengthMs: 6_000,
    styles: ['intense cinematic electronic', '120 BPM'],
    avoid: ['vocals'],
    sections: [
      { name: 'Build', ms: 3_000, styles: ['rising'], avoid: [] },
      { name: 'Drop', ms: 3_000, styles: ['full drop'], avoid: [] },
    ],
    describe: 'Intense cinematic electronic, 120 BPM. Drops at 0:03.',
    ...overrides,
  };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-music-'));
  temps.push(dir);
  return dir;
}

/** `<tmp>/Client/Job/edit` with a plan (none for `null`), as the edit run leaves it before `make`. */
function jobFolder(plan: unknown = shortPlan()): { jobDir: string; editDir: string } {
  const jobDir = join(tempDir(), 'Horizon FPV', 'Demo');
  const editDir = join(jobDir, 'edit');
  mkdirSync(join(editDir, 'music'), { recursive: true });
  if (plan !== null) writeFileSync(join(editDir, MUSIC_FILES.plan), JSON.stringify(plan));
  return { jobDir, editDir };
}

/** A HOME for one run: with video-use's .env holding `key`, or none. */
function homeWith(key: string | null): string {
  const home = tempDir();
  if (key !== null) {
    mkdirSync(join(home, 'Developer', 'video-use'), { recursive: true });
    writeFileSync(
      join(home, 'Developer', 'video-use', '.env'),
      `# video-use\nELEVENLABS_API_KEY=${key}\n`,
    );
  }
  return home;
}

/** A key that looks like ElevenLabs' and is nobody's. */
function testKey(): string {
  return `sk_test_${randomBytes(16).toString('hex')}`;
}

/** The environment without anything that could reach the real ElevenLabs or change the script. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === 'ELEVENLABS_API_KEY' || name.startsWith('MUSIC_')) continue;
    env[name] = value;
  }
  // Nothing listens on the discard port: a run that tries the network fails fast.
  return {
    ...env,
    HOME: homeWith(null),
    MUSIC_API_BASE: 'http://127.0.0.1:9',
    MUSIC_RETRY_MS: '0',
  };
}

interface Ran {
  status: number | null;
  line: MusicScriptLine;
  stdout: string;
  stderr: string;
}

function parseRun(status: number | null, stdout: string, stderr: string): Ran {
  const lines = stdout.trim().split('\n');
  expect(lines, `one line on stdout: ${stdout}${stderr}`).toHaveLength(1);
  const line = musicScriptLineSchema.parse(JSON.parse(lines[0] ?? ''));
  // The exit code is the shared contract's for the line.
  expect(status).toBe(line.ok ? MUSIC_EXIT_CODES.ok : musicExitCode(line.code));
  return { status, line, stdout, stderr };
}

/** Runs the script as the edit run would (no network: see cleanEnv), and waits for it. */
function music(args: string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync(process.execPath, [MUSIC_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...cleanEnv(), ...env },
    timeout: 60_000,
  });
  return parseRun(result.status, result.stdout, result.stderr);
}

/** The same, without blocking: for runs against the stub server in this process. */
function musicAsync(args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [MUSIC_SCRIPT, ...args], {
      env: { ...cleanEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => {
      try {
        done(parseRun(status, stdout, stderr));
      } catch (err) {
        fail(err);
      }
    });
  });
}

function readRecord(editDir: string): MusicRecord {
  return musicRecordSchema.parse(
    JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')),
  );
}

function lengthMs(file: string): number {
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

/** Integrated loudness (LUFS) and true peak (dBTP), as ffmpeg's ebur128 measures them. */
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

function writeAudio(path: string, source: string, extra: string[] = []): void {
  const made = spawnSync(ffmpeg as string, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    source,
    ...extra,
    path,
  ]);
  expect(made.status, made.stderr.toString()).toBe(0);
}

function writeTone(path: string, sec: number): void {
  writeAudio(path, `sine=frequency=330:duration=${sec}`);
}

describe('the contract it shares', () => {
  it('names the same files, limits and exit codes as the shared contract', () => {
    expect(FILES).toEqual(MUSIC_FILES);
    expect(LIMITS).toEqual(MUSIC_LIMITS);
    expect(EXIT).toEqual(MUSIC_EXIT_CODES);
    expect(existsSync(MUSIC_SCRIPT)).toBe(true);
    expect(MUSIC_SCRIPT.endsWith(join('assets', 'music', 'make-music.mjs'))).toBe(true);
  });

  it('starts an empty record the schema reads', () => {
    expect(musicRecordSchema.parse(emptyRecord())).toEqual(emptyRecord());
  });

  it('checks a plan exactly as the shared schema does', () => {
    const plans: unknown[] = [
      shortPlan(),
      shortPlan({ lengthMs: 6_001 }),
      shortPlan({ styles: [] }),
      shortPlan({ styles: [''] }),
      shortPlan({ avoid: [3] as unknown as string[] }),
      shortPlan({ describe: 'x'.repeat(MUSIC_LIMITS.describeMax + 1) }),
      shortPlan({ describe: '' }),
      shortPlan({ sections: [] }),
      shortPlan({
        lengthMs: 4_000,
        sections: [
          { name: 'A', ms: 2_000, styles: [], avoid: [] },
          { name: 'B', ms: 2_000, styles: [], avoid: [] },
        ],
      }),
      shortPlan({ lengthMs: 2_000, sections: [{ name: 'A', ms: 2_000, styles: [], avoid: [] }] }),
      shortPlan({ sections: [{ name: '', ms: 6_000, styles: [], avoid: [] }] }),
      shortPlan({ sections: [{ name: 'A', ms: 6_000.5, styles: [], avoid: [] }] }),
      null,
      [],
      'plan',
    ];
    for (const plan of plans) {
      expect(planProblem(plan) === null, JSON.stringify(plan)).toBe(
        musicPlanSchema.safeParse(plan).success,
      );
    }
    expect(planProblem(shortPlan({ lengthMs: 6_001 }))).toBe(
      'the sections add up to 6000 ms, not lengthMs (6001 ms)',
    );
  });

  it('numbers versions like the shared rule', () => {
    for (const ids of [[], ['v1'], ['v3', 'v1'], ['v9', 'v10']]) {
      const record = { versions: ids.map((id) => ({ id })) };
      expect(nextVersionId(record)).toBe(
        sharedNextVersionId(record as unknown as Pick<MusicRecord, 'versions'>),
      );
    }
  });

  it('maps failure codes to exit codes as the shared contract does', () => {
    for (const code of [
      'no_credits',
      'no_access',
      'no_key',
      'down',
      'bad_plan',
      'failed',
    ] as const) {
      expect(exitCodeFor(code)).toBe(musicExitCode(code));
    }
    expect(exitCodeFor('no_credits')).toBe(2);
    expect(exitCodeFor('down')).toBe(3);
    expect(exitCodeFor('bad_plan')).toBe(1);
  });

  it('says what a version asked for with the plan’s shape', () => {
    const plan = shortPlan();
    expect(versionDescribe(plan, null)).toBe(plan.describe);
    expect(versionDescribe(plan, 'darker, more drums')).toBe(
      `You asked: darker, more drums. Same shape: ${plan.describe}`,
    );
    const longest = versionDescribe(
      shortPlan({ describe: 'x'.repeat(MUSIC_LIMITS.describeMax) }),
      'y'.repeat(MUSIC_LIMITS.askMax),
    );
    expect(longest.length).toBeLessThanOrEqual(MUSIC_LIMITS.versionDescribeMax);
  });
});

describe('the key', () => {
  it('is read from video-use’s .env first, then the environment, and is never printed', () => {
    const fileKey = testKey();
    const envKey = testKey();
    const home = homeWith(fileKey);
    const file = join(home, 'Developer', 'video-use', '.env');
    expect(readKey({ ELEVENLABS_API_KEY: envKey }, file)).toBe(fileKey);
    expect(readKey({ ELEVENLABS_API_KEY: envKey }, join(home, 'nope.env'))).toBe(envKey);
    expect(readKey({}, join(home, 'nope.env'))).toBeNull();
    writeFileSync(file, 'ELEVENLABS_API_KEY=\n');
    expect(readKey({ ELEVENLABS_API_KEY: ` ${envKey} ` }, file)).toBe(envKey);
    writeFileSync(file, `export ELEVENLABS_API_KEY="${fileKey}"\n`);
    expect(readKey({}, file)).toBe(fileKey);
  });

  it('is taken out of every message, whatever it looks like', () => {
    expect(redact('ElevenLabs said 401 for sk_abc123DEF_x')).toBe('ElevenLabs said 401 for sk_…');
    expect(redact('{"xi-api-key": "whatever-it-is"}')).toBe('{"xi-api-key": "[key]"}');
    const home = homeWith('plainkey0123456789abcdef');
    expect(readKey({}, join(home, 'Developer', 'video-use', '.env'))).toBe(
      'plainkey0123456789abcdef',
    );
    expect(redact('the key plainkey0123456789abcdef is wrong')).toBe('the key [key] is wrong');
  });
});

describe('the plan as ElevenLabs reads it', () => {
  const demo = (): MusicPlan => ({
    lengthMs: 39_000,
    styles: ['intense cinematic electronic', '120 BPM', 'big drop'],
    avoid: ['Vocals'],
    sections: [
      { name: 'Build', ms: 10_000, styles: ['sparse pulse'], avoid: ['kick drum'] },
      { name: 'Rise', ms: 8_000, styles: ['snare roll'], avoid: [] },
      { name: '[Drop] {now}', ms: 6_000, styles: ['big drop', 'heavy sub bass'], avoid: [] },
      { name: 'Golden', ms: 10_000, styles: [], avoid: [] },
      { name: '{}', ms: 5_000, styles: ['final hit'], avoid: [] },
    ],
    describe: 'Builds to a big drop at 0:18.',
  });

  it('is one chunk per section of exactly its length, instrumental, the later ones starting fresh', () => {
    const { chunks } = toComposition(demo());
    expect(chunks.map((chunk) => chunk.duration_ms)).toEqual([10_000, 8_000, 6_000, 10_000, 5_000]);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      '[Build]',
      '[Rise]',
      '[Drop now]',
      '[Golden]',
      '[Part 5]',
    ]);
    expect(chunks[0]).toEqual({
      text: '[Build]',
      duration_ms: 10_000,
      positive_styles: [
        'intense cinematic electronic',
        '120 BPM',
        'big drop',
        'sparse pulse',
        'instrumental',
      ],
      negative_styles: ['Vocals', 'singing', 'lyrics', 'kick drum'],
    });
    for (const chunk of chunks.slice(1)) {
      expect(chunk.context_adherence).toBe('low');
      for (const style of ALWAYS_AVOID) {
        expect(chunk.negative_styles.map((s) => s.toLowerCase())).toContain(style);
      }
    }
    // A section without styles carries the plan's.
    expect(chunks[3]?.positive_styles).toEqual(demo().styles);
    expect(chunks[2]?.positive_styles).toEqual(['big drop', 'heavy sub bass']);
  });

  it('keeps the plan’s own "instrumental" and caps a section name at 100 characters', () => {
    const plan = demo();
    plan.styles = ['solo piano', 'Instrumental'];
    plan.sections[0] = { name: 'n'.repeat(140), ms: 10_000, styles: [], avoid: [] };
    const [first] = toComposition(plan).chunks;
    expect(first?.positive_styles).toEqual(['solo piano', 'Instrumental']);
    expect(first?.text).toBe(`[${'n'.repeat(100)}]`);
  });

  it('restyles with /plan’s answer and keeps our names, lengths and avoid', () => {
    const plan = demo();
    const answer = {
      chunks: plan.sections.map((section, index) => ({
        text: `[Other ${index}]`,
        duration_ms: 7_800,
        positive_styles: [`dark ${section.name}`, 'heavier drums'],
        negative_styles: index === 1 ? ['bright pop'] : [],
        context_adherence: 'high',
      })),
    };
    const styled = restyledPlan(plan, 'darker, heavier drums', answer);
    expect(musicPlanSchema.safeParse(styled).success).toBe(true);
    expect(styled.styles).toEqual(['dark Build', 'heavier drums']);
    expect(styled.sections.map((section) => [section.name, section.ms])).toEqual(
      plan.sections.map((section) => [section.name, section.ms]),
    );
    expect(styled.sections[0]?.styles).toEqual([]);
    expect(styled.sections[1]).toMatchObject({
      styles: ['dark Rise', 'heavier drums'],
      avoid: ['bright pop'],
    });
    expect(styled.sections[0]?.avoid).toEqual(['kick drum']);
    // Mapped again: our lengths, low adherence after the first, never vocals.
    const { chunks } = toComposition(styled);
    expect(chunks.map((chunk) => chunk.duration_ms)).toEqual([10_000, 8_000, 6_000, 10_000, 5_000]);
    expect(chunks[1]?.context_adherence).toBe('low');
    expect(chunks[1]?.negative_styles).toEqual(['Vocals', 'singing', 'lyrics', 'bright pop']);
  });

  it('adds the words as a style when /plan’s answer has another shape', () => {
    const plan = demo();
    for (const answer of [null, {}, { chunks: [] }, { chunks: [{ positive_styles: ['x'] }] }]) {
      const styled = restyledPlan(plan, 'darker', answer);
      expect(styled.styles).toEqual([...plan.styles, 'darker']);
      expect(styled.sections).toEqual(plan.sections);
    }
  });
});

describe('ElevenLabs’ refusals', () => {
  const cases: [string, number, unknown, string, string | RegExp][] = [
    [
      'a wrong key (a 400, as the spike saw)',
      400,
      {
        detail: {
          type: 'authentication_error',
          code: 'invalid_api_key',
          message: 'API key is invalid.',
          status: 'invalid_api_key',
        },
      },
      'no_access',
      'ElevenLabs doesn’t accept the key in ~/Developer/video-use/.env: it says the key is invalid.',
    ],
    [
      'a key without the Music permission (older answer)',
      401,
      {
        detail: {
          status: 'missing_permissions',
          message: 'The API key you used is missing the permission music_generation.',
        },
      },
      'no_access',
      'The ElevenLabs key can’t make music: give it the Music permission at https://elevenlabs.io/app/settings/api-keys.',
    ],
    [
      'insufficient permissions',
      403,
      { detail: { type: 'authorization_error', code: 'insufficient_permissions' } },
      'no_access',
      /Music permission/,
    ],
    ['a plain 403', 403, 'Forbidden', 'no_access', /it says: Forbidden/],
    [
      'no credits',
      402,
      { detail: { type: 'payment_required', code: 'insufficient_credits', message: 'x' } },
      'no_credits',
      'ElevenLabs says this month’s credits are used up.',
    ],
    [
      'no credits (older answer)',
      401,
      { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } },
      'no_credits',
      'ElevenLabs says this month’s credits are used up.',
    ],
    [
      'a plan it cannot use',
      422,
      {
        detail: [
          {
            type: 'greater_than_equal',
            loc: ['body', 'composition_plan', 'chunks', 0, 'duration_ms'],
            msg: 'Input should be greater than or equal to 3000',
          },
        ],
      },
      'bad_plan',
      'ElevenLabs can’t use this plan: Input should be greater than or equal to 3000 (at composition_plan.chunks.0.duration_ms).',
    ],
    [
      'styles that name an artist',
      400,
      { detail: { status: 'bad_composition_plan', data: { composition_plan_suggestion: {} } } },
      'bad_plan',
      /name an artist or a song/,
    ],
    ['busy', 429, { detail: { type: 'rate_limit_error' } }, 'down', /busy/],
    ['down', 503, 'Service Unavailable', 'down', /answered 503/],
    [
      'anything else',
      409,
      { detail: { message: 'already running' } },
      'failed',
      /409: already running/,
    ],
  ];

  it.each(cases)('reads %s', (_name, status, body, code, message) => {
    const failure = failureFor(status, body);
    expect(failure.code).toBe(code);
    if (typeof message === 'string') expect(failure.message).toBe(message);
    else expect(failure.message).toMatch(message);
    expect(failure.retry).toBe(status === 429 || status >= 500);
  });

  it('never repeats a key it was sent back', () => {
    const failure = failureFor(401, { detail: { message: 'Key sk_live_abc123 is not allowed' } });
    expect(failure.message).not.toContain('sk_live_abc123');
  });
});

describe('the loudness', () => {
  it('is one gain to the target, cut back to keep the true peak under the ceiling', () => {
    expect(LOUDNESS).toEqual({ integratedLufs: -20, truePeakDbtp: -2 });
    expect(loudnessGain(-13.23, -0.06)).toBe(-6.77);
    expect(loudnessGain(-30, -12)).toBe(10);
    // Raising -30 to -20 would put a -6 peak at +4: only up to -2.
    expect(loudnessGain(-30, -6)).toBe(4);
  });
});

describe('the arguments', () => {
  it('reads every subcommand', () => {
    expect(parseArgs(['make', 'edit'])).toMatchObject({
      command: 'make',
      again: false,
      ask: null,
      by: 'edit',
      fake: false,
      target: null,
    });
    expect(
      parseArgs(['make', 'edit', '--again', '--ask', ' darker ', '--by', 'you', '--fake']),
    ).toMatchObject({ again: true, ask: 'darker', by: 'you', fake: true });
    expect(parseArgs(['make', 'edit'], { MUSIC_FAKE: '1' })).toMatchObject({ fake: true });
    expect(parseArgs(['pick', 'edit', 'v2'])).toMatchObject({ command: 'pick', target: 'v2' });
    expect(parseArgs(['pick', 'edit', 'off'])).toMatchObject({ target: 'off' });
    expect(parseArgs(['pick', 'edit', 'file'])).toMatchObject({ target: 'file' });
    expect(parseArgs(['pick', 'edit', 'series'])).toMatchObject({ target: 'series' });
    expect(parseArgs(['pick', 'edit', 'song'])).toMatchObject({ command: 'pick', target: 'song' });
    expect(parseArgs(['supplied', 'edit', 'Summer Vibes.mp3'])).toMatchObject({
      command: 'supplied',
      target: 'Summer Vibes.mp3',
    });
    expect(parseArgs(['none', 'edit', 'The style says no music.'])).toMatchObject({
      command: 'none',
      target: 'The style says no music.',
    });
  });

  it('takes the edit dir as an absolute path', () => {
    const args = parseArgs(['make', 'edit']);
    expect('editDir' in args && args.editDir).toBe(join(process.cwd(), 'edit'));
  });

  it('says what is wrong with a call it cannot use', () => {
    for (const argv of [
      [],
      ['play', 'edit'],
      ['make'],
      ['make', 'edit', 'extra'],
      ['make', 'edit', '--ask'],
      ['make', 'edit', '--ask', '   '],
      ['make', 'edit', '--ask', 'x'.repeat(MUSIC_LIMITS.askMax + 1)],
      ['make', 'edit', '--by', 'claude'],
      ['make', 'edit', '--loud'],
      ['pick', 'edit'],
      ['pick', 'edit', 'v0'],
      ['pick', 'edit', 'none'],
      ['pick', 'edit', 'v1', '--again'],
      ['supplied', 'edit'],
      ['none', 'edit'],
    ]) {
      expect(parseArgs(argv), argv.join(' ')).toHaveProperty('error');
    }
  });
});

describe.skipIf(!haveTools)('a run of the fake path', () => {
  it('makes v1 from plan.json, picks it and records it', () => {
    const { editDir } = jobFolder();
    const made = music(['make', editDir, '--fake']);
    expect(made).toMatchObject({ status: 0, line: { ok: true, id: 'v1', lengthMs: 6_000 } });

    const record = readRecord(editDir);
    expect(record).toMatchObject({
      v: 1,
      source: 'made',
      reason: null,
      file: null,
      plan: shortPlan(),
      picked: 'v1',
      making: null,
      failure: null,
    });
    expect(record.versions).toEqual([
      expect.objectContaining({
        id: 'v1',
        file: 'v1.mp3',
        describe: shortPlan().describe,
        ask: null,
        model: 'fake',
        lengthMs: 6_000,
        by: 'edit',
      }),
    ]);
    expect(record.picks.map((pick) => pick.id)).toEqual(['v1']);
    const v1 = join(editDir, 'music', 'v1.mp3');
    const preview = join(editDir, MUSIC_FILES.preview);
    expect(readFileSync(preview)).toEqual(readFileSync(v1));
    expect(Math.abs(lengthMs(preview) - 6_000)).toBeLessThan(150);
    // The lock is let go of, and no temp file is left behind.
    expect(existsSync(join(editDir, MUSIC_FILES.lock))).toBe(false);
  });

  it('makes v2 with words and a new seed, again from the record’s plan, and picks it', () => {
    const { editDir } = jobFolder();
    music(['make', editDir, '--fake']);
    // plan.json may be gone: --again then uses the record's.
    rmSync(join(editDir, MUSIC_FILES.plan));
    const made = music(['make', editDir, '--again', '--ask', 'darker, more drums', '--by', 'you'], {
      MUSIC_FAKE: '1',
    });
    expect(made).toMatchObject({ status: 0, line: { ok: true, id: 'v2', lengthMs: 6_000 } });

    const record = readRecord(editDir);
    expect(record.picked).toBe('v2');
    const [v1, v2] = record.versions;
    expect(v2).toMatchObject({
      id: 'v2',
      ask: 'darker, more drums',
      by: 'you',
      describe: `You asked: darker, more drums. Same shape: ${shortPlan().describe}`,
    });
    expect(v2?.seed).not.toBe(v1?.seed);
    // Each version sounds different on the fake path, so a pick is heard.
    expect(readFileSync(join(editDir, 'music', 'v2.mp3'))).not.toEqual(
      readFileSync(join(editDir, 'music', 'v1.mp3')),
    );
    expect(readFileSync(join(editDir, MUSIC_FILES.preview))).toEqual(
      readFileSync(join(editDir, 'music', 'v2.mp3')),
    );
  });

  it('makes --again from plan.json when the run changed it, and records the plan it used', () => {
    const { editDir } = jobFolder();
    music(['make', editDir, '--fake']);
    const longer = shortPlan({
      lengthMs: 7_000,
      sections: [
        { name: 'Build', ms: 3_000, styles: ['rising'], avoid: [] },
        { name: 'Drop', ms: 4_000, styles: ['full drop'], avoid: [] },
      ],
    });
    writeFileSync(join(editDir, MUSIC_FILES.plan), JSON.stringify(longer));
    expect(music(['make', editDir, '--again', '--fake']).line).toMatchObject({
      ok: true,
      id: 'v2',
      lengthMs: 7_000,
    });
    expect(readRecord(editDir).plan).toEqual(longer);

    // A plan.json that no longer fits is not passed over for the record's.
    writeFileSync(join(editDir, MUSIC_FILES.plan), JSON.stringify(shortPlan({ lengthMs: 9_000 })));
    expect(music(['make', editDir, '--again', '--fake']).line).toMatchObject({
      ok: false,
      code: 'bad_plan',
    });
  });

  it('picks a version again, or off as silence of the same length, with a fresh music.mp3', () => {
    const { editDir } = jobFolder();
    music(['make', editDir, '--fake']);
    music(['make', editDir, '--again', '--fake']);
    const preview = join(editDir, MUSIC_FILES.preview);
    const before = statSync(preview).mtimeMs;

    expect(music(['pick', editDir, 'v1'])).toMatchObject({
      status: 0,
      line: { ok: true, id: 'v1', lengthMs: 6_000 },
    });
    expect(readFileSync(preview)).toEqual(readFileSync(join(editDir, 'music', 'v1.mp3')));
    expect(statSync(preview).mtimeMs).toBeGreaterThanOrEqual(before);

    expect(music(['pick', editDir, 'off'])).toMatchObject({
      status: 0,
      line: { ok: true, id: 'off', lengthMs: 6_000 },
    });
    expect(Math.abs(lengthMs(preview) - 6_000)).toBeLessThan(150);
    const record = readRecord(editDir);
    expect(record.picked).toBe('off');
    expect(record.picks.map((pick) => pick.id)).toEqual(['v1', 'v2', 'v1', 'off']);
  });

  it('refuses a pick of a version that is not there, or before any music', () => {
    const { editDir } = jobFolder();
    expect(music(['pick', editDir, 'v1'])).toMatchObject({
      status: 1,
      line: { ok: false, code: 'failed' },
    });
    music(['make', editDir, '--fake']);
    const missing = music(['pick', editDir, 'v7']);
    expect(missing).toMatchObject({ status: 1, line: { ok: false, code: 'failed' } });
    expect(missing.line.ok === false && missing.line.message).toBe(
      'There is no v7 (the versions: v1).',
    );
    expect(readRecord(editDir).picked).toBe('v1');
  });

  it('fails without a key anywhere (no_key), and leaves silence of the plan’s length to play', () => {
    const { editDir } = jobFolder();
    const made = music(['make', editDir]);
    expect(made).toMatchObject({
      status: 2,
      line: {
        ok: false,
        code: 'no_key',
        message:
          'There is no ElevenLabs key: put it after ELEVENLABS_API_KEY= in ~/Developer/video-use/.env.',
      },
    });
    const record = readRecord(editDir);
    expect(record).toMatchObject({
      source: 'made',
      plan: shortPlan(),
      picked: null,
      picks: [],
      versions: [],
      making: null,
      failure: { id: 'v1', code: 'no_key' },
    });
    // The composition's music.mp3 is there, silent, so a version made later drops straight in…
    const preview = join(editDir, MUSIC_FILES.preview);
    expect(Math.abs(lengthMs(preview) - 6_000)).toBeLessThan(150);
    expect(loudness(preview).integrated).toBeLessThanOrEqual(-70);
    // …and off has a length.
    expect(music(['pick', editDir, 'off']).line).toMatchObject({ ok: true, lengthMs: 6_000 });
  });

  it('fails a plan that does not fit as bad_plan, and a later success clears it', () => {
    const { editDir } = jobFolder(shortPlan({ lengthMs: 7_000 }));
    const made = music(['make', editDir, '--fake']);
    expect(made).toMatchObject({ status: 1, line: { ok: false, code: 'bad_plan' } });
    expect(readRecord(editDir)).toMatchObject({
      plan: null,
      failure: { id: 'v1', code: 'bad_plan' },
    });
    // No plan, no length: nothing to play yet.
    expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(false);

    writeFileSync(join(editDir, MUSIC_FILES.plan), JSON.stringify(shortPlan()));
    expect(music(['make', editDir, '--fake']).line).toMatchObject({ ok: true, id: 'v1' });
    expect(readRecord(editDir).failure).toBeNull();
  });

  it('fails without a plan, and --again without plan.json or a record’s plan', () => {
    const { editDir } = jobFolder(null);
    expect(music(['make', editDir, '--fake']).line).toMatchObject({ ok: false, code: 'bad_plan' });
    expect(music(['make', editDir, '--again', '--fake']).line).toMatchObject({
      ok: false,
      code: 'bad_plan',
    });
  });

  it('records a music file the folder brought, made into an mp3 when it is not one', () => {
    const { jobDir, editDir } = jobFolder(null);
    writeTone(join(jobDir, 'Summer Vibes.wav'), 2);
    const done = music(['supplied', editDir, 'Summer Vibes.wav']);
    expect(done.status).toBe(0);
    expect(done.line).toMatchObject({ ok: true, id: 'file' });
    expect(done.line.ok && Math.abs((done.line.lengthMs ?? 0) - 2_000)).toBeLessThan(150);
    expect(readRecord(editDir)).toMatchObject({
      source: 'supplied',
      file: 'Summer Vibes.wav',
      picked: 'file',
      plan: null,
      versions: [],
    });
    expect(lengthMs(join(editDir, MUSIC_FILES.preview))).toBeGreaterThan(1_800);
  });

  it('picks the folder’s music file again after No music', () => {
    const { jobDir, editDir } = jobFolder(null);
    writeTone(join(jobDir, 'Summer Vibes.mp3'), 2);
    music(['supplied', editDir, 'Summer Vibes.mp3']);
    const preview = join(editDir, MUSIC_FILES.preview);

    // Off: silence as long as the file.
    const off = music(['pick', editDir, 'off']);
    expect(off).toMatchObject({ status: 0, line: { ok: true, id: 'off' } });
    expect(off.line.ok && Math.abs((off.line.lengthMs ?? 0) - 2_000)).toBeLessThan(150);
    expect(loudness(preview).integrated).toBeLessThanOrEqual(-70);

    const back = music(['pick', editDir, 'file']);
    expect(back).toMatchObject({ status: 0, line: { ok: true, id: 'file' } });
    expect(back.line.ok && Math.abs((back.line.lengthMs ?? 0) - 2_000)).toBeLessThan(150);
    expect(readFileSync(preview)).toEqual(readFileSync(join(jobDir, 'Summer Vibes.mp3')));
    const record = readRecord(editDir);
    expect(record).toMatchObject({ source: 'supplied', file: 'Summer Vibes.mp3', picked: 'file' });
    expect(record.picks.map((pick) => pick.id)).toEqual(['file', 'off', 'file']);

    // Not the series' (this job brought a file), and not once the file is gone.
    expect(music(['pick', editDir, 'series'])).toMatchObject({
      status: 1,
      line: { ok: false, code: 'failed', message: 'There is no series music to pick.' },
    });
    rmSync(join(jobDir, 'Summer Vibes.mp3'));
    expect(music(['pick', editDir, 'file'])).toMatchObject({
      status: 1,
      line: {
        ok: false,
        code: 'failed',
        message: 'There is no file "Summer Vibes.mp3" in the job folder.',
      },
    });
    expect(readRecord(editDir).picked).toBe('file');
  });

  it('picks the series’ music again after No music, and refuses file and series for made music', () => {
    const { editDir } = jobFolder(null);
    mkdirSync(join(editDir, 'series'), { recursive: true });
    writeTone(join(editDir, 'series', 'theme.mp3'), 2);
    music(['series', editDir, 'edit/series/theme.mp3']);
    expect(music(['pick', editDir, 'off']).line).toMatchObject({ ok: true, id: 'off' });
    expect(music(['pick', editDir, 'series']).line).toMatchObject({ ok: true, id: 'series' });
    expect(readFileSync(join(editDir, MUSIC_FILES.preview))).toEqual(
      readFileSync(join(editDir, 'series', 'theme.mp3')),
    );
    expect(readRecord(editDir).picks.map((pick) => pick.id)).toEqual(['series', 'off', 'series']);

    const made = jobFolder();
    music(['make', made.editDir, '--fake']);
    expect(music(['pick', made.editDir, 'file']).line).toMatchObject({
      ok: false,
      code: 'failed',
      message: 'There is no music file from the job folder to pick.',
    });
    expect(readRecord(made.editDir).picked).toBe('v1');
  });

  describe('picking the song (Songs)', () => {
    /** A job whose `song` call left a record with a song and its part (edit/music/song.mp3), here 3 s of a tone. */
    function jobWithSong({ file = true }: { file?: boolean } = {}) {
      const folder = jobFolder(null);
      if (file) writeTone(join(folder.editDir, MUSIC_FILES.song), 3);
      const record = {
        ...emptyRecord(),
        source: 'song',
        picked: 'song',
        picks: [{ id: 'song', at: '2026-10-25T21:03:00.000Z' }],
        song: {
          title: 'נתתי לך בית',
          artist: 'Ofek Adanek',
          version: null,
          asked: { from: 'screenshot', file: 'IMG_4412.PNG', url: null, by: 'brief' },
          source: {
            site: 'youtube-music',
            via: 'yt-dlp',
            url: 'https://music.youtube.com/watch?v=Zq3Rk1pXo9A',
            id: 'Zq3Rk1pXo9A',
          },
          fullMs: 192_000,
          part: { startMs: 42_000, endMs: 45_000, how: 'measured' },
          trending: null,
          file: 'song.mp3',
          instagramLine:
            'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42.',
          gotAt: '2026-10-25T21:03:00.000Z',
        },
      };
      writeFileSync(join(folder.editDir, MUSIC_FILES.record), `${JSON.stringify(record)}\n`);
      return folder;
    }

    it('puts the song’s part back after No music, answers the part’s length and records the pick', () => {
      const { editDir } = jobWithSong();
      // No music is silence as long as the song's part (the record has no plan and no version).
      expect(music(['pick', editDir, 'off'])).toMatchObject({
        status: 0,
        line: { ok: true, id: 'off', lengthMs: 3_000 },
      });
      const preview = join(editDir, MUSIC_FILES.preview);
      expect(Math.abs(lengthMs(preview) - 3_000)).toBeLessThan(150);

      expect(music(['pick', editDir, 'song'])).toMatchObject({
        status: 0,
        line: { ok: true, id: 'song', lengthMs: 3_000 },
      });
      expect(readFileSync(preview)).toEqual(readFileSync(join(editDir, MUSIC_FILES.song)));
      const record = readRecord(editDir);
      expect(record.picked).toBe('song');
      expect(record.picks.map((pick) => pick.id)).toEqual(['song', 'off', 'song']);
      expect(record.song?.title).toBe('נתתי לך בית');
    });

    it('is refused without a song in the record, or without its file', () => {
      const made = jobFolder();
      music(['make', made.editDir, '--fake']);
      expect(music(['pick', made.editDir, 'song']).line).toMatchObject({
        ok: false,
        code: 'failed',
        message: 'There is no song to pick.',
      });
      expect(readRecord(made.editDir).picked).toBe('v1');

      const noFile = jobWithSong({ file: false });
      expect(music(['pick', noFile.editDir, 'song']).line).toMatchObject({
        ok: false,
        code: 'failed',
        message: 'There is no song to pick.',
      });
    });
  });

  it('records the series kit’s music', () => {
    const { editDir } = jobFolder(null);
    mkdirSync(join(editDir, 'series'), { recursive: true });
    writeTone(join(editDir, 'series', 'theme.mp3'), 2);
    expect(music(['series', editDir, 'edit/series/theme.mp3']).line).toMatchObject({
      ok: true,
      id: 'series',
    });
    expect(readRecord(editDir)).toMatchObject({
      source: 'series',
      file: 'edit/series/theme.mp3',
      picked: 'series',
    });
    expect(readFileSync(join(editDir, MUSIC_FILES.preview))).toEqual(
      readFileSync(join(editDir, 'series', 'theme.mp3')),
    );
  });

  it('refuses a file that is not in the job folder', () => {
    const { jobDir, editDir } = jobFolder(null);
    writeTone(join(jobDir, '..', 'Other.mp3'), 1);
    expect(music(['supplied', editDir, '../Other.mp3'])).toMatchObject({
      status: 1,
      line: { ok: false, code: 'failed', message: '"../Other.mp3" is not in the job folder.' },
    });
    expect(music(['supplied', editDir, 'Nope.mp3']).line).toMatchObject({ ok: false });
    expect(existsSync(join(editDir, MUSIC_FILES.record))).toBe(false);
  });

  it('records no music and whose rule it is', () => {
    const { editDir } = jobFolder(null);
    const rule = 'The client’s style says no music under the lawyer’s answers.';
    expect(music(['none', editDir, rule])).toMatchObject({
      status: 0,
      line: { ok: true, id: 'none', lengthMs: null },
    });
    expect(readRecord(editDir)).toMatchObject({ source: 'none', reason: rule, picked: null });
  });

  // U21: music is made only when the job asks for it. `none --plan` is how the edit run says "not
  // asked for" and still leaves Make music in Review a plan to make from.
  describe('none --plan: music was not asked for', () => {
    const reason = 'Music was not asked for.';

    it('parses --plan for none only', () => {
      expect(parseArgs(['none', 'edit', reason, '--plan'])).toMatchObject({
        command: 'none',
        target: reason,
        plan: true,
      });
      expect(parseArgs(['none', 'edit', reason])).toMatchObject({ command: 'none', plan: false });
      expect(parseArgs(['--plan', 'none', 'edit', reason])).toMatchObject({ plan: true });
      for (const command of [
        ['make', 'edit', '--plan'],
        ['pick', 'edit', 'off', '--plan'],
        ['supplied', 'edit', 'a.mp3', '--plan'],
        ['song', 'edit', '--trending', '--plan'],
        ['song-note', 'edit', '--original', '', '--plan'],
      ]) {
        expect(parseArgs(command), command.join(' ')).toEqual({
          error: expect.stringContaining('--plan is for none only'),
        });
      }
    });

    it('records no music with the plan, and silence of the plan’s length for the composition', () => {
      const { editDir } = jobFolder();
      const ran = music(['none', editDir, reason, '--plan']);
      expect(ran).toMatchObject({ status: 0, line: { ok: true, id: 'none', lengthMs: 6_000 } });
      const record = readRecord(editDir);
      expect(record).toMatchObject({
        source: 'none',
        reason,
        picked: null,
        file: null,
        versions: [],
        making: null,
      });
      expect(record.plan).toEqual(shortPlan());
      const preview = join(editDir, MUSIC_FILES.preview);
      expect(existsSync(preview)).toBe(true);
      expect(Math.abs(lengthMs(preview) - 6_000)).toBeLessThan(150);
      // Nothing was made.
      expect(existsSync(join(editDir, MUSIC_FILES.dir, 'v1.mp3'))).toBe(false);
    });

    it('leaves a bad or missing plan.json as a bad_plan failure and the record as it was', () => {
      const none = jobFolder(null);
      expect(music(['none', none.editDir, reason, '--plan'])).toMatchObject({
        status: 1,
        line: { ok: false, code: 'bad_plan' },
      });
      expect(existsSync(join(none.editDir, MUSIC_FILES.record))).toBe(false);
      expect(existsSync(join(none.editDir, MUSIC_FILES.preview))).toBe(false);

      const bad = jobFolder(shortPlan({ lengthMs: 7_000 }));
      expect(music(['none', bad.editDir, reason, '--plan'])).toMatchObject({
        status: 1,
        line: { ok: false, code: 'bad_plan' },
      });
      expect(existsSync(join(bad.editDir, MUSIC_FILES.record))).toBe(false);
    });

    it('without --plan it is the command it always was: no plan in the record, no file', () => {
      const { editDir } = jobFolder();
      expect(music(['none', editDir, reason])).toMatchObject({
        status: 0,
        line: { ok: true, id: 'none', lengthMs: null },
      });
      expect(readRecord(editDir).plan).toBeNull();
      expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(false);
    });

    it('then Make music (make --again) makes from the plan, and the record becomes made', () => {
      const { editDir } = jobFolder();
      music(['none', editDir, reason, '--plan']);
      const made = music(['make', editDir, '--again', '--by', 'you', '--fake']);
      expect(made).toMatchObject({ status: 0, line: { ok: true, id: 'v1', lengthMs: 6_000 } });
      expect(readRecord(editDir)).toMatchObject({
        source: 'made',
        reason: null,
        picked: 'v1',
      });
      // And No music is a pick away, with a length to make its silence from.
      expect(music(['pick', editDir, 'off']).line).toMatchObject({ ok: true, id: 'off' });
    });

    it('then pick off after none --plan still has a length', () => {
      const { editDir } = jobFolder();
      music(['none', editDir, reason, '--plan']);
      expect(music(['pick', editDir, 'off']).line).toMatchObject({
        ok: true,
        id: 'off',
        lengthMs: 6_000,
      });
    });
  });

  it('waits for nobody: a call while another holds the lock is refused, a dead holder’s is taken', () => {
    const { editDir } = jobFolder();
    const lock = join(editDir, MUSIC_FILES.lock);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    expect(music(['make', editDir, '--fake'])).toMatchObject({
      status: 1,
      line: { ok: false, code: 'failed' },
    });
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(editDir, MUSIC_FILES.record))).toBe(false);

    // A pid that cannot be running.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12_345, at: new Date().toISOString() }));
    expect(music(['make', editDir, '--fake']).line).toMatchObject({ ok: true, id: 'v1' });
    expect(existsSync(lock)).toBe(false);
  });

  it('answers a bad call with one line and exit 1, and a missing edit dir too', () => {
    expect(music(['play'])).toMatchObject({ status: 1, line: { ok: false, code: 'failed' } });
    expect(music(['make', join(tempDir(), 'nope'), '--fake'])).toMatchObject({
      status: 1,
      line: { ok: false, code: 'failed' },
    });
  });
});

// --- against a stub of ElevenLabs ----------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** What the stub answers one request with; `hang` never answers. */
interface Reply {
  status?: number;
  type?: string;
  body?: Buffer | string;
  json?: unknown;
  hang?: boolean;
}

interface Stub {
  base: string;
  seen: Seen[];
  /** Answered in order; when it is empty, plan calls get `planAnswer` and composes `audio`. */
  replies: Reply[];
  audio: Buffer;
}

describe.skipIf(!haveTools)('a run against ElevenLabs (a local stub)', () => {
  let server: Server;
  let stub: Stub;
  let loudAudio: Buffer;
  let shortAudio: Buffer;
  let silentAudio: Buffer;

  /** What /v1/music/plan answers by default: our chunks restyled, with its own names and lengths. */
  function planAnswer(body: Record<string, unknown>): unknown {
    const source = body.source_composition_plan as { chunks: { positive_styles: string[] }[] };
    return {
      chunks: source.chunks.map((chunk, index) => ({
        text: `[Part ${index}]`,
        duration_ms: 12_345,
        positive_styles: ['darker', ...chunk.positive_styles.filter((s) => s !== 'instrumental')],
        negative_styles: [],
        context_adherence: 'high',
        conditioning_ref: null,
        condition_strength: null,
      })),
    };
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-music-stub-'));
    // A take as ElevenLabs sends one: louder than the target, a frame longer than asked.
    writeAudio(join(dir, 'loud.mp3'), 'sine=frequency=220:duration=6.03', [
      '-af',
      'volume=-3dB',
      '-b:a',
      '192k',
    ]);
    writeAudio(join(dir, 'short.mp3'), 'sine=frequency=220:duration=5.4', ['-b:a', '192k']);
    writeAudio(join(dir, 'silent.mp3'), 'anullsrc=channel_layout=stereo:sample_rate=44100', [
      '-t',
      '6',
    ]);
    loudAudio = readFileSync(join(dir, 'loud.mp3'));
    shortAudio = readFileSync(join(dir, 'short.mp3'));
    silentAudio = readFileSync(join(dir, 'silent.mp3'));
    rmSync(dir, { recursive: true, force: true });

    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw);
        } catch {
          // Not JSON.
        }
        stub.seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        const reply: Reply = stub.replies.shift() ?? {};
        if (reply.hang) return;
        const isPlan = (req.url ?? '').startsWith('/v1/music/plan');
        const json =
          reply.json ?? (reply.body === undefined && isPlan ? planAnswer(body) : undefined);
        if (json !== undefined) {
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
          return;
        }
        res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'audio/mpeg' });
        res.end(reply.body ?? stub.audio);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  /** A fresh stub state and a HOME with a test key, for one test. */
  function setup(key: string | null = testKey()): {
    key: string | null;
    env: Record<string, string>;
  } {
    const { port } = server.address() as AddressInfo;
    stub = { base: `http://127.0.0.1:${port}`, seen: [], replies: [], audio: loudAudio };
    return { key, env: { HOME: homeWith(key), MUSIC_API_BASE: stub.base } };
  }

  /** The key appears nowhere a person or a log could read it. */
  function expectNoKey(key: string | null, editDir: string, ran: Ran): void {
    if (key === null) return;
    expect(ran.stdout).not.toContain(key);
    expect(ran.stderr).not.toContain(key);
    const record = join(editDir, MUSIC_FILES.record);
    if (existsSync(record)) expect(readFileSync(record, 'utf8')).not.toContain(key);
  }

  function composes(): Seen[] {
    return stub.seen.filter((seen) => seen.url.startsWith('/v1/music?'));
  }

  /** The chunks a compose call sent. */
  function chunksOf(seen: Seen | undefined): CompositionChunk[] {
    const plan = seen?.body.composition_plan as { chunks: CompositionChunk[] } | undefined;
    return plan?.chunks ?? [];
  }

  it('makes v1: the plan as music_v2_5 chunks, normalised to -20 LUFS, exactly the plan’s length', async () => {
    const { key, env } = setup();
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], env);
    expect(ran).toMatchObject({ status: 0, line: { ok: true, id: 'v1', lengthMs: 6_000 } });
    expectNoKey(key, editDir, ran);

    // One call: POST /v1/music, the key in its header only, the plan mapped, a seed.
    expect(stub.seen).toHaveLength(1);
    const [call] = stub.seen;
    expect(call).toMatchObject({ method: 'POST', url: '/v1/music?output_format=mp3_44100_192' });
    expect(call?.headers['xi-api-key']).toBe(key);
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.body).toEqual({
      composition_plan: toComposition(shortPlan()),
      model_id: 'music_v2_5',
      seed: expect.any(Number),
    });
    expect(JSON.stringify(call?.body)).not.toContain(key as string);

    const record = readRecord(editDir);
    expect(record).toMatchObject({ plan: shortPlan(), picked: 'v1', failure: null, making: null });
    const [v1] = record.versions;
    expect(v1).toMatchObject({ id: 'v1', model: ELEVENLABS.model, lengthMs: 6_000, by: 'edit' });
    expect(v1?.seed).toBe(call?.body.seed);

    const file = join(editDir, 'music', 'v1.mp3');
    expect(lengthMs(file)).toBe(6_000);
    const measured = loudness(file);
    expect(Math.abs(measured.integrated - LOUDNESS.integratedLufs)).toBeLessThan(1);
    expect(measured.truePeak).toBeLessThanOrEqual(LOUDNESS.truePeakDbtp);
    expect(readFileSync(join(editDir, MUSIC_FILES.preview))).toEqual(readFileSync(file));
    // Nothing but the version, the plan and the record is left in edit/music/.
    expect(readdirSync(join(editDir, 'music')).sort()).toEqual([
      'music.json',
      'plan.json',
      'v1.mp3',
    ]);
  }, 30_000);

  it('pads a take that comes back short to exactly the plan’s length', async () => {
    const { env } = setup();
    stub.audio = shortAudio;
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], env);
    expect(ran.line).toMatchObject({ ok: true, lengthMs: 6_000 });
    expect(lengthMs(join(editDir, 'music', 'v1.mp3'))).toBe(6_000);
  }, 30_000);

  it('makes v2 with --again: a new seed, the same plan, picked', async () => {
    const { key, env } = setup();
    const { editDir } = jobFolder();
    await musicAsync(['make', editDir], env);
    const ran = await musicAsync(['make', editDir, '--again', '--by', 'you'], env);
    expect(ran).toMatchObject({ status: 0, line: { ok: true, id: 'v2', lengthMs: 6_000 } });
    expectNoKey(key, editDir, ran);
    const [first, second] = composes();
    expect(second?.body.seed).not.toBe(first?.body.seed);
    expect(second?.body.composition_plan).toEqual(first?.body.composition_plan);
    const record = readRecord(editDir);
    expect(record.picked).toBe('v2');
    expect(record.versions.map((version) => [version.id, version.by, version.seed])).toEqual([
      ['v1', 'edit', first?.body.seed],
      ['v2', 'you', second?.body.seed],
    ]);
  }, 30_000);

  it('makes a version with words: /plan restyles our plan, then the compose keeps our shape', async () => {
    const { key, env } = setup();
    const { editDir } = jobFolder();
    await musicAsync(['make', editDir], env);
    const ran = await musicAsync(
      ['make', editDir, '--again', '--ask', 'darker, heavier drums', '--by', 'you'],
      env,
    );
    expect(ran).toMatchObject({ status: 0, line: { ok: true, id: 'v2' } });
    expectNoKey(key, editDir, ran);

    const [, planCall, compose] = stub.seen;
    expect(planCall).toMatchObject({ method: 'POST', url: '/v1/music/plan' });
    expect(planCall?.headers['xi-api-key']).toBe(key);
    expect(planCall?.body).toEqual({
      prompt:
        'intense cinematic electronic, 120 BPM. Change: darker, heavier drums. Keep every section and its length.',
      music_length_ms: 6_000,
      model_id: 'music_v2_5',
      source_composition_plan: toComposition(shortPlan()),
    });
    const chunks = chunksOf(compose);
    expect(compose?.url).toBe('/v1/music?output_format=mp3_44100_192');
    // Its styles, our names, lengths, adherence and avoid.
    expect(chunks).toEqual([
      {
        text: '[Build]',
        duration_ms: 3_000,
        positive_styles: [
          'darker',
          'intense cinematic electronic',
          '120 BPM',
          'rising',
          'instrumental',
        ],
        negative_styles: ['vocals', 'singing', 'lyrics'],
      },
      {
        text: '[Drop]',
        duration_ms: 3_000,
        positive_styles: ['darker', 'full drop'],
        negative_styles: ['vocals', 'singing', 'lyrics'],
        context_adherence: 'low',
      },
    ]);

    const record = readRecord(editDir);
    expect(record.versions[1]).toMatchObject({
      id: 'v2',
      ask: 'darker, heavier drums',
      describe: `You asked: darker, heavier drums. Same shape: ${shortPlan().describe}`,
      model: 'music_v2_5',
    });
    // The record keeps our plan, not the restyled one: Make another starts from it.
    expect(record.plan).toEqual(shortPlan());
  }, 30_000);

  it('makes it with the words as a style when /plan answers another shape', async () => {
    const { env } = setup();
    stub.replies.push({
      json: { chunks: [{ text: '[x]', duration_ms: 6_000, positive_styles: ['x'] }] },
    });
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir, '--ask', 'calmer'], env);
    expect(ran.line).toMatchObject({ ok: true, id: 'v1' });
    const chunks = chunksOf(composes()[0]);
    expect(chunks.map((chunk) => chunk.duration_ms)).toEqual([3_000, 3_000]);
    expect(chunks[0]?.positive_styles).toContain('calmer');
  }, 30_000);

  it('uses the environment’s key when video-use’s .env has none', async () => {
    const { env } = setup(null);
    const key = testKey();
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], { ...env, ELEVENLABS_API_KEY: key });
    expect(ran.line).toMatchObject({ ok: true, id: 'v1' });
    expect(stub.seen[0]?.headers['xi-api-key']).toBe(key);
    expectNoKey(key, editDir, ran);
  }, 30_000);

  const refusals: [string, Reply, string, number][] = [
    [
      'a wrong key',
      {
        status: 400,
        json: {
          detail: {
            type: 'authentication_error',
            code: 'invalid_api_key',
            message: 'API key is invalid.',
          },
        },
      },
      'no_access',
      2,
    ],
    [
      'no permission',
      { status: 403, json: { detail: { code: 'insufficient_permissions' } } },
      'no_access',
      2,
    ],
    [
      'no credits',
      { status: 402, json: { detail: { code: 'insufficient_credits' } } },
      'no_credits',
      2,
    ],
    [
      'a plan it cannot use',
      { status: 422, json: { detail: [{ loc: ['body', 'seed'], msg: 'bad' }] } },
      'bad_plan',
      1,
    ],
    ['an odd answer', { status: 409, json: { detail: { message: 'conflict' } } }, 'failed', 1],
    ['an empty 200', { status: 200, body: '' }, 'failed', 1],
  ];

  it.each(refusals)(
    'fails on %s, records it, and never retries',
    async (_name, reply, code, exit) => {
      const { key, env } = setup();
      stub.replies.push(reply);
      const { editDir } = jobFolder();
      const ran = await musicAsync(['make', editDir], env);
      expect(ran).toMatchObject({ status: exit, line: { ok: false, code } });
      expect(stub.seen).toHaveLength(1);
      expectNoKey(key, editDir, ran);
      expect(readRecord(editDir)).toMatchObject({
        picked: null,
        versions: [],
        making: null,
        failure: { id: 'v1', code },
      });
    },
    30_000,
  );

  it('fails on silence sent as music', async () => {
    const { env } = setup();
    stub.audio = silentAudio;
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], env);
    expect(ran.line).toMatchObject({
      ok: false,
      code: 'failed',
      message: 'ElevenLabs sent back silence instead of music.',
    });
    expect(existsSync(join(editDir, 'music', 'v1.mp3'))).toBe(false);
  }, 30_000);

  it('tries once more on a 5xx or a 429, and says it is down when the second try fails too', async () => {
    const { key, env } = setup();
    const { editDir } = jobFolder();
    stub.replies.push({ status: 503, body: 'Service Unavailable', type: 'text/plain' });
    const recovered = await musicAsync(['make', editDir], env);
    expect(recovered.line).toMatchObject({ ok: true, id: 'v1' });
    expect(stub.seen).toHaveLength(2);

    stub.replies.push(
      { status: 500, json: { detail: { type: 'internal_error' } } },
      { status: 429, json: { detail: { type: 'rate_limit_error' } } },
    );
    const down = await musicAsync(['make', editDir, '--again'], env);
    expect(down).toMatchObject({ status: 3, line: { ok: false, code: 'down' } });
    expect(stub.seen).toHaveLength(4);
    expectNoKey(key, editDir, down);
    // A failed v2 keeps v1 picked and playing.
    const record = readRecord(editDir);
    expect(record).toMatchObject({ picked: 'v1', failure: { id: 'v2', code: 'down' } });
    expect(readFileSync(join(editDir, MUSIC_FILES.preview))).toEqual(
      readFileSync(join(editDir, 'music', 'v1.mp3')),
    );
  }, 30_000);

  it('says it is down when ElevenLabs can’t be reached, after one more try', async () => {
    const { env } = setup();
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], {
      ...env,
      MUSIC_API_BASE: 'http://127.0.0.1:9',
    });
    expect(ran).toMatchObject({
      status: 3,
      line: { ok: false, code: 'down', message: 'ElevenLabs can’t be reached. Is the Mac online?' },
    });
  }, 30_000);

  it('gives up on a call that takes too long, without a second try', async () => {
    const { env } = setup();
    stub.replies.push({ hang: true });
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], { ...env, MUSIC_TIMEOUT_MS: '400' });
    expect(ran).toMatchObject({
      status: 3,
      line: { ok: false, code: 'down', message: 'ElevenLabs didn’t answer within 0.4 seconds.' },
    });
    expect(stub.seen).toHaveLength(1);
    expect(readRecord(editDir)).toMatchObject({ making: null, failure: { code: 'down' } });
  }, 30_000);

  it('fails --ask when /plan refuses the key, before any compose', async () => {
    const { env } = setup();
    stub.replies.push({
      status: 401,
      json: { detail: { status: 'missing_permissions', message: 'no music' } },
    });
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir, '--ask', 'darker'], env);
    expect(ran.line).toMatchObject({ ok: false, code: 'no_access' });
    expect(ran.line.ok === false && ran.line.message).toMatch(/Music permission/);
    expect(composes()).toHaveLength(0);
  }, 30_000);

  it('takes the key out of anything ElevenLabs says back, whatever the key looks like', async () => {
    const key = 'plainkey0123456789abcdef0123';
    const { env } = setup(key);
    stub.replies.push({
      status: 409,
      json: { detail: { message: `you sent ${key} and sk_other_123` } },
    });
    const { editDir } = jobFolder();
    const ran = await musicAsync(['make', editDir], env);
    expect(ran.line).toMatchObject({ ok: false, code: 'failed' });
    expect(ran.line.ok === false && ran.line.message).toBe(
      'ElevenLabs answered 409: you sent [key] and sk_….',
    );
    expectNoKey(key, editDir, ran);
  }, 30_000);

  it('refuses while another call holds the lock, without calling ElevenLabs', async () => {
    const { env } = setup();
    const { editDir } = jobFolder();
    writeFileSync(
      join(editDir, MUSIC_FILES.lock),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    const ran = await musicAsync(['make', editDir], env);
    expect(ran).toMatchObject({ status: 1, line: { ok: false, code: 'failed' } });
    expect(stub.seen).toHaveLength(0);
  }, 30_000);
});
