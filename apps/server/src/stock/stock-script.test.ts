import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  STOCK_FILES,
  STOCK_LIMITS,
  type StockItem,
  stockCacheSchema,
  stockCreditLine,
  stockRecordSchema,
} from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creditLine, EXIT, FILES, LIMITS, runStock } from '../../assets/stock/stock.mjs';
import { makeTempDir } from '../test-temp.js';
import { STOCK_SCRIPT } from './stock-assets.js';
import {
  type FakeServices,
  fakeServices,
  JPG_BYTES,
  MP3_BYTES,
  openverseResult,
  UNSPLASH_BASE,
} from './test-utils.js';

let editDir: string;
let fake: FakeServices;
const KEY = 'unsplash-access-key-9';

const env = (over: Record<string, string> = {}) => ({
  UNSPLASH_ACCESS_KEY: KEY,
  STUDIO_ENGINE_RUN: 'run-a',
  ...over,
});
const run = (argv: string[], over: Record<string, string> = {}) =>
  runStock(argv, { env: env(over), fetch: fake.fetch, log: () => {} });

beforeEach(() => {
  editDir = makeTempDir('studio-stock-edit-');
  fake = fakeServices();
});

afterEach(() => {
  editDir = '';
});

const readRecord = () => JSON.parse(readFileSync(join(editDir, FILES.record), 'utf8'));
const readCache = () => JSON.parse(readFileSync(join(editDir, FILES.cache), 'utf8'));

describe('stock script: contract', () => {
  it('agrees with the shared contract', () => {
    expect(LIMITS).toMatchObject({
      searchesPerRun: STOCK_LIMITS.searchesPerRun,
      fetchesPerRun: STOCK_LIMITS.fetchesPerRun,
      resultsPerSearch: STOCK_LIMITS.resultsPerSearch,
      sfxDefaultMaxSeconds: STOCK_LIMITS.sfxDefaultMaxSeconds,
      sfxMaxSeconds: STOCK_LIMITS.sfxMaxSeconds,
      queryMax: STOCK_LIMITS.queryMax,
    });
    expect(FILES).toEqual(STOCK_FILES);
  });

  it('writes the credit line the shared contract writes', () => {
    const item = {
      id: 'sfx-1',
      title: 'Whoosh',
      creator: 'Jane Doe',
      license: 'by',
      source: 'openverse',
    } as StockItem;
    expect(creditLine(item)).toBe(stockCreditLine(item));
    const photo = {
      ...item,
      id: 'photo-1',
      title: '',
      creator: ' ',
      license: 'unsplash',
      source: 'unsplash',
    } as StockItem;
    expect(creditLine(photo)).toBe(stockCreditLine(photo));
  });
});

