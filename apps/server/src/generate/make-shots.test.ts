import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATE_ERROR_CODES,
  type GenerateErrorCode,
  generateErrorMessage,
  generateExitCode,
  generateSpendSchema,
  makeShotsLineSchema,
  parseGenerateScriptLine,
  spendTotal as sharedSpendTotal,
} from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  API_BASE,
  ApiError,
  apiBase,
  createBackend,
  detailOf,
  dotenvValue,
  envFile,
  readKey,
  redact,
  retryAfterMs,
} from '../../assets/generate/backends/higgsfield-api.mjs';
import {
  DEFAULT_USD_PER_CREDIT,
  EXIT,
  EXIT_FOR,
  idempotencyKey,
  imageType,
  MESSAGES,
  parseArgs,
  runShots,
  type ShotsIo,
  settingsOf,
  spendTotal,
} from '../../assets/generate/make-shots.mjs';
import {
  clipBody,
  clipSeconds,
  imageModel,
  listRatePerSecond,
  ModelError,
  priceOf,
  SLUGS,
  stillBody,
  TIERS,
  tierForSlug,
} from '../../assets/generate/models.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { makeTempDir } from '../test-temp.js';
import {
  BLACK_MP4,
  FAKE_KEY,
  type FakeHiggsfield,
  PNG_BYTES,
  SLUG_KLING,
  SLUG_QWEN_EDIT,
  SLUG_SOUL,
  SLUG_WAN,
  SLUG_Z_IMAGE,
  startFakeHiggsfield,
} from './test-utils.js';

// The shots script (assets/generate/make-shots.mjs) against a local fake of Higgsfield's API
// (test-utils.ts): every command, the money rules (the estimate first, the budget guard, spend.json
// before and after, a refund), the error mapping, the idempotency key, the resumable clip, the
// upload flow, and that the key never reaches an output line, a log or a file. No test touches the
// network or a working key, and none costs a cent.

const SCRIPT = fileURLToPath(new URL('../../assets/generate/make-shots.mjs', import.meta.url));
const haveFfprobe = (await resolveFfmpeg('ffprobe')) !== null;
const haveFfmpeg = (await resolveFfmpeg('ffmpeg')) !== null;
const KEY_PARTS = [FAKE_KEY, ...FAKE_KEY.split(':')];

let fake: FakeHiggsfield;

beforeEach(async () => {
  fake = await startFakeHiggsfield();
});

afterEach(async () => {
  await fake.close();
});

interface Job {
  root: string;
  edit: string;
  gen: string;
}

/** A job folder with an edit folder, and two start frames that exist. */
function newJob(): Job {
  const root = makeTempDir('studio-shots-');
  const edit = join(root, 'job', 'edit');
  const gen = join(edit, 'generate');
  mkdirSync(join(gen, 'keyframes'), { recursive: true });
  writeFileSync(join(gen, 'keyframes', 'A-start.png'), png(1));
  writeFileSync(join(gen, 'keyframes', 'A-end.png'), png(2));
  return { root, edit, gen };
}

/** A tiny PNG that differs per `n` (the type is read from the first bytes). */
const png = (n: number): Buffer => Buffer.concat([PNG_BYTES, Buffer.from(`-${n}`)]);

function envFor(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HIGGSFIELD_API_KEY: fake.key,
    HIGGSFIELD_API_BASE: fake.url,
    STUDIO_SHOTS_POLL_MS: '1',
    STUDIO_SHOTS_RETRY_MS: '1',
    STUDIO_SHOTS_MAX_WAIT_MS: '20000',
    ...extra,
  };
}

/** Runs one command in this process, against the fake. */
function shots(args: string[], io: ShotsIo = {}, extra: Record<string, string> = {}) {
  return runShots(args, { env: envFor(extra), log: () => {}, ...io });
}

const stillArgs = (
  edit: string,
  id = 'K1',
  more: string[] = [],
  prompt = 'a dusty skylight',
): string[] => ['still', edit, id, '--model', 'soul', '--prompt', prompt, '--budget', '3', ...more];

/** The same arguments without a flag and its value. */
const without = (args: string[], flag: string): string[] =>
  args.filter((arg, i) => arg !== flag && args[i - 1] !== flag);

const clipArgs = (
  edit: string,
  id: string,
  tier: string,
  more: string[] = [],
  seconds = '4',
): string[] => [
  'clip',
  edit,
  id,
  '--tier',
  tier,
  '--start',
  'keyframes/A-start.png',
  '--seconds',
  seconds,
  '--prompt',
  'push in',
  '--budget',
  '3',
  ...more,
];

interface Entry {
  at: string;
  kind: string;
  slug: string;
  usd: number;
  requestId: string | null;
  refunded: boolean;
  id: string;
  take: number;
  key: string;
  state: string;
  basis?: string;
  body?: Record<string, unknown>;
  file?: string;
  fps?: number;
}

function spendOf(job: Job): { entries: Entry[]; total: number } {
  return JSON.parse(readFileSync(join(job.gen, 'spend.json'), 'utf8'));
}

/** spend.json with money already spent, as an earlier call would have left it. */
function seedSpend(job: Job, usd: number, refunded = false): void {
  const entries = [
    {
      at: '2026-10-25T10:00:00.000Z',
      kind: 'clip',
      slug: SLUG_WAN,
      usd,
      requestId: 'earlier',
      refunded,
    },
  ];
  writeFileSync(
    join(job.gen, 'spend.json'),
    JSON.stringify({ entries, total: refunded ? 0 : usd }, null, 2),
  );
}

/** The requests that created something at Higgsfield: not the free estimate, nor the upload flow. */
const generationPosts = () =>
  fake.log.filter(
    (entry) =>
      entry.method === 'POST' &&
      !entry.path.startsWith('/estimate/') &&
      entry.path !== '/files/generate-upload-url',
  );

/** Every file under a folder, as text, to look for a key. */
function allText(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    out += entry.isDirectory() ? allText(path) : readFileSync(path, 'latin1');
  }
  return out;
}