describe('stock script: sfx and photo searches', () => {
  it('prints candidates with refs and keeps them in the cache', async () => {
    fake.sfxResults = [
      openverseResult({ id: 'a' }),
      openverseResult({ id: 'b', title: 'Click', license: 'cc0' }),
    ];
    const { line, exit } = await run(['sfx', editDir, 'whoosh']);
    expect(exit).toBe(EXIT.ok);
    expect(line).toMatchObject({
      ok: true,
      kind: 'sfx',
      query: 'whoosh',
      cached: false,
      candidates: [
        { ref: 'c1', title: 'Whoosh', creator: 'Jane Doe', license: 'CC BY', seconds: 1.2 },
        { ref: 'c2', title: 'Click', license: 'CC0' },
      ],
    });
    const cache = stockCacheSchema.parse(readCache());
    expect(cache.searches).toHaveLength(1);
    expect(cache.searches[0]).toMatchObject({
      kind: 'sfx',
      query: 'whoosh',
      run: 'run-a',
      options: 'max=15',
    });
    expect(cache.searches[0]?.candidates.map((c) => c.ref)).toEqual(['c1', 'c2']);
  });

  it('answers the same words from the cache without asking the service', async () => {
    await run(['sfx', editDir, 'whoosh']);
    const before = fake.calls.length;
    const { line } = await run(['sfx', editDir, '  Whoosh ']);
    expect(line).toMatchObject({ ok: true, cached: true });
    expect(fake.calls.length).toBe(before);
  });

  it('asks again when the options differ, and numbers refs on across searches', async () => {
    await run(['sfx', editDir, 'whoosh']);
    const { line } = await run(['sfx', editDir, 'whoosh', '--max-seconds', '25']);
    expect(line).toMatchObject({ cached: false, candidates: [{ ref: 'c2' }] });
    expect(new URL(fake.calls.at(-1)?.url ?? '').pathname).toBe('/v1/audio/');
  });

  it('searches photos with an orientation', async () => {
    const { line, exit } = await run([
      'photo',
      editDir,
      'night street',
      '--orientation',
      'portrait',
    ]);
    expect(exit).toBe(EXIT.ok);
    expect(line).toMatchObject({
      ok: true,
      kind: 'photo',
      candidates: [{ ref: 'c1', license: 'Unsplash License', width: 4000, height: 6000 }],
    });
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('orientation')).toBe('portrait');
  });

  it('says so when nothing was found', async () => {
    fake.sfxResults = [];
    const { line, exit } = await run(['sfx', editDir, 'zzzz']);
    expect(exit).toBe(EXIT.ok);
    expect(line).toMatchObject({ ok: true, candidates: [] });
    expect(String(line.message)).toMatch(/Nothing found/);
  });

  it('refuses the seventh search of a run, but a cached one still answers and a new run starts afresh', async () => {
    for (let i = 1; i <= LIMITS.searchesPerRun; i += 1) {
      expect((await run(['sfx', editDir, `word ${i}`])).exit).toBe(EXIT.ok);
    }
    const over = await run(['sfx', editDir, 'one more']);
    expect(over.exit).toBe(EXIT.refused);
    expect(over.line).toMatchObject({ ok: false, code: 'limit_reached' });
    expect((await run(['sfx', editDir, 'word 1'])).exit).toBe(EXIT.ok);
    expect((await run(['sfx', editDir, 'one more'], { STUDIO_ENGINE_RUN: 'run-b' })).exit).toBe(
      EXIT.ok,
    );
  });

  it('refuses bad words and bad options without asking anyone', async () => {
    for (const argv of [
      ['sfx', editDir, ''],
      ['sfx', editDir, 'x'.repeat(STOCK_LIMITS.queryMax + 1)],
      ['sfx', editDir, 'a', '--max-seconds', '31'],
      ['sfx', editDir, 'a', '--max-seconds', 'abc'],
      ['photo', editDir, 'a', '--orientation', 'diagonal'],
      ['sfx', editDir, 'a', '--max-seconds'],
    ]) {
      const { line, exit } = await run(argv);
      expect(exit, argv.join(' ')).toBe(EXIT.failed);
      expect(line).toMatchObject({ ok: false, code: 'bad_request' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('needs the Unsplash key for photos, and Openverse works without keys', async () => {
    const photo = await runStock(['photo', editDir, 'a'], {
      env: { STUDIO_ENV_FILE: join(editDir, 'none.env') },
      fetch: fake.fetch,
      log: () => {},
    });
    expect(photo.exit).toBe(EXIT.refused);
    expect(photo.line).toMatchObject({ ok: false, code: 'key_missing' });
    const sfx = await runStock(['sfx', editDir, 'a'], {
      env: { STUDIO_ENV_FILE: join(editDir, 'none.env') },
      fetch: fake.fetch,
      log: () => {},
    });
    expect(sfx.exit).toBe(EXIT.ok);
    expect(fake.calls.every((c) => c.headers.authorization === undefined)).toBe(true);
  });

  it('reads the keys from the .env file', async () => {
    const file = join(editDir, 'keys.env');
    writeFileSync(
      file,
      'UNSPLASH_ACCESS_KEY=file-key-123456\nOPENVERSE_CLIENT_ID=id1\nOPENVERSE_CLIENT_SECRET=secret1\n',
    );
    const sfx = await runStock(['sfx', editDir, 'a'], {
      env: { STUDIO_ENV_FILE: file },
      fetch: fake.fetch,
      log: () => {},
    });
    expect(sfx.exit).toBe(EXIT.ok);
    expect(fake.calls[0]?.url).toContain('auth_tokens');
    const photo = await runStock(['photo', editDir, 'a'], {
      env: { STUDIO_ENV_FILE: file },
      fetch: fake.fetch,
      log: () => {},
    });
    expect(photo.exit).toBe(EXIT.ok);
    expect(fake.calls.at(-1)?.headers.authorization).toBe('Client-ID file-key-123456');
  });

  it('answers a service that is down or throttling with the exit code for trying later', async () => {
    fake.override = () => new Response('', { status: 429 });
    expect((await run(['sfx', editDir, 'a'])).exit).toBe(EXIT.down);
    fake.override = () => new Response('', { status: 503 });
    expect((await run(['photo', editDir, 'a'])).exit).toBe(EXIT.down);
    fake.override = () => new Response('', { status: 401 });
    expect((await run(['photo', editDir, 'b'])).exit).toBe(EXIT.refused);
    expect(existsSync(join(editDir, FILES.cache))).toBe(false);
  });

  it('never prints a key, even one a service echoes back', async () => {
    fake.override = () => new Response(`bad key ${KEY}`, { status: 400 });
    const { line } = await run(['photo', editDir, 'a']);
    expect(JSON.stringify(line)).not.toContain(KEY);
    expect(line).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('stock script: get', () => {
  it('fetches a sound effect and records who made it', async () => {
    await run(['sfx', editDir, 'whoosh']);
    const { line, exit } = await run(['get', editDir, 'c1']);
    expect(exit).toBe(EXIT.ok);
    expect(line).toMatchObject({
      ok: true,
      already: false,
      item: { id: 'sfx-1', kind: 'sfx', title: 'Whoosh', creator: 'Jane Doe', license: 'CC BY' },
      path: join(editDir, 'stock', 'sfx-1.mp3'),
      credit: 'Whoosh by Jane Doe (CC BY, Openverse)',
    });
    expect(readFileSync(join(editDir, 'stock', 'sfx-1.mp3'))).toEqual(MP3_BYTES);
    const record = stockRecordSchema.parse(readRecord());
    expect(record.items).toHaveLength(1);
    expect(record.items[0]).toMatchObject({
      id: 'sfx-1',
      source: 'openverse',
      sourceId: 'ov-1',
      file: 'sfx-1.mp3',
      license: 'by',
      query: 'whoosh',
      run: 'run-a',
      durationMs: 1200,
    });
  });

  it('fetches a photo, tells Unsplash, and records it', async () => {
    await run(['photo', editDir, 'night']);
    const { line, exit } = await run(['get', editDir, 'c1']);
    expect(exit).toBe(EXIT.ok);
    expect(line).toMatchObject({ ok: true, item: { id: 'photo-1', license: 'Unsplash License' } });
    expect(readFileSync(join(editDir, 'stock', 'photo-1.jpg'))).toEqual(JPG_BYTES);
    const track = fake.calls.find((c) => c.url === `${UNSPLASH_BASE}/photos/ph1/download`);
    expect(track?.headers.authorization).toBe(`Client-ID ${KEY}`);
    const fileCall = fake.calls.find((c) => c.url.startsWith('https://images.unsplash.com/'));
    expect(fileCall?.headers.authorization).toBeUndefined();
    expect(stockRecordSchema.parse(readRecord()).items[0]).toMatchObject({
      kind: 'photo',
      source: 'unsplash',
      creator: 'Sam Lee',
      width: 4000,
    });
  });

  it('still gives the photo when Unsplash cannot be told, and says so', async () => {
    await run(['photo', editDir, 'night']);
    fake.override = (call) =>
      call.url.endsWith('/download') ? new Response('', { status: 500 }) : null;
    const { line, exit } = await run(['get', editDir, 'c1']);
    expect(exit).toBe(EXIT.ok);
    expect(String(line.note)).toMatch(/Unsplash could not be told/);
  });

  it('gives the same item for the same ref without downloading again', async () => {
    await run(['sfx', editDir, 'whoosh']);
    await run(['get', editDir, 'c1']);
    const calls = fake.calls.length;
    const again = await run(['get', editDir, 'c1']);
    expect(again.line).toMatchObject({ ok: true, already: true, item: { id: 'sfx-1' } });
    expect(fake.calls.length).toBe(calls);
    expect(stockRecordSchema.parse(readRecord()).items).toHaveLength(1);
  });

  it('numbers each kind on its own', async () => {
    await run(['sfx', editDir, 'a']);
    await run(['photo', editDir, 'b']);
    await run(['get', editDir, 'c1']);
    const { line } = await run(['get', editDir, 'c2']);
    expect(line).toMatchObject({ item: { id: 'photo-1' } });
  });

  it('takes the file type from the source, else from the downloaded type, else refuses', async () => {
    fake.sfxResults = [
      openverseResult({ id: 'w', filetype: 'wav', url: 'https://cdn.example.org/w.wav' }),
    ];
    fake.override = (call) =>
      call.url.endsWith('/w.wav')
        ? new Response('RIFF', { headers: { 'content-type': 'audio/x-wav' } })
        : null;
    await run(['sfx', editDir, 'a']);
    expect((await run(['get', editDir, 'c1'])).line).toMatchObject({
      path: join(editDir, 'stock', 'sfx-1.wav'),
    });

    fake.sfxResults = [
      openverseResult({ id: 'x', filetype: 'exe', url: 'https://cdn.example.org/x' }),
    ];
    fake.override = (call) =>
      call.url.endsWith('/x')
        ? new Response('MZ', { headers: { 'content-type': 'application/octet-stream' } })
        : null;
    await run(['sfx', editDir, 'b']);
    const refused = await run(['get', editDir, 'c2']);
    expect(refused.exit).toBe(EXIT.failed);
    expect(refused.line).toMatchObject({ code: 'bad_request' });
    expect(existsSync(join(editDir, 'stock', 'sfx-2.exe'))).toBe(false);
  });

  it('refuses the ninth file of a run', async () => {
    for (let i = 1; i <= LIMITS.fetchesPerRun + 1; i += 1) {
      fake.sfxResults = [openverseResult({ id: `id-${i}` })];
      await run(['sfx', editDir, `w${i}`], { STUDIO_ENGINE_RUN: `search-${i}` });
    }
    for (let i = 1; i <= LIMITS.fetchesPerRun; i += 1) {
      expect((await run(['get', editDir, `c${i}`])).exit).toBe(EXIT.ok);
    }
    const over = await run(['get', editDir, `c${LIMITS.fetchesPerRun + 1}`]);
    expect(over.exit).toBe(EXIT.refused);
    expect(over.line).toMatchObject({ code: 'limit_reached' });
    expect(
      (await run(['get', editDir, `c${LIMITS.fetchesPerRun + 1}`], { STUDIO_ENGINE_RUN: 'run-b' }))
        .exit,
    ).toBe(EXIT.ok);
  });

  it('refuses a ref no search printed, and a malformed one', async () => {
    expect((await run(['get', editDir, 'c9'])).line).toMatchObject({ code: 'not_found' });
    expect((await run(['get', editDir, 'sfx-1'])).line).toMatchObject({ code: 'bad_request' });
    expect((await run(['get', editDir])).line).toMatchObject({ code: 'bad_request' });
  });

  it('does not leave a record behind when the download fails', async () => {
    await run(['sfx', editDir, 'a']);
    fake.override = (call) =>
      call.url.endsWith('whoosh.mp3') ? new Response('', { status: 500 }) : null;
    const { exit } = await run(['get', editDir, 'c1']);
    expect(exit).toBe(EXIT.down);
    expect(existsSync(join(editDir, FILES.record))).toBe(false);
    expect(existsSync(join(editDir, 'stock', 'sfx-1.mp3'))).toBe(false);
  });
});

describe('stock script: list and arguments', () => {
  it('lists what the job fetched, and nothing for a job that fetched nothing', async () => {
    expect((await run(['list', editDir])).line).toEqual({ ok: true, items: [] });
    await run(['sfx', editDir, 'a']);
    await run(['get', editDir, 'c1']);
    const { line } = await run(['list', editDir]);
    expect(line).toEqual({
      ok: true,
      items: [
        {
          id: 'sfx-1',
          kind: 'sfx',
          path: join(editDir, 'stock', 'sfx-1.mp3'),
          credit: 'Whoosh by Jane Doe (CC BY, Openverse)',
        },
      ],
    });
  });

  it('reads a broken cache or record as empty', async () => {
    await run(['sfx', editDir, 'a']);
    writeFileSync(join(editDir, FILES.cache), '{ not json');
    writeFileSync(join(editDir, FILES.record), '[]');
    expect((await run(['list', editDir])).line).toEqual({ ok: true, items: [] });
    const { line } = await run(['sfx', editDir, 'a']);
    expect(line).toMatchObject({ ok: true, cached: false });
  });

  it('refuses an unknown command and a folder that is not an absolute existing one', async () => {
    expect((await run(['music', editDir])).line).toMatchObject({ code: 'bad_request' });
    expect((await run([])).exit).toBe(EXIT.failed);
    expect((await run(['sfx', 'edit', 'a'])).exit).toBe(EXIT.failed);
    expect((await run(['sfx', join(editDir, 'missing'), 'a'])).exit).toBe(EXIT.failed);
    expect((await run(['sfx', join(editDir, FILES.record), 'a'])).exit).toBe(EXIT.failed);
  });
});

describe('stock script: as a process', () => {
  let server: Server | null = null;

  afterEach(async () => {
    const closing = server;
    server = null;
    if (closing) await new Promise<void>((done) => closing.close(() => done()));
  });

  const start = async (): Promise<string> => {
    const made = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/v1/audio/')) {
        const { port } = made.address() as { port: number };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            results: [openverseResult({ url: `http://127.0.0.1:${port}/file.mp3` })],
          }),
        );
      } else if (url === '/file.mp3') {
        res.setHeader('content-type', 'audio/mpeg');
        res.end(MP3_BYTES);
      } else {
        res.statusCode = 404;
        res.end('no');
      }
    });
    server = made;
    await new Promise<void>((done) => made.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(made.address() as { port: number }).port}`;
  };

  const node = (args: string[], over: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [STOCK_SCRIPT, ...args], {
        env: { PATH: process.env.PATH ?? '', STUDIO_ENV_FILE: join(editDir, 'none.env'), ...over },
      });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.on('close', (code) => done({ code, out }));
    });

  it('prints one JSON line and exits 0, finds, fetches and lists', async () => {
    const base = await start();
    const over = { OPENVERSE_API_BASE: base };
    const found = await node(['sfx', editDir, 'whoosh'], over);
    expect(found.code).toBe(0);
    expect(JSON.parse(found.out)).toMatchObject({ ok: true, candidates: [{ ref: 'c1' }] });

    const got = await node(['get', editDir, 'c1'], over);
    expect(got.code).toBe(0);
    expect(JSON.parse(got.out)).toMatchObject({ ok: true, item: { id: 'sfx-1' } });
    expect(readFileSync(join(editDir, 'stock', 'sfx-1.mp3'))).toEqual(MP3_BYTES);

    const listed = await node(['list', editDir], over);
    expect(JSON.parse(listed.out).items).toHaveLength(1);
  });

  it('exits 2 and says why without a photo key', async () => {
    const result = await node(['photo', editDir, 'night'], {});
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, code: 'key_missing' });
  });
});

describe('stock script: the fake services (STUDIO_STOCK_FAKE=1)', () => {
  const fakeRun = (argv: string[]) =>
    runStock(argv, {
      env: {
        STUDIO_STOCK_FAKE: '1',
        STUDIO_ENV_FILE: join(editDir, 'none.env'),
        STUDIO_ENGINE_RUN: 'r',
      },
      log: () => {},
    });

  it('finds and fetches both kinds with no key and no network', async () => {
    const sfx = await fakeRun(['sfx', editDir, 'anything']);
    expect(sfx.line).toMatchObject({
      ok: true,
      candidates: [
        { ref: 'c1', license: 'CC BY' },
        { ref: 'c2', license: 'CC0' },
      ],
    });
    const photo = await fakeRun(['photo', editDir, 'anything']);
    expect(photo.line).toMatchObject({ ok: true, candidates: [{ ref: 'c3' }, { ref: 'c4' }] });

    expect((await fakeRun(['get', editDir, 'c1'])).line).toMatchObject({
      ok: true,
      item: { id: 'sfx-1' },
    });
    expect((await fakeRun(['get', editDir, 'c3'])).line).toMatchObject({
      ok: true,
      item: { id: 'photo-1' },
    });
    expect(existsSync(join(editDir, 'stock', 'sfx-1.wav'))).toBe(true);
    expect(readFileSync(join(editDir, 'stock', 'photo-1.jpg'))[0]).toBe(0xff);
    expect(stockRecordSchema.parse(readRecord()).items).toHaveLength(2);
  });

  it('holds the same limits and the same cache as the real services', async () => {
    await fakeRun(['sfx', editDir, 'a']);
    expect((await fakeRun(['sfx', editDir, 'a'])).line).toMatchObject({ cached: true });
  });

  it('is off unless asked for: a photo search still needs the key', async () => {
    const { exit } = await runStock(['photo', editDir, 'a'], {
      env: { STUDIO_ENV_FILE: join(editDir, 'none.env') },
      log: () => {},
      fetch: fake.fetch,
    });
    expect(exit).toBe(EXIT.refused);
  });
});