function expectNoKey(text: string): void {
  for (const part of KEY_PARTS) expect(text).not.toContain(part);
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The script as the engine's run starts it: a real process (async, so the fake can answer). */
function spawnShots(args: string[], env: Record<string, string>): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// --- the pure parts ------------------------------------------------------------------------------

describe('models.mjs: the tier table', () => {
  it('maps our three tiers to the models GN1 found', () => {
    expect(TIERS.easy.slug).toBe('kling-video/v2.5-turbo/standard/image-to-video');
    expect(TIERS.people.slug).toBe('alibaba/wan-3.0/image-to-video');
    expect(TIERS.tilt.slug).toBe(TIERS.people.slug);
    expect(TIERS.tilt.endFrame).toBe('required');
    expect(TIERS.easy.endFrame).toBe('no');
    expect(tierForSlug(SLUGS.kling25, false)).toBe('easy');
    expect(tierForSlug(SLUGS.wan3, false)).toBe('people');
    expect(tierForSlug(SLUGS.wan3, true)).toBe('tilt');
    expect(tierForSlug(SLUGS.soul, false)).toBeNull();
  });

  it('makes Kling 2.5 Turbo clips 5 s or 10 s (rounded UP) and Wan 3.0 clips the exact whole seconds', () => {
    expect(clipSeconds('easy', 4)).toEqual({ seconds: 5, rounded: true });
    expect(clipSeconds('easy', 5)).toEqual({ seconds: 5, rounded: false });
    expect(clipSeconds('easy', 5.5)).toEqual({ seconds: 10, rounded: true });
    expect(clipSeconds('easy', 10)).toEqual({ seconds: 10, rounded: false });
    expect(() => clipSeconds('easy', 10.5)).toThrow(ModelError);
    expect(clipSeconds('people', 4)).toEqual({ seconds: 4, rounded: false });
    expect(clipSeconds('people', 4.2)).toEqual({ seconds: 5, rounded: true });
    expect(clipSeconds('tilt', 1.2)).toEqual({ seconds: 2, rounded: true });
    expect(clipSeconds('people', 30)).toEqual({ seconds: 30, rounded: false });
    expect(() => clipSeconds('people', 31)).toThrow(ModelError);
    expect(() => clipSeconds('people', 0)).toThrow(ModelError);
    expect(() => clipSeconds('people', Number.NaN)).toThrow(ModelError);
    expect(() => clipSeconds('slow', 4)).toThrow(/Unknown tier/);
  });

  it('builds the Kling body from a whitelist: no resolution, aspect or sound field', () => {
    expect(
      clipBody('easy', { prompt: 'p', startUrl: 'https://x/a.png', seconds: 5, aspect: undefined }),
    ).toEqual({ prompt: 'p', image_url: 'https://x/a.png', duration: 5 });
    expect(
      clipBody('easy', {
        prompt: 'p',
        startUrl: 'https://x/a.png',
        seconds: 5,
        negative: 'morphing',
      }),
    ).toEqual({
      prompt: 'p',
      image_url: 'https://x/a.png',
      duration: 5,
      negative_prompt: 'morphing',
    });
    expect(() => clipBody('easy', { prompt: 'p', startUrl: 'u', endUrl: 'e', seconds: 5 })).toThrow(
      /start frame only/,
    );
    expect(() =>
      clipBody('easy', { prompt: 'p', startUrl: 'u', seconds: 5, aspect: '1:1' }),
    ).toThrow(/no --aspect/);
  });

  it('ALWAYS overrides Wan 3.0 defaults (1080p, adaptive, sound on) and sends nothing else', () => {
    const body = clipBody('people', { prompt: 'p', startUrl: 'https://x/a.png', seconds: 4 });
    expect(body).toEqual({
      prompt: 'p',
      image_url: 'https://x/a.png',
      duration: 4,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
    });
    expect(
      clipBody('tilt', {
        prompt: 'p',
        startUrl: 'https://x/a.png',
        endUrl: 'https://x/b.png',
        seconds: 5,
      }),
    ).toEqual({
      prompt: 'p',
      image_url: 'https://x/a.png',
      end_image_url: 'https://x/b.png',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
    });
    expect(
      clipBody('people', { prompt: 'p', startUrl: 'u', seconds: 4, aspect: '1:1' }),
    ).toMatchObject({ aspect_ratio: '1:1', resolution: '720p', generate_audio: false });
    expect(() => clipBody('tilt', { prompt: 'p', startUrl: 'u', seconds: 5 })).toThrow(
      /needs --end/,
    );
    expect(() =>
      clipBody('people', { prompt: 'p', startUrl: 'u', seconds: 4, aspect: 'adaptive' }),
    ).toThrow(/not one of them/);
    expect(() =>
      clipBody('people', { prompt: 'p', startUrl: 'u', seconds: 4, negative: 'x' }),
    ).toThrow(/no negative prompt/);
  });

  it('builds each still body from the model’s whitelist, and tells off references that do not fit', () => {
    expect(stillBody(imageModel('soul', 0), { prompt: 'p', urls: [] })).toEqual({
      prompt: 'p',
      aspect_ratio: '9:16',
      resolution: '720p',
    });
    expect(
      stillBody(imageModel('qwen-edit', 1), {
        prompt: 'p',
        aspect: '1:1',
        urls: ['https://x/a.png'],
      }),
    ).toEqual({
      prompt: 'p',
      image_urls: ['https://x/a.png'],
      aspect_ratio: '1:1',
      resolution: '1k',
      prompt_extend: false,
      enable_thinking: false,
    });
    expect(stillBody(imageModel('z-image', 0), { prompt: 'p', urls: [] })).toEqual({
      prompt: 'p',
      aspect_ratio: '9:16',
      resolution: '1k',
    });
    expect(
      stillBody(imageModel(SLUGS.soulEdit, 1), { prompt: 'p', urls: ['https://x/a.png'] }),
    ).toEqual({
      prompt: 'p',
      image_url: 'https://x/a.png',
      aspect_ratio: '9:16',
    });
    expect(() => stillBody(imageModel('soul', 0), { prompt: 'p', urls: ['u'] })).toThrow(
      /takes no reference image/,
    );
    expect(() => stillBody(imageModel('qwen-edit', 0), { prompt: 'p', urls: [] })).toThrow(
      /takes 1 to 3 reference images/,
    );
    expect(() =>
      stillBody(imageModel('soul', 0), { prompt: 'p', aspect: '21:9', urls: [] }),
    ).toThrow(/is not one of them/);
  });

  it('picks an image model by name or slug, and by references when none is named', () => {
    expect(imageModel(undefined, 0).slug).toBe(SLUGS.soul);
    expect(imageModel('', 2).slug).toBe(SLUGS.qwenEdit);
    expect(imageModel('z-image', 0).slug).toBe(SLUGS.zImage);
    expect(imageModel(SLUGS.qwen, 0).slug).toBe(SLUGS.qwen);
    expect(() => imageModel('dall-e', 0)).toThrow(/Unknown image model/);
  });

  it('prices a request from the estimate (net of its discount) or, for a per-second model, at list price', () => {
    expect(priceOf({ type: 'estimate', usd: '0.105' }, {})).toEqual({
      usd: 0.105,
      basis: 'estimate',
    });
    const wan = {
      type: 'description',
      pricing_description:
        'Priced per generated second by resolution: 480p $0.05, 720p $0.10, or 1080p $0.20. Rates shown are before any applicable customer discount.',
    };
    expect(priceOf(wan, { duration: 4, resolution: '720p' })).toEqual({ usd: 0.4, basis: 'list' });
    expect(priceOf(wan, { duration: 5, resolution: '720p' }).usd).toBe(0.5);
    expect(priceOf(wan, { duration: 5, resolution: '1080p' }).usd).toBe(1);
    expect(listRatePerSecond(wan.pricing_description, '480p')).toBe(0.05);
    expect(listRatePerSecond(wan.pricing_description, '4k')).toBeNull();
    expect(() => priceOf(wan, { duration: 5 })).toThrow(ModelError);
    expect(() =>
      priceOf(
        { type: 'description', pricing_description: '$5 a million tokens' },
        { duration: 5, resolution: '720p' },
      ),
    ).toThrow(ModelError);
    expect(() => priceOf({ type: 'estimate', usd: 'free' }, {})).toThrow(ModelError);
    expect(() => priceOf(null, {})).toThrow(ModelError);
  });
});

describe('the backend’s small parts', () => {
  it('takes any key out of a text: what it read, its halves, and anything shaped like one', () => {
    readKey({ HIGGSFIELD_API_KEY: FAKE_KEY });
    expect(redact(`oops ${FAKE_KEY} twice ${FAKE_KEY}`)).toBe('oops [key] twice [key]');
    expect(redact(`id ${KEY_PARTS[1]} and secret ${KEY_PARTS[2]}`)).toBe(
      'id [key] and secret [key]',
    );
    expect(redact('Authorization: Key someid1234:somesecret5678')).toBe('Authorization: Key [key]');
    expect(redact('Key features of the model')).toBe('Key features of the model');
  });

  it('reads the key from the environment first, then from the .env file, quotes and all', () => {
    const dir = makeTempDir('studio-shots-env-');
    const file = join(dir, '.env');
    writeFileSync(file, `# keys\nOTHER=1\nexport HIGGSFIELD_API_KEY="file-id:file-secret-1234"\n`);
    expect(readKey({}, file)).toBe('file-id:file-secret-1234');
    expect(readKey({ HIGGSFIELD_API_KEY: ' env-id:env-secret-1234 ' }, file)).toBe(
      'env-id:env-secret-1234',
    );
    expect(readKey({}, join(dir, 'missing.env'))).toBeNull();
    writeFileSync(file, 'HIGGSFIELD_API_KEY=\n');
    expect(readKey({}, file)).toBeNull();
    expect(dotenvValue("A='1'\nB=2", 'A')).toBe('1');
  });

  it('finds the .env: STUDIO_ENV_FILE when it is an absolute path or ~/…, else the repo’s', () => {
    expect(envFile({ STUDIO_ENV_FILE: '/tmp/x/.env' }, '/home/me')).toBe('/tmp/x/.env');
    expect(envFile({ STUDIO_ENV_FILE: '~/keys/.env' }, '/home/me')).toBe('/home/me/keys/.env');
    const repo = envFile({}, '/home/me');
    expect(repo.endsWith('/.env')).toBe(true);
    expect(envFile({ STUDIO_ENV_FILE: 'relative/.env' }, '/home/me')).toBe(repo);
  });

  it('sends the key only to Higgsfield, or (tests) to a loopback server', () => {
    expect(apiBase({})).toBe(API_BASE);
    expect(apiBase({ HIGGSFIELD_API_BASE: 'http://127.0.0.1:4455/' })).toBe(
      'http://127.0.0.1:4455',
    );
    expect(apiBase({ HIGGSFIELD_API_BASE: 'http://localhost:1' })).toBe('http://localhost:1');
    expect(apiBase({ HIGGSFIELD_API_BASE: 'https://evil.example' })).toBe(API_BASE);
    expect(apiBase({ HIGGSFIELD_API_BASE: 'http://evil.example:80' })).toBe(API_BASE);
    expect(apiBase({ HIGGSFIELD_API_BASE: 'http://127.0.0.1.evil.example' })).toBe(API_BASE);
  });

  it('reads the API’s own words out of its error answers', () => {
    expect(detailOf({ detail: 'not_enough_credits' })).toBe('not_enough_credits');
    expect(detailOf({ detail: { code: 'account_queue_full', message: 'Queue full' } })).toBe(
      'account_queue_full: Queue full',
    );
    expect(
      detailOf({ detail: [{ loc: ['body', 'duration'], msg: 'must be 5 or 10' }, 'plain'] }),
    ).toBe('body.duration: must be 5 or 10; plain');
    expect(detailOf(null, '  <html>bad gateway</html>  ')).toBe('<html>bad gateway</html>');
    expect(detailOf({ detail: 'x'.repeat(900) })).toHaveLength(400);
  });

  it('reads how long a 429 asks to wait: the header, a date, the body, else 5 s', () => {
    const headers = (value: string | null) => ({ get: () => value });
    expect(retryAfterMs(headers('7'), null)).toBe(7000);
    expect(retryAfterMs(headers(null), { detail: { retry_after_seconds: 12 } })).toBe(12000);
    expect(retryAfterMs(headers(null), null)).toBe(5000);
    expect(retryAfterMs(headers(new Date(Date.now() + 3000).toUTCString()), null)).toBeGreaterThan(
      0,
    );
    expect(retryAfterMs(undefined, null)).toBe(5000);
  });

  it('keeps the same Idempotency-Key for the same request, and a new one when anything differs', () => {
    const base = {
      jobFolder: '/inbox/Pinewood/97 Window Ad',
      kind: 'clip',
      id: 'A',
      take: 1,
      slug: SLUG_KLING,
      logical: { prompt: 'p', image_url: 'sha256:aa', duration: 5 },
    };
    const key = idempotencyKey(base);
    expect(key).toMatch(/^studio-[0-9a-f]{48}$/);
    expect(
      idempotencyKey({ ...base, logical: { duration: 5, image_url: 'sha256:aa', prompt: 'p' } }),
    ).toBe(key);
    for (const other of [
      { jobFolder: '/inbox/Pinewood/Other' },
      { kind: 'keyframe' },
      { id: 'B' },
      { take: 2 },
      { slug: SLUG_WAN },
      { logical: { ...base.logical, prompt: 'q' } },
      { logical: { ...base.logical, image_url: 'sha256:bb' } },
    ]) {
      expect(idempotencyKey({ ...base, ...other })).not.toBe(key);
    }
  });

  it('knows the images Higgsfield takes by their first bytes', () => {
    expect(imageType(png(1))).toEqual({ contentType: 'image/png', ext: 'png' });
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.ext).toBe('jpg');
    expect(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))?.ext).toBe('webp');
    expect(imageType(Buffer.from('GIF89a\0\0\0'))?.ext).toBe('gif');
    expect(imageType(Buffer.from('<html>no</html>'))).toBeNull();
    expect(imageType(BLACK_MP4)).toBeNull();
  });

  it('parses repeated flags and the timings the tests move', () => {
    const args = parseArgs(['clip', '/e', 'A', '--ref', 'a', '--ref', 'b', '--seconds', '5']);
    expect(args.words).toEqual(['clip', '/e', 'A']);
    expect(args.all('ref')).toEqual(['a', 'b']);
    expect(args.flag('seconds')).toBe('5');
    expect(args.flag('nothing')).toBeUndefined();
    expect(settingsOf({})).toMatchObject({ maxWaitMs: 540_000, pollMs: 3_000, pollMaxMs: 10_000 });
    expect(
      settingsOf({ STUDIO_SHOTS_POLL_MS: '20', STUDIO_SHOTS_MAX_WAIT_MS: '99' }),
    ).toMatchObject({
      maxWaitMs: 99,
      pollMs: 20,
      pollMaxMs: 20,
    });
    expect(
      spendTotal([
        { usd: 0.1, refunded: false },
        { usd: 0.2, refunded: false },
        { usd: 9, refunded: true },
      ]),
    ).toBe(0.3);
  });
});

// --- estimate -----------------------------------------------------------------------------------

describe('estimate (free)', () => {
  it('prices a Kling clip from the estimate, rounded up to 5 s, and sends the body the clip would send', async () => {
    const job = newJob();
    const out = await shots([
      'estimate',
      job.edit,
      '--kind',
      'clip',
      '--tier',
      'easy',
      '--seconds',
      '4',
    ]);

    expect(out.exit).toBe(0);
    expect(out.line).toMatchObject({
      ok: true,
      command: 'estimate',
      kind: 'clip',
      tier: 'easy',
      slug: SLUG_KLING,
      seconds: 5,
      requestedSeconds: 4,
      rounded: true,
      usd: 0.105,
      basis: 'estimate',
    });
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ command: 'estimate', usd: 0.105 });
    const asked = fake.requests('POST', '/estimate/');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toBe(`/estimate/${SLUG_KLING}`);
    expect(asked[0]?.body).toEqual({
      prompt: 'estimate',
      image_url: 'https://example.com/frame.png',
      duration: 5,
    });
    // Free: nothing is recorded and nothing is made or uploaded.
    expect(existsSync(join(job.gen, 'spend.json'))).toBe(false);
    expect(generationPosts()).toHaveLength(0);
    expect(fake.requests('POST', '/files')).toHaveLength(0);
  });

  it('books a Wan 3.0 clip at the LIST price per second ($0.10 at 720p), with the defaults overridden', async () => {
    const job = newJob();
    const people = await shots([
      'estimate',
      job.edit,
      '--kind',
      'clip',
      '--tier',
      'people',
      '--seconds',
      '4',
    ]);
    const tilt = await shots([
      'estimate',
      job.edit,
      '--kind',
      'clip',
      '--tier',
      'tilt',
      '--seconds',
      '5',
    ]);
    const short = await shots(['estimate', job.edit, '--tier', 'people', '--seconds', '1.2']);

    expect(people.line).toMatchObject({
      tier: 'people',
      slug: SLUG_WAN,
      seconds: 4,
      usd: 0.4,
      basis: 'list',
    });
    expect(tilt.line).toMatchObject({ tier: 'tilt', seconds: 5, usd: 0.5, basis: 'list' });
    expect(short.line).toMatchObject({
      seconds: 2,
      requestedSeconds: 1.2,
      rounded: true,
      usd: 0.2,
    });
    const bodies = fake.requests('POST', '/estimate/').map((entry) => entry.body);
    expect(bodies[0]).toEqual({
      prompt: 'estimate',
      image_url: 'https://example.com/frame.png',
      duration: 4,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
    });
    expect(bodies[1]).toMatchObject({
      end_image_url: 'https://example.com/frame.png',
      duration: 5,
    });
  });

  it('prices stills by model, and a reference does not upload anything', async () => {
    const job = newJob();
    const soul = await shots(['estimate', job.edit, '--kind', 'still', '--model', 'soul']);
    const z = await shots(['estimate', job.edit, '--kind', 'still', '--model', 'z-image']);
    const edit = await shots([
      'estimate',
      job.edit,
      '--kind',
      'still',
      '--model',
      'qwen-edit',
      '--ref',
      'keyframes/A-start.png',
    ]);
    const bySlug = await shots(['estimate', job.edit, '--model', SLUG_Z_IMAGE]);

    expect(soul.line).toMatchObject({ kind: 'still', slug: SLUG_SOUL, usd: 0.004 });
    expect(z.line).toMatchObject({ slug: SLUG_Z_IMAGE, usd: 0.015 });
    expect(edit.line).toMatchObject({ slug: SLUG_QWEN_EDIT, usd: 0.04 });
    expect(bySlug.line).toMatchObject({ kind: 'still', usd: 0.015 });
    expect(fake.requests('POST', '/files')).toHaveLength(0);
    expect(fake.requests('POST', `/estimate/${SLUG_QWEN_EDIT}`)[0]?.body).toMatchObject({
      image_urls: ['https://example.com/frame.png'],
    });
  });

  it('prices an exact body with --slug and --body, with no edit folder', async () => {
    const kling = await shots([
      'estimate',
      '--slug',
      SLUG_KLING,
      '--body',
      JSON.stringify({ prompt: 'x', image_url: 'https://example.com/a.png', duration: 10 }),
    ]);
    const wan = await shots([
      'estimate',
      '--slug',
      SLUG_WAN,
      '--body',
      JSON.stringify({
        prompt: 'x',
        image_url: 'https://example.com/a.png',
        duration: 6,
        resolution: '720p',
      }),
    ]);

    expect(kling.line).toEqual({
      ok: true,
      command: 'estimate',
      slug: SLUG_KLING,
      usd: 0.105,
      basis: 'estimate',
    });
    expect(wan.line).toMatchObject({ usd: 0.6, basis: 'list' });
    expect(makeShotsLineSchema.safeParse(wan.line).success).toBe(true);
  });

  it('carries the API’s own words when it refuses a body (a 400 from the free estimate)', async () => {
    const out = await shots([
      'estimate',
      '--slug',
      SLUG_KLING,
      '--body',
      JSON.stringify({ prompt: 'x', image_url: 'https://example.com/a.png', duration: 4 }),
    ]);

    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({
      ok: false,
      code: 'bad_request',
      message: generateErrorMessage('bad_request'),
    });
    expect(out.line.detail).toContain('duration: 4 is not one of [5, 10]');
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ code: 'bad_request' });
  });

  it('refuses what cannot be asked, without any network call', async () => {
    const job = newJob();
    for (const args of [
      ['estimate', job.edit],
      ['estimate', job.edit, '--kind', 'clip'],
      ['estimate', job.edit, '--kind', 'clip', '--tier', 'easy', '--seconds', '11'],
      [
        'estimate',
        job.edit,
        '--kind',
        'clip',
        '--tier',
        'easy',
        '--seconds',
        '5',
        '--end',
        'x.png',
      ],
      ['estimate', job.edit, '--kind', 'still', '--model', 'dall-e'],
      ['estimate', job.edit, '--kind', 'still', '--model', 'soul', '--ref', 'a.png'],
      ['estimate', '--slug', SLUG_KLING, '--body', 'not json'],
      ['estimate', '--body', '{}'],
    ]) {
      const out = await shots(args);
      expect(out.exit, args.join(' ')).toBe(1);
      expect(out.line, args.join(' ')).toMatchObject({ ok: false, code: 'bad_request' });
    }
    expect(fake.log).toHaveLength(0);
  });

  it('answers reframe with bad_request: Higgsfield has no model that reframes a video', async () => {
    const job = newJob();
    const out = await shots(['reframe', job.edit, 'A', '--take', '1', '--aspect', '1:1']);
    const estimate = await shots(['estimate', job.edit, '--kind', 'reframe']);

    for (const answer of [out, estimate]) {
      expect(answer.exit).toBe(1);
      expect(answer.line).toMatchObject({ ok: false, code: 'bad_request' });
      expect(String(answer.line.detail)).toContain('ffmpeg');
      expect(String(answer.line.detail)).toContain('--aspect 1:1');
    }
    expect(fake.log).toHaveLength(0);
  });

  it('answers an unknown command with the usage as bad_request', async () => {
    const out = await shots(['dance', '/somewhere']);
    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({ ok: false, code: 'bad_request' });
    expect(String(out.line.detail)).toContain('Usage');
  });
});

// --- upload -------------------------------------------------------------------------------------

describe('upload', () => {
  it('uploads through the presigned flow (the PUT carries exactly the upload headers and no key) and caches by hash', async () => {
    const job = newJob();

    const first = await shots(['upload', job.edit, '--file', 'keyframes/A-start.png']);

    expect(first.exit).toBe(0);
    expect(first.line).toMatchObject({
      ok: true,
      command: 'upload',
      file: 'keyframes/A-start.png',
      cached: false,
      contentType: 'image/png',
    });
    expect(String(first.line.url)).toMatch(new RegExp(`^${fake.url}/cdn/[0-9a-f-]+\\.png$`));
    expect(makeShotsLineSchema.parse(first.line)).toMatchObject({ command: 'upload' });
    expect(fake.requests('POST', '/files/generate-upload-url')[0]?.body).toEqual({
      content_type: 'image/png',
    });
    const put = fake.requests('PUT', '/s3/');
    expect(put).toHaveLength(1);
    expect(put[0]?.headers.authorization).toBeUndefined();
    expect(put[0]?.headers['content-type']).toBe('image/png');
    expect(put[0]?.headers['x-amz-tagging']).toBe('retention=temporary');
    expect([...fake.uploads.values()][0]?.bytes.equals(png(1))).toBe(true);

    const sha = createHash('sha256').update(png(1)).digest('hex');
    const cache = JSON.parse(readFileSync(join(job.gen, 'uploads.json'), 'utf8'));
    expect(cache.files[sha]).toMatchObject({
      url: first.line.url,
      contentType: 'image/png',
      bytes: png(1).length,
    });
    expect(Number.isNaN(Date.parse(cache.files[sha].at))).toBe(false);

    // The same bytes again: no request at all. Other bytes: a new upload.
    const before = fake.log.length;
    const again = await shots([
      'upload',
      job.edit,
      '--file',
      join(job.gen, 'keyframes', 'A-start.png'),
    ]);
    expect(again.line).toMatchObject({ cached: true, url: first.line.url });
    expect(fake.log).toHaveLength(before);
    const other = await shots(['upload', job.edit, '--file', 'keyframes/A-end.png']);
    expect(other.line).toMatchObject({ cached: false });
    expect(other.line.url).not.toBe(first.line.url);
    expect(fake.uploads.size).toBe(2);
  });

  it('uploads a JPEG with its own content type, and finds files in the edit and job folders', async () => {
    const job = newJob();
    writeFileSync(
      join(job.root, 'job', 'photo.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74]),
    );

    const out = await shots(['upload', job.edit, '--file', 'photo.jpg']);

    expect(out.line).toMatchObject({ ok: true, contentType: 'image/jpeg' });
    expect(fake.requests('POST', '/files/generate-upload-url')[0]?.body).toEqual({
      content_type: 'image/jpeg',
    });
    expect([...fake.uploads.values()][0]?.contentType).toBe('image/jpeg');
  });

  it('trusts a cached URL for 12 hours, then uploads the file again', async () => {
    const job = newJob();
    const first = await shots(['upload', job.edit, '--file', 'keyframes/A-start.png']);
    const cache = JSON.parse(readFileSync(join(job.gen, 'uploads.json'), 'utf8'));
    for (const file of Object.values(cache.files) as { at: string }[]) {
      file.at = new Date(Date.now() - 13 * 3_600_000).toISOString();
    }
    writeFileSync(join(job.gen, 'uploads.json'), JSON.stringify(cache));

    const again = await shots(['upload', job.edit, '--file', 'keyframes/A-start.png']);

    expect(again.line).toMatchObject({ cached: false });
    expect(again.line.url).not.toBe(first.line.url);
    expect(fake.uploads.size).toBe(2);
  });

  it('refuses a file that is not an image, is missing, or is outside the job folder', async () => {
    const job = newJob();
    writeFileSync(join(job.gen, 'notes.txt'), 'hello');
    writeFileSync(join(job.root, 'outside.png'), png(9));

    const notImage = await shots(['upload', job.edit, '--file', 'notes.txt']);
    const missing = await shots(['upload', job.edit, '--file', 'nothing.png']);
    const outside = await shots(['upload', job.edit, '--file', join(job.root, 'outside.png')]);
    const noFile = await shots(['upload', job.edit]);

    expect(notImage.line.detail).toContain('is not an image');
    expect(missing.line.detail).toContain('File not found');
    expect(outside.line.detail).toContain('outside the job folder');
    expect(noFile.line).toMatchObject({ code: 'bad_request' });
    for (const out of [notImage, missing, outside, noFile]) expect(out.exit).toBe(1);
    expect(fake.log).toHaveLength(0);
  });
});

// --- still --------------------------------------------------------------------------------------

describe('still', () => {
  it('makes a keyframe: queued, in progress, completed; writes the file, books it BEFORE it sends, and answers the shared shape', async () => {
    const job = newJob();
    let booked: ReturnType<typeof spendOf> | null = null;
    fake.onSubmit = () => {
      booked = spendOf(job);
    };

    const out = await shots(stillArgs(job.edit));

    expect(out.exit).toBe(0);
    expect(out.line).toMatchObject({
      ok: true,
      command: 'still',
      id: 'K1',
      take: 1,
      file: 'keyframes/K1.png',
      usd: 0.004,
      model: SLUG_SOUL,
      reused: false,
      spentUsd: 0.004,
      budgetUsd: 3,
    });
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ command: 'still', id: 'K1' });
    expect(readFileSync(join(job.gen, 'keyframes', 'K1.png')).equals(PNG_BYTES)).toBe(true);

    // The estimate was asked first with the very body that was then sent.
    expect(fake.requests('POST', '/estimate/')[0]?.body).toEqual(fake.generations[0]?.body);
    expect(fake.generations[0]?.body).toEqual({
      prompt: 'a dusty skylight',
      aspect_ratio: '9:16',
      resolution: '720p',
    });
    // Booked before the request left: one entry, no request id yet.
    expect(booked).not.toBeNull();
    const beforeSend = booked as unknown as ReturnType<typeof spendOf>;
    expect(beforeSend.entries).toHaveLength(1);
    expect(beforeSend.entries[0]).toMatchObject({
      kind: 'keyframe',
      slug: SLUG_SOUL,
      usd: 0.004,
      requestId: null,
      refunded: false,
      state: 'booked',
    });
    // After: the same entry, finished.
    const after = spendOf(job);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({
      kind: 'keyframe',
      usd: 0.004,
      requestId: fake.generations[0]?.id,
      refunded: false,
      state: 'completed',
      file: 'keyframes/K1.png',
    });
    expect(after.total).toBe(0.004);
    expect(after.entries[0]?.body).toBeUndefined();
    expect(generateSpendSchema.parse(after).total).toBe(sharedSpendTotal(after.entries));
  });

  it('puts a look in looks/ and a retake as K1-take2', async () => {
    const job = newJob();

    const look = await shots(stillArgs(job.edit, 'homeowner', ['--into', 'looks']));
    const take1 = await shots(stillArgs(job.edit, 'K1'));
    const take2 = await shots(stillArgs(job.edit, 'K1', ['--take', '2'], 'a different skylight'));

    expect(look.line).toMatchObject({ ok: true, file: 'looks/homeowner.png' });
    expect(take1.line).toMatchObject({ file: 'keyframes/K1.png', take: 1 });
    expect(take2.line).toMatchObject({ ok: true, file: 'keyframes/K1-take2.png', take: 2 });
    expect(existsSync(join(job.gen, 'looks', 'homeowner.png'))).toBe(true);
    expect(existsSync(join(job.gen, 'keyframes', 'K1-take2.png'))).toBe(true);
    expect(spendOf(job).entries.map((entry) => entry.kind)).toEqual([
      'look',
      'keyframe',
      'keyframe',
    ]);
  });

  it('sends references through the upload flow, in the body of the model that takes them', async () => {
    const job = newJob();

    const out = await shots([
      'still',
      job.edit,
      'K2',
      '--model',
      'qwen-edit',
      '--prompt',
      'same room, lower angle',
      '--ref',
      'keyframes/A-start.png',
      '--ref',
      'keyframes/A-end.png',
      '--aspect',
      '1:1',
      '--budget',
      '3',
    ]);

    expect(out.exit).toBe(0);
    expect(out.line).toMatchObject({ file: 'keyframes/K2.png', usd: 0.04, model: SLUG_QWEN_EDIT });
    const body = fake.generations[0]?.body as { image_urls: string[] };
    expect(body).toMatchObject({
      prompt: 'same room, lower angle',
      aspect_ratio: '1:1',
      resolution: '1k',
      prompt_extend: false,
      enable_thinking: false,
    });
    expect(body.image_urls).toHaveLength(2);
    for (const url of body.image_urls) expect(url.startsWith(`${fake.url}/cdn/`)).toBe(true);
    expect(fake.uploads.size).toBe(2);
  });

  it('defaults to Soul with no reference and to Qwen edit with one', async () => {
    const job = newJob();
    const plain = await shots(['still', job.edit, 'K3', '--prompt', 'a kitchen', '--budget', '3']);
    const edited = await shots([
      'still',
      job.edit,
      'K4',
      '--prompt',
      'add a logo',
      '--ref',
      'keyframes/A-start.png',
      '--budget',
      '3',
    ]);

    expect(plain.line).toMatchObject({ model: SLUG_SOUL });
    expect(edited.line).toMatchObject({ model: SLUG_QWEN_EDIT });
  });

  it('refuses a request that cannot be made before anything is sent: no budget, no prompt, bad id, bad take, a reference the model does not take', async () => {
    const job = newJob();
    const bad = [
      ['still', job.edit, 'K1', '--model', 'soul', '--prompt', 'x'],
      ['still', job.edit, 'K1', '--model', 'soul', '--budget', '3'],
      ['still', job.edit, '../K1', '--model', 'soul', '--prompt', 'x', '--budget', '3'],
      ['still', job.edit, '--model', 'soul', '--prompt', 'x', '--budget', '3'],
      ['still', job.edit, 'K1', '--model', 'soul', '--prompt', 'x', '--budget', '0'],
      ['still', job.edit, 'K1', '--model', 'soul', '--prompt', 'x', '--budget', '3', '--take', '0'],
      [
        'still',
        job.edit,
        'K1',
        '--model',
        'soul',
        '--prompt',
        'x',
        '--budget',
        '3',
        '--into',
        'elsewhere',
      ],
      [
        'still',
        job.edit,
        'K1',
        '--model',
        'soul',
        '--prompt',
        'x',
        '--budget',
        '3',
        '--ref',
        'keyframes/A-start.png',
      ],
      ['still', job.edit, 'K1', '--model', 'qwen-edit', '--prompt', 'x', '--budget', '3'],
      [
        'still',
        job.edit,
        'K1',
        '--model',
        'soul',
        '--prompt',
        'x',
        '--budget',
        '3',
        '--aspect',
        '21:9',
      ],
      ['still', 'relative/edit', 'K1', '--model', 'soul', '--prompt', 'x', '--budget', '3'],
      ['still'],
    ];
    for (const args of bad) {
      const out = await shots(args);
      expect(out.exit, args.join(' ')).toBe(1);
      expect(out.line, args.join(' ')).toMatchObject({ ok: false, code: 'bad_request' });
      expect(out.line.detail, args.join(' ')).toBeTruthy();
    }
    expect(fake.log).toHaveLength(0);
    expect(existsSync(join(job.gen, 'spend.json'))).toBe(false);
  });

  it('answers a take that is already on disk at once, without a request or a charge', async () => {
    const job = newJob();
    await shots(stillArgs(job.edit));
    const before = fake.log.length;
    const spendBefore = readFileSync(join(job.gen, 'spend.json'), 'utf8');

    const again = await shots(stillArgs(job.edit));

    expect(again.exit).toBe(0);
    expect(again.line).toMatchObject({
      ok: true,
      file: 'keyframes/K1.png',
      reused: true,
      usd: 0.004,
    });
    expect(fake.log).toHaveLength(before);
    expect(readFileSync(join(job.gen, 'spend.json'), 'utf8')).toBe(spendBefore);
    expect(fake.generations).toHaveLength(1);
  });

  it('refuses to make the same take again with other settings and says which take to use', async () => {
    const job = newJob();
    await shots(stillArgs(job.edit));

    const other = await shots(stillArgs(job.edit, 'K1', [], 'another prompt'));

    expect(other.exit).toBe(1);
    expect(other.line).toMatchObject({ ok: false, code: 'bad_request' });
    expect(String(other.line.detail)).toContain('use --take 2');
    expect(fake.generations).toHaveLength(1);
    expect(spendOf(job).entries).toHaveLength(1);
  });

  it('ends failed, nsfw or canceled as generation_failed (exit 1), refunded, and not made again by the same command', async () => {
    for (const outcome of ['failed', 'nsfw', 'canceled'] as const) {
      const job = newJob();
      fake.scenario.outcome = outcome;

      const out = await shots(stillArgs(job.edit));

      expect(out.exit, outcome).toBe(1);
      expect(out.line, outcome).toMatchObject({
        ok: false,
        code: 'generation_failed',
        message: generateErrorMessage('generation_failed'),
        status: outcome,
        requestId: fake.generations.at(-1)?.id,
      });
      expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ code: 'generation_failed' });
      expect(existsSync(join(job.gen, 'keyframes', 'K1.png'))).toBe(false);
      const spend = spendOf(job);
      expect(spend.entries[0]).toMatchObject({ state: 'failed', refunded: true, usd: 0.004 });
      expect(spend.total).toBe(0);

      // The request keeps its identity at Higgsfield: the same command is answered from the ledger.
      const before = fake.log.length;
      const again = await shots(stillArgs(job.edit));
      expect(again.exit).toBe(1);
      expect(again.line).toMatchObject({ code: 'generation_failed' });
      expect(fake.log).toHaveLength(before);
      // A new take is a new request and is made (and charged) afresh.
      fake.scenario.outcome = 'completed';
      const retake = await shots(stillArgs(job.edit, 'K1', ['--take', '2']));
      expect(retake.exit).toBe(0);
      expect(spendOf(job).total).toBe(0.004);
    }
  });

  it('answers generation_failed for a request that completes without a file', async () => {
    const job = newJob();
    fake.scenario.noFile = true;
    const out = await shots(stillArgs(job.edit));
    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({ code: 'generation_failed' });
    expect(String(out.line.detail)).toContain('without a file');
  });
});

// --- clip ---------------------------------------------------------------------------------------

describe('clip', () => {
  it('makes an easy clip on Kling 2.5 Turbo: 4 s is rounded UP to 5, the body is the whitelist, the file and its fps are reported', async () => {
    const job = newJob();

    const out = await shots(clipArgs(job.edit, 'A', 'easy', ['--negative', 'morphing']));

    expect(out.exit).toBe(0);
    expect(out.line).toMatchObject({
      ok: true,
      command: 'clip',
      id: 'A',
      take: 1,
      file: 'clips/A/take-1.mp4',
      seconds: 5,
      requestedSeconds: 4,
      rounded: true,
      tier: 'easy',
      model: SLUG_KLING,
      usd: 0.105,
      basis: 'estimate',
      reused: false,
      spentUsd: 0.105,
      budgetUsd: 3,
    });
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ command: 'clip', seconds: 5 });
    expect(readFileSync(join(job.gen, 'clips', 'A', 'take-1.mp4')).equals(BLACK_MP4)).toBe(true);
    const sent = fake.generations[0];
    expect(sent?.slug).toBe(SLUG_KLING);
    expect(sent?.body).toEqual({
      prompt: 'push in',
      image_url: expect.stringMatching(new RegExp(`^${fake.url}/cdn/`)),
      duration: 5,
      negative_prompt: 'morphing',
    });
    const entry = spendOf(job).entries[0];
    expect(entry).toMatchObject({
      kind: 'clip',
      slug: SLUG_KLING,
      usd: 0.105,
      refunded: false,
      state: 'completed',
      id: 'A',
      take: 1,
    });
    if (haveFfprobe) {
      // The real length and frame rate of the file, so the edit can conform clips of different models.
      expect(out.line.fps).toBe(10);
      expect(out.line.durationSec).toBeCloseTo(1, 1);
      expect(out.line.width).toBe(64);
      expect(out.line.height).toBe(64);
    } else {
      expect(out.line.fps).toBeNull();
    }
  });

  it('makes a people clip on Wan 3.0 at 720p, 9:16, no sound, booked at the list price of $0.10 a second', async () => {
    const job = newJob();

    const out = await shots(clipArgs(job.edit, 'B', 'people'));

    expect(out.exit).toBe(0);
    expect(out.line).toMatchObject({
      tier: 'people',
      model: SLUG_WAN,
      seconds: 4,
      rounded: false,
      usd: 0.4,
      basis: 'list',
    });
    expect(fake.generations[0]?.body).toEqual({
      prompt: 'push in',
      image_url: expect.stringContaining(fake.url),
      duration: 4,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
    });
    expect(spendOf(job).entries[0]).toMatchObject({ usd: 0.4, basis: 'list' });
  });

  it('lets a clip be made at another shape (--aspect 1:1) on Wan', async () => {
    const job = newJob();
    const out = await shots(clipArgs(job.edit, 'B', 'people', ['--aspect', '1:1']));
    expect(out.exit).toBe(0);
    expect(fake.generations[0]?.body).toMatchObject({ aspect_ratio: '1:1', resolution: '720p' });
  });

  it('makes a tilt clip on Wan 3.0 with the end frame uploaded and sent as end_image_url', async () => {
    const job = newJob();

    const out = await shots(clipArgs(job.edit, 'T', 'tilt', ['--end', 'keyframes/A-end.png'], '5'));

    expect(out.exit).toBe(0);
    expect(out.line).toMatchObject({ tier: 'tilt', model: SLUG_WAN, seconds: 5, usd: 0.5 });
    const body = fake.generations[0]?.body as Record<string, string | undefined>;
    expect(body.image_url).not.toBe(body.end_image_url);
    expect(body.end_image_url?.startsWith(`${fake.url}/cdn/`)).toBe(true);
    expect(body).toMatchObject({
      duration: 5,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
    });
    expect(fake.uploads.size).toBe(2);
  });

  it('takes the model by its slug as well (the GN0 form), and tells tilt from people by --end', async () => {
    const job = newJob();
    const people = await shots([
      'clip',
      job.edit,
      'A',
      '--model',
      SLUG_WAN,
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '3',
      '--prompt',
      'p',
      '--budget',
      '3',
    ]);
    const tilt = await shots([
      'clip',
      job.edit,
      'B',
      '--model',
      SLUG_WAN,
      '--start',
      'keyframes/A-start.png',
      '--end',
      'keyframes/A-end.png',
      '--seconds',
      '3',
      '--prompt',
      'p',
      '--budget',
      '3',
    ]);

    expect(people.line).toMatchObject({ tier: 'people' });
    expect(tilt.line).toMatchObject({ tier: 'tilt' });
    const mismatch = await shots([
      'clip',
      job.edit,
      'C',
      '--tier',
      'easy',
      '--model',
      SLUG_WAN,
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '5',
      '--prompt',
      'p',
      '--budget',
      '3',
    ]);
    expect(mismatch.line).toMatchObject({ code: 'bad_request' });
  });

  it('refuses what the tier cannot do before anything is uploaded or sent', async () => {
    const job = newJob();
    const bad = [
      clipArgs(job.edit, 'A', 'easy', ['--end', 'keyframes/A-end.png']),
      clipArgs(job.edit, 'A', 'easy', [], '11'),
      clipArgs(job.edit, 'A', 'people', [], '31'),
      clipArgs(job.edit, 'A', 'tilt'),
      clipArgs(job.edit, 'A', 'slow'),
      clipArgs(job.edit, 'A', 'people', ['--ref', 'keyframes/A-end.png']),
      clipArgs(job.edit, 'A', 'people', ['--negative', 'x']),
      clipArgs(job.edit, 'A', 'easy', ['--aspect', '1:1']),
      clipArgs(job.edit, 'A', 'people', ['--aspect', 'adaptive']),
      clipArgs(job.edit, 'A', 'people', ['--take', 'x']),
      without(clipArgs(job.edit, 'A', 'people'), '--budget'),
      without(clipArgs(job.edit, 'A', 'people'), '--prompt'),
      without(clipArgs(job.edit, 'A', 'people'), '--start'),
      without(clipArgs(job.edit, 'A', 'people'), '--seconds'),
      without(clipArgs(job.edit, 'A', 'people'), '--tier'),
      clipArgs(job.edit, 'not a valid id', 'people'),
    ];
    for (const args of bad) {
      const out = await shots(args);
      expect(out.exit, args.join(' ')).toBe(1);
      expect(out.line, args.join(' ')).toMatchObject({ ok: false, code: 'bad_request' });
      expect(out.line.detail, args.join(' ')).toBeTruthy();
    }
    expect(fake.log).toHaveLength(0);
  });

  it('refuses a start frame that does not exist', async () => {
    const job = newJob();
    const out = await shots(
      clipArgs(job.edit, 'A', 'people').map((arg) =>
        arg === 'keyframes/A-start.png' ? 'keyframes/none.png' : arg,
      ),
    );
    expect(out.exit).toBe(1);
    expect(String(out.line.detail)).toContain('File not found');
    expect(generationPosts()).toHaveLength(0);
  });

  it('keeps the same take on disk: the same command answers reused, a deleted file is fetched again from the finished request', async () => {
    const job = newJob();
    await shots(clipArgs(job.edit, 'A', 'people'));
    const take = join(job.gen, 'clips', 'A', 'take-1.mp4');

    const reused = await shots(clipArgs(job.edit, 'A', 'people'));
    expect(reused.line).toMatchObject({
      ok: true,
      reused: true,
      usd: 0.4,
      fps: haveFfprobe ? 10 : null,
    });

    rmSync(take);
    const fetched = await shots(clipArgs(job.edit, 'A', 'people'));
    expect(fetched.exit).toBe(0);
    expect(fetched.line).toMatchObject({ reused: false });
    expect(existsSync(take)).toBe(true);
    expect(fake.generations).toHaveLength(1);
    expect(generationPosts()).toHaveLength(1);
    expect(spendOf(job).entries).toHaveLength(1);
  });

  it('retakes a failed clip on the other model with a new take', async () => {
    const job = newJob();
    fake.scenario.outcome = 'failed';
    const failed = await shots(clipArgs(job.edit, 'A', 'easy'));
    expect(failed.line).toMatchObject({ code: 'generation_failed' });

    fake.scenario.outcome = 'completed';
    const retake = await shots(clipArgs(job.edit, 'A', 'people', ['--take', '2']));

    expect(retake.exit).toBe(0);
    expect(retake.line).toMatchObject({ file: 'clips/A/take-2.mp4', model: SLUG_WAN, take: 2 });
    const spend = spendOf(job);
    expect(spend.entries.map((entry) => [entry.slug, entry.refunded])).toEqual([
      [SLUG_KLING, true],
      [SLUG_WAN, false],
    ]);
    expect(spend.total).toBe(0.4);
  });

  it('is not fooled by a download that is not a video: the money stays counted and the same command finishes it', async () => {
    const job = newJob();
    fake.scenario.badFile = true;

    const bad = await shots(clipArgs(job.edit, 'A', 'people'));

    expect(bad.exit).toBe(3);
    expect(bad.line).toMatchObject({ code: 'unavailable' });
    expect(existsSync(join(job.gen, 'clips', 'A', 'take-1.mp4'))).toBe(false);
    expect(spendOf(job).entries[0]).toMatchObject({ state: 'submitted', refunded: false });

    fake.scenario.badFile = false;
    const ok = await shots(clipArgs(job.edit, 'A', 'people'));
    expect(ok.exit).toBe(0);
    expect(fake.generations).toHaveLength(1);
  });
});

// --- the money ----------------------------------------------------------------------------------

describe('the budget guard', () => {
  it('refuses with over_budget (exit 2) when spent plus the estimate would pass the budget, and creates nothing', async () => {
    const job = newJob();
    seedSpend(job, 2.9);
    const before = readFileSync(join(job.gen, 'spend.json'), 'utf8');

    const out = await shots(clipArgs(job.edit, 'A', 'people', [], '5'));

    expect(out.exit).toBe(EXIT.refused);
    expect(out.line).toEqual({
      ok: false,
      code: 'over_budget',
      message: generateErrorMessage('over_budget', { needUsd: 3.4, budgetUsd: 3 }),
      needUsd: 3.4,
      budgetUsd: 3,
    });
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({
      code: 'over_budget',
      needUsd: 3.4,
    });
    expect(generationPosts()).toHaveLength(0);
    expect(fake.generations).toHaveLength(0);
    expect(readFileSync(join(job.gen, 'spend.json'), 'utf8')).toBe(before);
    expect(existsSync(join(job.gen, 'clips'))).toBe(false);
    // The estimate (free) was the last thing asked.
    expect(fake.requests('POST', '/estimate/')).toHaveLength(1);
  });

  it('lets a request that lands exactly on the budget through, and counts refunded money as free', async () => {
    const exact = newJob();
    seedSpend(exact, 2.5);
    expect((await shots(clipArgs(exact.edit, 'A', 'people', [], '5'))).exit).toBe(0);
    expect(spendOf(exact).total).toBe(3);

    const refunded = newJob();
    seedSpend(refunded, 5, true);
    expect((await shots(clipArgs(refunded.edit, 'A', 'people', [], '5'))).exit).toBe(0);
    expect(spendOf(refunded).total).toBe(0.5);
  });

  it('keeps one budget across clips made in parallel', async () => {
    const job = newJob();
    const args = (id: string) =>
      clipArgs(job.edit, id, 'people', [], '5').map((arg) => (arg === '3' ? '0.8' : arg));

    const results = await Promise.all([shots(args('A')), shots(args('B'))]);

    const exits = results.map((result) => result.exit).sort();
    expect(exits).toEqual([EXIT.ok, EXIT.refused]);
    const refused = results.find((result) => result.exit === EXIT.refused);
    expect(refused?.line).toMatchObject({ code: 'over_budget', needUsd: 1, budgetUsd: 0.8 });
    expect(spendOf(job).entries).toHaveLength(1);
    expect(spendOf(job).total).toBe(0.5);
    expect(fake.generations).toHaveLength(1);
  });

  it('writes every request of several processes to spend.json: none is lost (the lock)', async () => {
    const job = newJob();

    // Real processes, as the Generate run starts them in parallel: the read-modify-write races only across processes.
    const runs = await Promise.all(
      ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((id) =>
        spawnShots(stillArgs(job.edit, id), envFor()),
      ),
    );

    expect(runs.map((run) => run.code)).toEqual([0, 0, 0, 0, 0, 0]);
    const spend = spendOf(job);
    expect(spend.entries.map((entry) => entry.id).sort()).toEqual([
      'K1',
      'K2',
      'K3',
      'K4',
      'K5',
      'K6',
    ]);
    expect(spend.entries.every((entry) => entry.state === 'completed')).toBe(true);
    expect(spend.total).toBeCloseTo(0.024, 6);
    expect(fake.generations).toHaveLength(6);
    expect(existsSync(join(job.gen, 'spend.json.lock'))).toBe(false);
  });

  it('keeps one budget across processes too: only the clips that fit are made', async () => {
    const job = newJob();
    // Three Wan clips of 0.4, a budget of 1.0: two fit.
    const args = (id: string) =>
      clipArgs(job.edit, id, 'people').map((arg) => (arg === '3' ? '1' : arg));

    const runs = await Promise.all(['A', 'B', 'C'].map((id) => spawnShots(args(id), envFor())));

    expect(runs.map((run) => run.code).sort()).toEqual([0, 0, 2]);
    expect(spendOf(job).entries).toHaveLength(2);
    expect(spendOf(job).total).toBe(0.8);
    expect(fake.generations).toHaveLength(2);
  });

  it('takes over a lock left by a dead process', async () => {
    const job = newJob();
    const lock = join(job.gen, 'spend.json.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 120_000);
    (await import('node:fs')).utimesSync(lock, old, old);

    const out = await shots(stillArgs(job.edit));

    expect(out.exit).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses to guess when spend.json cannot be read', async () => {
    const job = newJob();
    writeFileSync(join(job.gen, 'spend.json'), '{not json');
    const out = await shots(stillArgs(job.edit));
    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({ code: 'bad_request' });
    expect(String(out.line.detail)).toContain('spend.json');
    expect(generationPosts()).toHaveLength(0);
  });
});

// --- errors ---------------------------------------------------------------------------------------

describe('the error mapping', () => {
  it('maps a 401 to key_rejected (exit 2) and records nothing', async () => {
    const job = newJob();
    fake.scenario.rejectKey = true;
    const out = await shots(stillArgs(job.edit));
    expect(out.exit).toBe(2);
    expect(out.line).toMatchObject({
      ok: false,
      code: 'key_rejected',
      message: generateErrorMessage('key_rejected'),
    });
    expect(existsSync(join(job.gen, 'spend.json'))).toBe(false);
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ code: 'key_rejected' });
  });

  it('maps ANY 403 on a submit to balance_empty (exit 2), refunds the booking, and lets the same command go through once funds are added', async () => {
    const job = newJob();
    fake.scenario.emptyBalance = true;

    const out = await shots(clipArgs(job.edit, 'A', 'people'));

    expect(out.exit).toBe(2);
    expect(out.line).toMatchObject({
      ok: false,
      code: 'balance_empty',
      message: generateErrorMessage('balance_empty'),
    });
    expect(out.line.detail).toContain('not_enough_credits');
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ code: 'balance_empty' });
    expect(fake.generations).toHaveLength(0);
    const spend = spendOf(job);
    expect(spend.entries).toHaveLength(1);
    expect(spend.entries[0]).toMatchObject({ state: 'rejected', refunded: true, usd: 0.4 });
    expect(spend.total).toBe(0);
    // The free calls still work: the estimate was answered.
    expect(fake.requests('POST', '/estimate/')).toHaveLength(1);

    fake.scenario.emptyBalance = false;
    const again = await shots(clipArgs(job.edit, 'A', 'people'));
    expect(again.exit).toBe(0);
    const submits = generationPosts();
    expect(submits).toHaveLength(2);
    // A request rejected before it was accepted does not use up its key.
    expect(submits[0]?.headers['idempotency-key']).toBe(submits[1]?.headers['idempotency-key']);
    expect(spendOf(job).total).toBe(0.4);
    expect(spendOf(job).entries.map((entry) => entry.state)).toEqual(['rejected', 'completed']);
  });

  it('maps a 400 from the free estimate to bad_request (exit 1) with the API’s own words, before anything is booked', async () => {
    const job = newJob();
    fake.scenario.badRequest = 'prompt: contains a word the model refuses';

    const out = await shots(clipArgs(job.edit, 'A', 'people'));

    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({
      code: 'bad_request',
      message: generateErrorMessage('bad_request'),
    });
    expect(out.line.detail).toContain('contains a word the model refuses');
    expect(existsSync(join(job.gen, 'spend.json'))).toBe(false);
  });

  it('refunds a booking whose submit is answered 400', async () => {
    const job = newJob();
    const realFetch = globalThis.fetch;
    const out = await shots(clipArgs(job.edit, 'A', 'people'), {
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === 'POST' && path === `/${SLUG_WAN}`) {
          return new Response(JSON.stringify({ detail: 'image_url: could not be fetched' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        return realFetch(url, init);
      },
    });

    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({ code: 'bad_request' });
    expect(out.line.detail).toContain('image_url: could not be fetched');
    expect(spendOf(job).entries[0]).toMatchObject({ state: 'rejected', refunded: true, usd: 0.4 });
    expect(spendOf(job).total).toBe(0);
  });

  it('waits Retry-After on a 429 and sends the SAME request again with the same key, once', async () => {
    const job = newJob();
    fake.scenario.throttle = { times: 2, retryAfter: '7', bodySeconds: null };
    const waits: number[] = [];

    const out = await shots(clipArgs(job.edit, 'A', 'people'), {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(out.exit).toBe(0);
    expect(waits.filter((ms) => ms === 7000)).toHaveLength(2);
    const submits = generationPosts();
    expect(submits).toHaveLength(3);
    const keys = new Set(submits.map((entry) => entry.headers['idempotency-key']));
    expect(keys.size).toBe(1);
    expect(fake.generations).toHaveLength(1);
    expect(spendOf(job).entries).toHaveLength(1);
    expect(spendOf(job).total).toBe(0.4);
  });

  it('reads the wait out of the body when a 429 has no Retry-After header', async () => {
    const job = newJob();
    fake.scenario.throttle = { times: 1, retryAfter: null, bodySeconds: 12 };
    const waits: number[] = [];
    const out = await shots(stillArgs(job.edit), { sleep: async (ms) => void waits.push(ms) });
    expect(out.exit).toBe(0);
    expect(waits).toContain(12000);
  });

  it('retries a 5xx with backoff and the same key, then makes ONE request', async () => {
    const job = newJob();
    fake.scenario.submitStatus = { status: 503, times: 2 };
    const waits: number[] = [];

    const out = await shots(stillArgs(job.edit), { sleep: async (ms) => void waits.push(ms) });

    expect(out.exit).toBe(0);
    expect(waits.slice(0, 2)).toEqual([1, 2]);
    const submits = generationPosts();
    expect(submits).toHaveLength(3);
    expect(new Set(submits.map((entry) => entry.headers['idempotency-key'])).size).toBe(1);
    expect(fake.generations).toHaveLength(1);
  });

  it('retries a free estimate that is answered 5xx', async () => {
    const job = newJob();
    fake.scenario.estimateStatus = { status: 503, times: 2 };
    const out = await shots(['estimate', job.edit, '--kind', 'still', '--model', 'soul']);
    expect(out.exit).toBe(0);
    expect(fake.requests('POST', '/estimate/')).toHaveLength(3);
  });

  it('answers unavailable (exit 3) when a 5xx never stops, keeps the money counted, and the same command finishes it later with one request', async () => {
    const job = newJob();
    fake.scenario.submitStatus = { status: 503, times: 99 };

    const out = await shots(clipArgs(job.edit, 'A', 'people'));

    expect(out.exit).toBe(3);
    expect(out.line).toMatchObject({
      ok: false,
      code: 'unavailable',
      message: generateErrorMessage('unavailable'),
    });
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ code: 'unavailable' });
    expect(generationPosts()).toHaveLength(4);
    // It may have been accepted: the booking stays.
    expect(spendOf(job).entries[0]).toMatchObject({ state: 'booked', refunded: false, usd: 0.4 });
    expect(spendOf(job).total).toBe(0.4);

    fake.scenario.submitStatus = { status: 503, times: 0 };
    const again = await shots(clipArgs(job.edit, 'A', 'people'));
    expect(again.exit).toBe(0);
    expect(spendOf(job).entries).toHaveLength(1);
    expect(spendOf(job).total).toBe(0.4);
    expect(fake.generations).toHaveLength(1);
  });

  it('survives a lost answer: the connection is cut after Higgsfield took the request, and the retry with the same key finds it', async () => {
    const job = newJob();
    fake.scenario.dropResponse = 1;

    const out = await shots(clipArgs(job.edit, 'A', 'easy'));

    expect(out.exit).toBe(0);
    expect(generationPosts()).toHaveLength(2);
    expect(fake.generations).toHaveLength(1);
    expect(new Set(generationPosts().map((entry) => entry.headers['idempotency-key'])).size).toBe(
      1,
    );
    expect(out.line.requestId).toBe(fake.generations[0]?.id);
    expect(spendOf(job).entries).toHaveLength(1);
    expect(spendOf(job).total).toBe(0.105);
  });

  it('keeps polling through a few 5xx answers of the status call', async () => {
    const job = newJob();
    fake.scenario.statusStatus = { status: 503, times: 2 };
    const out = await shots(stillArgs(job.edit));
    expect(out.exit).toBe(0);
  });

  it('does not follow a status_url an answer names: the key goes only to the API’s own host', async () => {
    const job = newJob();
    fake.scenario.evilStatusUrl = true;
    const out = await shots(stillArgs(job.edit));
    expect(out.exit).toBe(0);
    expect(fake.requests('GET', '/requests/').length).toBeGreaterThan(0);
  });

  it('maps every code to the shared words and exit code', () => {
    for (const code of GENERATE_ERROR_CODES as readonly GenerateErrorCode[]) {
      const words = MESSAGES[code];
      expect(typeof words === 'function' ? words(4.1, 3) : words).toBe(
        generateErrorMessage(code, { needUsd: 4.1, budgetUsd: 3 }),
      );
      expect(EXIT_FOR[code]).toBe(generateExitCode(code));
    }
    expect(EXIT_FOR.pending).toBe(3);
  });
});

// --- resumable ------------------------------------------------------------------------------------

describe('a clip that takes longer than a tool call', () => {
  const resumable = { STUDIO_SHOTS_MAX_WAIT_MS: '120', STUDIO_SHOTS_POLL_MS: '5' };

  it('answers pending (exit 3, not a failure) after its wait, and the SAME command picks the request up: one request, one charge, the file when it is ready', async () => {
    const job = newJob();
    fake.scenario.hold = true;

    const waiting = await shots(clipArgs(job.edit, 'A', 'people'), {}, resumable);

    expect(waiting.exit).toBe(3);
    expect(waiting.line).toMatchObject({
      ok: false,
      code: 'pending',
      requestId: fake.generations[0]?.id,
      id: 'A',
      take: 1,
      kind: 'clip',
    });
    expect(makeShotsLineSchema.parse(waiting.line)).toMatchObject({ code: 'pending' });
    expect(
      parseGenerateScriptLine(makeShotsLineSchema, `${JSON.stringify(waiting.line)}\n`),
    ).toMatchObject({ code: 'pending' });
    expect(existsSync(join(job.gen, 'clips', 'A', 'take-1.mp4'))).toBe(false);
    // Counted while it runs, and recorded as submitted.
    expect(spendOf(job).entries[0]).toMatchObject({
      state: 'submitted',
      requestId: fake.generations[0]?.id,
      refunded: false,
    });
    expect(spendOf(job).total).toBe(0.4);

    // Still running: the same answer, still one request.
    const stillWaiting = await shots(clipArgs(job.edit, 'A', 'people'), {}, resumable);
    expect(stillWaiting.line).toMatchObject({
      code: 'pending',
      requestId: fake.generations[0]?.id,
    });

    // It finishes while nobody is waiting; the next call downloads it.
    fake.scenario.hold = false;
    const done = await shots(clipArgs(job.edit, 'A', 'people'));
    expect(done.exit).toBe(0);
    expect(done.line).toMatchObject({
      ok: true,
      file: 'clips/A/take-1.mp4',
      requestId: fake.generations[0]?.id,
      usd: 0.4,
      reused: false,
    });
    expect(existsSync(join(job.gen, 'clips', 'A', 'take-1.mp4'))).toBe(true);
    expect(fake.generations).toHaveLength(1);
    expect(generationPosts()).toHaveLength(1);
    expect(spendOf(job).entries).toHaveLength(1);
    expect(spendOf(job).total).toBe(0.4);
    expect(spendOf(job).entries[0]?.state).toBe('completed');
  });

  it('still re-attaches when the start frame was uploaded again in between (the key does not depend on the upload URL)', async () => {
    const job = newJob();
    fake.scenario.hold = true;
    await shots(clipArgs(job.edit, 'A', 'people'), {}, resumable);
    // The cached upload goes stale, so the next call uploads the frame again and has a new URL.
    const cache = JSON.parse(readFileSync(join(job.gen, 'uploads.json'), 'utf8'));
    for (const file of Object.values(cache.files) as { at: string }[])
      file.at = '2020-01-01T00:00:00.000Z';
    writeFileSync(join(job.gen, 'uploads.json'), JSON.stringify(cache));
    fake.scenario.hold = false;

    const done = await shots(clipArgs(job.edit, 'A', 'people'));

    expect(done.exit).toBe(0);
    expect(fake.uploads.size).toBe(2);
    expect(fake.generations).toHaveLength(1);
    expect(spendOf(job).entries).toHaveLength(1);
  });

  it('answers unavailable, not pending, when Higgsfield stops answering while a request runs', async () => {
    const job = newJob();
    fake.scenario.hold = true;
    await shots(clipArgs(job.edit, 'A', 'people'), {}, resumable);
    fake.scenario.statusStatus = { status: 503, times: 99 };

    const out = await shots(
      clipArgs(job.edit, 'A', 'people'),
      {},
      { ...resumable, STUDIO_SHOTS_MAX_WAIT_MS: '5000' },
    );

    expect(out.exit).toBe(3);
    expect(out.line).toMatchObject({ code: 'unavailable' });
  });

  it('keeps a finished request’s files after a failure of another clip', async () => {
    const job = newJob();
    const a = await shots(clipArgs(job.edit, 'A', 'people'));
    fake.scenario.outcome = 'failed';
    const b = await shots(clipArgs(job.edit, 'B', 'people'));

    expect(a.exit).toBe(0);
    expect(b.exit).toBe(1);
    expect(existsSync(join(job.gen, 'clips', 'A', 'take-1.mp4'))).toBe(true);
    expect(spendOf(job).total).toBe(0.4);
  });
});

// --- the key is never shown -------------------------------------------------------------------------

describe('the key never leaves the Authorization header', () => {
  it('is in no output line, no log line and no file, whatever happened', async () => {
    const job = newJob();
    const logs: string[] = [];
    const outputs: string[] = [];
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const out = await shots(args, { log: (text) => logs.push(text) }, extra);
      outputs.push(JSON.stringify(out));
      return out;
    };

    await run(['estimate', job.edit, '--kind', 'clip', '--tier', 'people', '--seconds', '4']);
    await run(['upload', job.edit, '--file', 'keyframes/A-start.png']);
    await run(stillArgs(job.edit));
    await run(clipArgs(job.edit, 'A', 'easy'));
    fake.scenario.echoAuthInError = true;
    fake.scenario.badRequest = 'rejected';
    const echoed = await run(clipArgs(job.edit, 'B', 'people'));
    fake.scenario.badRequest = null;
    fake.scenario.echoAuthInError = false;
    fake.scenario.emptyBalance = true;
    await run(clipArgs(job.edit, 'B', 'people'));
    fake.scenario.emptyBalance = false;
    fake.scenario.rejectKey = true;
    await run(stillArgs(job.edit, 'K9'));
    fake.scenario.rejectKey = false;
    seedSpend(job, 3);
    await run(clipArgs(job.edit, 'C', 'people'));
    fake.scenario.hold = true;
    await run(clipArgs(job.edit, 'D', 'easy'), {
      STUDIO_SHOTS_MAX_WAIT_MS: '60',
      STUDIO_SHOTS_POLL_MS: '5',
    });

    // A server that echoes the Authorization header back is answered with the key taken out.
    expect(echoed.line.detail).toContain('[key]');
    expectNoKey(outputs.join('\n'));
    expectNoKey(logs.join('\n'));
    expect(logs.length).toBeGreaterThan(0);
    expectNoKey(allText(job.root));
    // The key is only ever sent as `Authorization: Key <id>:<secret>` to the API, never in a URL or a body.
    for (const entry of fake.log) {
      expect(entry.path).not.toContain(FAKE_KEY);
      expect(JSON.stringify(entry.body)).not.toContain(KEY_PARTS[1] as string);
      expect(JSON.stringify(entry.body)).not.toContain(KEY_PARTS[2] as string);
      if (entry.headers.authorization !== undefined) {
        expect(entry.headers.authorization).toBe(`Key ${FAKE_KEY}`);
      }
    }
    // Not to the storage URL and not to the download either.
    for (const entry of [
      ...fake.requests('PUT', '/s3/'),
      ...fake.requests('GET', '/out/'),
      ...fake.requests('GET', '/cdn/'),
    ]) {
      expect(entry.headers.authorization).toBeUndefined();
    }
  });

  it('takes the key out of the answer line even when a server puts it in a field of its own', async () => {
    const job = newJob();
    const realFetch = globalThis.fetch;

    const out = await shots(stillArgs(job.edit), {
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === 'POST' && path === `/${SLUG_SOUL}`) {
          return new Response(JSON.stringify({ request_id: `rid-${FAKE_KEY}`, status: 'queued' }), {
            status: 200,
          });
        }
        if (path.startsWith('/requests/')) {
          return new Response(JSON.stringify({ status: 'failed', error: `bad ${FAKE_KEY}` }), {
            status: 200,
          });
        }
        return realFetch(url, init);
      },
    });

    expect(out.exit).toBe(1);
    expect(out.line).toMatchObject({ code: 'generation_failed' });
    expect(out.line.requestId).toBe('rid-[key]');
    expectNoKey(JSON.stringify(out));
    expectNoKey(allText(job.root));
  });

  it('is in no stdout or stderr of the real process, and no file it wrote', async () => {
    const job = newJob();
    const env = envFor();

    const ok = await spawnShots(stillArgs(job.edit), env);
    fake.scenario.echoAuthInError = true;
    fake.scenario.badRequest = 'no';
    const bad = await spawnShots(clipArgs(job.edit, 'A', 'people'), env);

    expect(ok.code).toBe(0);
    expect(bad.code).toBe(1);
    for (const run of [ok, bad]) {
      expectNoKey(run.stdout);
      expectNoKey(run.stderr);
    }
    expectNoKey(allText(job.root));
    expect(ok.stderr).toContain('keyframe K1');
    // The argument list never has a key either: the script is started with the PATH and the key in the environment only.
    expect(JSON.stringify(stillArgs(job.edit))).not.toContain(KEY_PARTS[1] as string);
  });
});

// --- the real process -----------------------------------------------------------------------------------

describe('the script as a process', () => {
  it('prints ONE JSON line on stdout, a few progress lines on stderr, and exits 0', async () => {
    const job = newJob();

    const out = await spawnShots(clipArgs(job.edit, 'A', 'people'), envFor());

    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    const line = parseGenerateScriptLine(makeShotsLineSchema, out.stdout);
    expect(line).toMatchObject({ ok: true, command: 'clip', id: 'A', seconds: 4 });
    expect(out.stderr).toContain('clip A take 1: sending');
    expect(out.stderr).toContain('clip A take 1: done (clips/A/take-1.mp4)');
  });

  it('exits 2 for a refusal, 3 for pending and for a service that is down, 1 for a failure', async () => {
    const job = newJob();
    seedSpend(job, 2.9);
    const refused = await spawnShots(clipArgs(job.edit, 'A', 'people'), envFor());
    expect(refused.code).toBe(2);
    expect(parseGenerateScriptLine(makeShotsLineSchema, refused.stdout)).toMatchObject({
      code: 'over_budget',
    });

    const job2 = newJob();
    fake.scenario.hold = true;
    const pending = await spawnShots(
      clipArgs(job2.edit, 'A', 'people'),
      envFor({ STUDIO_SHOTS_MAX_WAIT_MS: '80', STUDIO_SHOTS_POLL_MS: '5' }),
    );
    expect(pending.code).toBe(3);
    expect(parseGenerateScriptLine(makeShotsLineSchema, pending.stdout)).toMatchObject({
      code: 'pending',
    });

    const job3 = newJob();
    fake.scenario.hold = false;
    fake.scenario.submitStatus = { status: 500, times: 99 };
    const down = await spawnShots(clipArgs(job3.edit, 'A', 'people'), envFor());
    expect(down.code).toBe(3);
    expect(parseGenerateScriptLine(makeShotsLineSchema, down.stdout)).toMatchObject({
      code: 'unavailable',
    });

    const failure = await spawnShots(['clip', job3.edit, 'A'], envFor());
    expect(failure.code).toBe(1);
  });

  it('reads the key from the .env named by STUDIO_ENV_FILE when the environment has none (the engine passes the path only)', async () => {
    const job = newJob();
    const file = join(job.root, 'keys.env');
    writeFileSync(file, `OTHER=1\nHIGGSFIELD_API_KEY="${FAKE_KEY}"\n`);
    const env = envFor({ STUDIO_ENV_FILE: file });
    delete (env as Record<string, string | undefined>).HIGGSFIELD_API_KEY;

    const out = await spawnShots(stillArgs(job.edit), env);

    expect(out.code).toBe(0);
    expect(fake.requests('POST', '/estimate/')[0]?.headers.authorization).toBe(`Key ${FAKE_KEY}`);
    expectNoKey(out.stdout + out.stderr);
  });

  it('answers a missing key as key_rejected (exit 2) without any network call', async () => {
    const job = newJob();
    const env = envFor({ STUDIO_ENV_FILE: join(job.root, 'no-such.env') });
    delete (env as Record<string, string | undefined>).HIGGSFIELD_API_KEY;

    const out = await spawnShots(clipArgs(job.edit, 'A', 'people'), env);

    expect(out.code).toBe(2);
    expect(parseGenerateScriptLine(makeShotsLineSchema, out.stdout)).toMatchObject({
      ok: false,
      code: 'key_rejected',
      message: generateErrorMessage('key_rejected'),
    });
    expect(fake.log).toHaveLength(0);
  });

  it('does not send the key to a host other than Higgsfield: a non-loopback HIGGSFIELD_API_BASE is ignored', async () => {
    const job = newJob();
    // With the base ignored it would go to api.higgsfield.ai; the fake must see nothing and the call must not hang.
    const env = envFor({
      HIGGSFIELD_API_BASE: 'https://evil.example',
      HIGGSFIELD_API_KEY: 'not-a-working-key:ignored-secret-123',
      STUDIO_SHOTS_RETRY_MS: '1',
      STUDIO_SHOTS_HTTP_TIMEOUT_MS: '1',
    });
    const out = await spawnShots(
      [
        'estimate',
        '--slug',
        SLUG_KLING,
        '--body',
        '{"prompt":"x","image_url":"https://example.com/a.png"}',
      ],
      env,
    );
    expect(fake.log).toHaveLength(0);
    expect(out.stdout).not.toContain('evil.example');
    expect(out.code === 3 || out.code === 2 || out.code === 1).toBe(true);
    void job;
  });

  it('runs the GN0 stub when STUDIO_GENERATE_FAKE=1: no key, no network', async () => {
    const job = newJob();
    const out = await spawnShots(
      ['still', job.edit, 'K1', '--into', 'keyframes', '--model', 'soul', '--prompt', 'x'],
      { PATH: process.env.PATH ?? '', STUDIO_GENERATE_FAKE: '1' },
    );
    expect(out.code).toBe(0);
    expect(parseGenerateScriptLine(makeShotsLineSchema, out.stdout)).toMatchObject({
      ok: true,
      command: 'still',
    });
    expect(fake.log).toHaveLength(0);
  });
});

describe('the backend on its own', () => {
  it('turns every status into the shared code', async () => {
    const answers: [number, unknown, string][] = [
      [401, { detail: 'Invalid credentials' }, 'key_rejected'],
      [403, { detail: 'not_enough_credits' }, 'balance_empty'],
      [400, { detail: 'bad' }, 'bad_request'],
      [404, { detail: 'Model not found' }, 'bad_request'],
      [422, { detail: 'different parameters' }, 'bad_request'],
    ];
    for (const [status, body, code] of answers) {
      const backend = createBackend({
        key: FAKE_KEY,
        fetch: async () => new Response(JSON.stringify(body), { status }),
      });
      const error = await backend.estimate('x/y', {}).catch((caught) => caught);
      expect(error, String(status)).toBeInstanceOf(ApiError);
      expect(error.code, String(status)).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  it('gives up on a call that is never answered, after the retries, as unavailable', async () => {
    let calls = 0;
    const backend = createBackend({
      key: FAKE_KEY,
      retryMs: 1,
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
    });
    const error = await backend.estimate('x/y', {}).catch((caught) => caught);
    expect(error.code).toBe('unavailable');
    expect(calls).toBe(4);
  });

  it('refuses to wait past the deadline the command was given', async () => {
    const backend = createBackend({
      key: FAKE_KEY,
      deadline: 1_000,
      now: () => 900,
      sleep: async () => {},
      fetch: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
    });
    const error = await backend.estimate('x/y', {}).catch((caught) => caught);
    expect(error.code).toBe('unavailable');
  });

  it('sends Authorization on API calls, and nothing but the upload headers to the storage URL', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const backend = createBackend({
      key: FAKE_KEY,
      base: 'http://127.0.0.1:1',
      fetch: async (url, init) => {
        seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await backend.estimate('a/b', { prompt: 'x' });
    await backend.putFile(
      'https://storage.example/put',
      { 'Content-Type': 'image/png' },
      Buffer.from('x'),
    );
    await backend.download('https://cdn.example/file.mp4');
    expect(seen[0]?.headers.Authorization).toBe(`Key ${FAKE_KEY}`);
    expect(seen[1]?.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(seen[2]?.headers).toEqual({});
  });
});

// --- the plan's credits: book, save, void and put (U27) -------------------------------------------
//
// The Generate run makes pictures and clips through the Higgsfield connector now; these four commands
// keep the files and the ledger. They need no key and no Higgsfield server: the transfers go to the
// `fetch` a test hands in.

/** A plan-credit command in this process, with no API key in its environment. */
function plan(args: string[], fetchImpl?: ShotsIo['fetch'], extra: Record<string, string> = {}) {
  return runShots(args, {
    env: { PATH: process.env.PATH ?? '', STUDIO_SHOTS_RETRY_MS: '1', ...extra },
    log: () => {},
    sleep: async () => {},
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

const CDN_MP4 = 'https://d8j0ntlcm91z4.cloudfront.net/user_x/hf_20261027_clip.mp4';
const CDN_PNG = 'https://d8j0ntlcm91z4.cloudfront.net/user_x/hf_20261027_look.png';

/** A `fetch` that serves a finished file for any address, and remembers the addresses asked for. */
function cdn(body?: Buffer): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(body ?? (String(url).endsWith('.mp4') ? BLACK_MP4 : PNG_BYTES), {
      status: 200,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const bookArgs = (edit: string, id = 'A', more: string[] = []): string[] => [
  'book',
  edit,
  id,
  '--kind',
  'clip',
  '--model',
  'kling3_0',
  '--credits',
  '7.5',
  '--budget',
  '5',
  '--seconds',
  '5',
  ...more,
];

const saveArgs = (edit: string, id = 'A', url = CDN_MP4, more: string[] = []): string[] => [
  'save',
  edit,
  id,
  '--kind',
  'clip',
  '--url',
  url,
  ...more,
];

describe('book (the plan’s credits)', () => {
  it('books the credits at the plan rate before anything is sent, and answers the shared shape', async () => {
    const job = newJob();
    const { line, exit } = await plan(bookArgs(job.edit));
    expect(exit).toBe(EXIT.ok);
    expect(makeShotsLineSchema.safeParse(line).success).toBe(true);
    expect(DEFAULT_USD_PER_CREDIT).toBe(0.056);
    expect(line).toMatchObject({
      command: 'book',
      kind: 'clip',
      id: 'A',
      take: 1,
      model: 'kling3_0',
      credits: 7.5,
      usd: 0.42,
      reused: false,
      spentUsd: 0.42,
      budgetUsd: 5,
      leftUsd: 4.58,
    });
    const spend = spendOf(job);
    expect(generateSpendSchema.safeParse(spend).success).toBe(true);
    expect(spend.total).toBe(0.42);
    expect(spend.entries).toHaveLength(1);
    expect(spend.entries[0]).toMatchObject({
      kind: 'clip',
      slug: 'kling3_0',
      state: 'booked',
      refunded: false,
      requestId: null,
      id: 'A',
      take: 1,
      key: 'clip:A:1',
      basis: 'credits',
      seconds: 5,
      credits: 7.5,
    });
  });

  it('uses the rate the engine passes in the environment', async () => {
    const job = newJob();
    const { line } = await plan(bookArgs(job.edit), undefined, {
      STUDIO_HIGGSFIELD_USD_PER_CREDIT: '0.1',
    });
    expect(line).toMatchObject({ credits: 7.5, usd: 0.75, spentUsd: 0.75 });
    expect(settingsOf({}).usdPerCredit).toBe(DEFAULT_USD_PER_CREDIT);
    expect(settingsOf({ STUDIO_HIGGSFIELD_USD_PER_CREDIT: 'nope' }).usdPerCredit).toBe(
      DEFAULT_USD_PER_CREDIT,
    );
    expect(settingsOf({ STUDIO_HIGGSFIELD_USD_PER_CREDIT: '0' }).usdPerCredit).toBe(
      DEFAULT_USD_PER_CREDIT,
    );
  });

  it('books a take once: asking again is the same booking, not a second one', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    const again = await plan(bookArgs(job.edit));
    expect(again.exit).toBe(EXIT.ok);
    expect(again.line).toMatchObject({ reused: true, spentUsd: 0.42 });
    expect(spendOf(job).entries).toHaveLength(1);
    // A new take is a new booking.
    const second = await plan(bookArgs(job.edit, 'A', ['--take', '2']));
    expect(second.line).toMatchObject({ take: 2, reused: false, spentUsd: 0.84 });
    expect(spendOf(job).entries).toHaveLength(2);
  });

  it('keeps the id of the request the connector made, so a rerun waits for it instead of making the take again', async () => {
    const job = newJob();
    const first = await plan(bookArgs(job.edit));
    expect(first.line).toMatchObject({ state: 'booked', requestId: null, file: null });
    const withJob = await plan(bookArgs(job.edit, 'A', ['--job', 'job-777']));
    expect(withJob.line).toMatchObject({ reused: true, state: 'booked', requestId: 'job-777' });
    // A rerun asks without the id and is told which request to wait for.
    const rerun = await plan(bookArgs(job.edit));
    expect(rerun.line).toMatchObject({ reused: true, requestId: 'job-777', file: null });
    expect(spendOf(job).entries).toHaveLength(1);
    // Once saved, the same question says the take is done and where it is.
    await plan(saveArgs(job.edit), cdn().fetch);
    const done = await plan(bookArgs(job.edit));
    expect(done.line).toMatchObject({
      reused: true,
      state: 'completed',
      requestId: 'job-777',
      file: 'clips/A/take-1.mp4',
    });
    expect(makeShotsLineSchema.safeParse(done.line).success).toBe(true);
  });

  it('refuses a booking that would pass the budget, books nothing and exits 2 (over_budget)', async () => {
    const job = newJob();
    seedSpend(job, 4.8);
    const { line, exit } = await plan(bookArgs(job.edit));
    expect(exit).toBe(EXIT_FOR.over_budget);
    expect(line).toMatchObject({
      ok: false,
      code: 'over_budget',
      needUsd: 5.22,
      budgetUsd: 5,
    });
    expect(line.message).toBe(MESSAGES.over_budget(5.22, 5));
    expect(spendOf(job).entries).toHaveLength(1);
  });

  it('refuses what cannot be booked: no budget, no credits, a bad id or kind', async () => {
    const job = newJob();
    for (const args of [
      without(bookArgs(job.edit), '--budget'),
      without(bookArgs(job.edit), '--credits'),
      without(bookArgs(job.edit), '--model'),
      without(bookArgs(job.edit), '--kind'),
      bookArgs(job.edit, 'WAY-TOO-LONG-FOR-A-CLIP'),
      [...bookArgs(job.edit), '--take', '0'],
    ]) {
      const { line, exit } = await plan(args);
      expect(exit, args.join(' ')).toBe(EXIT.failed);
      expect(line.code).toBe('bad_request');
    }
    expect(existsSync(join(job.gen, 'spend.json'))).toBe(false);
  });
});

describe('save (the plan’s credits)', () => {
  it('downloads a clip to clips/<id>/take-<n>.mp4, marks it completed and measures it', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    const served = cdn();
    const { line, exit } = await plan(
      saveArgs(job.edit, 'A', CDN_MP4, ['--job', 'job-123']),
      served.fetch,
    );
    expect(exit).toBe(EXIT.ok);
    expect(makeShotsLineSchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({
      command: 'save',
      kind: 'clip',
      id: 'A',
      take: 1,
      file: 'clips/A/take-1.mp4',
      model: 'kling3_0',
      credits: 7.5,
      usd: 0.42,
      seconds: 5,
      requestId: 'job-123',
      reused: false,
      spentUsd: 0.42,
    });
    expect(readFileSync(join(job.gen, 'clips', 'A', 'take-1.mp4')).equals(BLACK_MP4)).toBe(true);
    expect(spendOf(job).entries[0]).toMatchObject({
      state: 'completed',
      file: 'clips/A/take-1.mp4',
      requestId: 'job-123',
    });
    if (haveFfprobe) expect(line.durationSec).toBeGreaterThan(0.5);
    expect(served.calls).toEqual([CDN_MP4]);
  });

  it('does not download a saved take again', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    const served = cdn();
    await plan(saveArgs(job.edit), served.fetch);
    const again = await plan(saveArgs(job.edit), served.fetch);
    expect(again.exit).toBe(EXIT.ok);
    expect(again.line).toMatchObject({ reused: true, file: 'clips/A/take-1.mp4' });
    expect(served.calls).toHaveLength(1);
  });

  it.skipIf(!haveFfmpeg || !haveFfprobe)(
    'takes the generated soundtrack out of a saved clip (Kling 4.0 puts one in every clip), keeping the picture',
    async () => {
      const job = newJob();
      const withSound = join(job.root, 'with-sound.mp4');
      const made = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=64x64:d=1:r=24',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-shortest',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          withSound,
        ],
        { encoding: 'utf8' },
      );
      expect(made.status, made.stderr).toBe(0);
      const streams = (file: string, kind: 'a' | 'v') =>
        spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            kind,
            '-show_entries',
            'stream=codec_type',
            '-of',
            'csv=p=0',
            file,
          ],
          { encoding: 'utf8' },
        ).stdout.trim();
      expect(streams(withSound, 'a')).toBe('audio');

      await plan(bookArgs(job.edit));
      const { line, exit } = await plan(saveArgs(job.edit), cdn(readFileSync(withSound)).fetch);
      expect(exit).toBe(EXIT.ok);
      expect(makeShotsLineSchema.safeParse(line).success).toBe(true);
      expect(line).toMatchObject({ file: 'clips/A/take-1.mp4', audio: 'dropped' });
      const saved = join(job.gen, 'clips', 'A', 'take-1.mp4');
      expect(streams(saved, 'a')).toBe('');
      expect(streams(saved, 'v')).toBe('video');
      expect(line.durationSec).toBeGreaterThan(0.5);
      expect(spendOf(job).entries[0]).toMatchObject({ state: 'completed', audio: 'dropped' });
      // Saved again, the answer still says what was done.
      const again = await plan(saveArgs(job.edit), cdn().fetch);
      expect(again.line).toMatchObject({ reused: true, audio: 'dropped' });
    },
  );

  it.skipIf(!haveFfprobe)(
    'says none for a clip that has no audio, and leaves a picture alone',
    async () => {
      const job = newJob();
      await plan(bookArgs(job.edit));
      const clip = await plan(saveArgs(job.edit), cdn().fetch);
      expect(clip.line).toMatchObject({ audio: 'none' });
      const still = (kind: string, take: string) => [
        'book',
        job.edit,
        'K1',
        '--kind',
        kind,
        '--model',
        'soul_2',
        '--credits',
        '0.12',
        '--budget',
        '5',
        '--take',
        take,
      ];
      await plan(still('keyframe', '1'));
      const picture = await plan(
        ['save', job.edit, 'K1', '--kind', 'keyframe', '--url', CDN_PNG],
        cdn().fetch,
      );
      expect(picture.line.audio ?? null).toBeNull();
    },
  );

  it('saves pictures into looks/ and keyframes/, and a later take gets its own name', async () => {
    const job = newJob();
    const served = cdn();
    const bookStill = (kind: string, id: string, more: string[] = []) =>
      plan([
        'book',
        job.edit,
        id,
        '--kind',
        kind,
        '--model',
        'soul_2',
        '--credits',
        '0.12',
        '--budget',
        '5',
        ...more,
      ]);
    const saveStill = (kind: string, id: string, more: string[] = []) =>
      plan(['save', job.edit, id, '--kind', kind, '--url', CDN_PNG, ...more], served.fetch);

    await bookStill('look', 'homeowner');
    expect((await saveStill('look', 'homeowner')).line).toMatchObject({
      file: 'looks/homeowner.png',
    });
    await bookStill('keyframe', 'K1', ['--take', '2']);
    expect((await saveStill('keyframe', 'K1', ['--take', '2'])).line).toMatchObject({
      file: 'keyframes/K1-take2.png',
    });
    expect(existsSync(join(job.gen, 'looks', 'homeowner.png'))).toBe(true);
    expect(existsSync(join(job.gen, 'keyframes', 'K1-take2.png'))).toBe(true);
  });

  it('refuses a save that was not booked first, or from an address that is not Higgsfield’s', async () => {
    const job = newJob();
    const served = cdn();
    const unbooked = await plan(saveArgs(job.edit), served.fetch);
    expect(unbooked.exit).toBe(EXIT.failed);
    expect(String(unbooked.line.detail ?? unbooked.line.message)).toMatch(/book|booked/i);

    await plan(bookArgs(job.edit));
    for (const url of [
      'http://d8j0ntlcm91z4.cloudfront.net/x.mp4',
      'https://evil.example/x.mp4',
      'https://cloudfront.net.evil.example/x.mp4',
      'file:///etc/passwd',
      'not an address',
    ]) {
      const refused = await plan(saveArgs(job.edit, 'A', url), served.fetch);
      expect(refused.exit, url).toBe(EXIT.failed);
      expect(refused.line.code).toBe('bad_request');
    }
    expect(served.calls).toEqual([]);
  });

  it('does not keep a file that is not a video (a page, an expired link): try again, exit 3', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    const served = cdn(Buffer.from('<html>expired</html>'));
    const { line, exit } = await plan(saveArgs(job.edit), served.fetch);
    expect(exit).toBe(EXIT_FOR.unavailable);
    expect(line.code).toBe('unavailable');
    expect(existsSync(join(job.gen, 'clips', 'A', 'take-1.mp4'))).toBe(false);
    expect(spendOf(job).entries[0]?.state).toBe('booked');
  });

  it('tells a link Higgsfield no longer keeps (HTTP 403) from a service that is down (5xx)', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    const gone = await plan(
      saveArgs(job.edit),
      (async () => new Response('', { status: 403 })) as typeof fetch,
    );
    expect(gone.exit).toBe(EXIT.failed);
    expect(String(gone.line.detail)).toMatch(/403/);
    let tries = 0;
    const down = await plan(saveArgs(job.edit), (async () => {
      tries += 1;
      return new Response('', { status: 503 });
    }) as typeof fetch);
    expect(down.exit).toBe(EXIT_FOR.unavailable);
    expect(tries).toBe(3);
  });
});

describe('void (the plan’s credits)', () => {
  it('refunds a take that failed, so it no longer counts, and the take can be booked again', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    const { line, exit } = await plan([
      'void',
      job.edit,
      'A',
      '--kind',
      'clip',
      '--reason',
      'Higgsfield blocked the prompt',
    ]);
    expect(exit).toBe(EXIT.ok);
    expect(makeShotsLineSchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({ command: 'void', refunded: true, spentUsd: 0 });
    const spend = spendOf(job);
    expect(spend.total).toBe(0);
    expect(spend.entries[0]).toMatchObject({ refunded: true, state: 'failed' });

    const again = await plan(bookArgs(job.edit));
    expect(again.line).toMatchObject({ reused: false, spentUsd: 0.42 });
    expect(spendOf(job).entries).toHaveLength(2);
    expect(spendOf(job).total).toBe(0.42);
  });

  it('keeps a saved take: it was made and charged', async () => {
    const job = newJob();
    await plan(bookArgs(job.edit));
    await plan(saveArgs(job.edit), cdn().fetch);
    const { line, exit } = await plan(['void', job.edit, 'A', '--kind', 'clip', '--reason', 'x']);
    expect(exit).toBe(EXIT.failed);
    expect(String(line.detail)).toMatch(/already saved/);
    expect(spendOf(job).total).toBe(0.42);
  });

  it('needs a reason and a booking', async () => {
    const job = newJob();
    expect((await plan(['void', job.edit, 'A', '--kind', 'clip', '--reason', 'x'])).exit).toBe(
      EXIT.failed,
    );
    await plan(bookArgs(job.edit));
    expect((await plan(['void', job.edit, 'A', '--kind', 'clip'])).exit).toBe(EXIT.failed);
  });
});

describe('put (the plan’s credits)', () => {
  const UPLOAD = 'https://upload.higgsfield.ai/user_1/abc.png';

  it('sends the image to the address media_upload gave, with the headers it asked for and no key', async () => {
    const job = newJob();
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const { line, exit } = await plan(
      [
        'put',
        job.edit,
        '--file',
        'keyframes/A-start.png',
        '--url',
        UPLOAD,
        '--header',
        'x-amz-tagging: retention=temporary',
      ],
      fetchImpl,
    );
    expect(exit).toBe(EXIT.ok);
    expect(makeShotsLineSchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({ command: 'put', contentType: 'image/png' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(UPLOAD);
    expect(seen[0]?.init.method).toBe('PUT');
    expect(seen[0]?.init.headers).toEqual({
      'Content-Type': 'image/png',
      'x-amz-tagging': 'retention=temporary',
    });
    expect(Buffer.from(seen[0]?.init.body as Buffer).equals(png(1))).toBe(true);
  });

  it('refuses a file that is not an image, one outside the job, and an address that is not Higgsfield’s', async () => {
    const job = newJob();
    writeFileSync(join(job.gen, 'notes.txt'), 'not an image');
    writeFileSync(join(job.root, 'outside.png'), png(9));
    const served = cdn();
    const put = (file: string, url = UPLOAD) =>
      plan(['put', job.edit, '--file', file, '--url', url], served.fetch);
    expect((await put('notes.txt')).exit).toBe(EXIT.failed);
    expect((await put('missing.png')).exit).toBe(EXIT.failed);
    expect((await put(join(job.root, '..', 'elsewhere.png'))).exit).toBe(EXIT.failed);
    expect((await put('keyframes/A-start.png', 'https://evil.example/put')).exit).toBe(EXIT.failed);
    expect((await put('keyframes/A-start.png', 'http://upload.higgsfield.ai/put')).exit).toBe(
      EXIT.failed,
    );
    expect(served.calls).toEqual([]);
  });
});
