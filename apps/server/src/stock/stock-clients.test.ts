import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  audioFileType,
  createOpenverse,
  openverseBase,
  toCandidate as sfxCandidate,
} from '../../assets/stock/openverse.mjs';
import {
  apiBase,
  clipTitle,
  dotenvValue,
  downloadAllowed,
  downloadBytes,
  envFile,
  readKey,
  redact,
  rememberSecret,
  StockError,
} from '../../assets/stock/stock-env.mjs';
import {
  createUnsplash,
  toCandidate as photoCandidate,
  photoFileUrl,
  unsplashBase,
  withUtm,
} from '../../assets/stock/unsplash.mjs';
import { makeTempDir } from '../test-temp.js';
import {
  fakeServices,
  OPENVERSE_BASE,
  openverseResult,
  PHOTO_FILE_URL,
  UNSPLASH_BASE,
  unsplashResult,
} from './test-utils.js';

describe('clipTitle', () => {
  it('keeps a short title, makes it one line, and cuts a long one at a word', () => {
    expect(clipTitle('  Glistening   Pavement ')).toBe('Glistening Pavement');
    expect(clipTitle('two\nlines')).toBe('two lines');
    expect(clipTitle(null)).toBe('');
    const long =
      'Warsaw streets at night are great! Especially in the center, surrounded by tall skyscrapers. Warsaw is one of the highest cities in Europe.';
    const clipped = clipTitle(long);
    expect(clipped.length).toBeLessThanOrEqual(90);
    expect(clipped.endsWith('…')).toBe(true);
    expect(long.startsWith(clipped.slice(0, -1))).toBe(true);
    expect(clipTitle('x'.repeat(200)).length).toBe(90);
  });
});

describe('stock-env', () => {
  it('reads a key from the environment first, then from the .env file', () => {
    const dir = makeTempDir('studio-stock-env-');
    const file = join(dir, '.env');
    writeFileSync(file, 'UNSPLASH_ACCESS_KEY="from-file-key"\n# comment\nOTHER=1\n');
    expect(readKey('UNSPLASH_ACCESS_KEY', { UNSPLASH_ACCESS_KEY: 'from-env-key' }, file)).toBe(
      'from-env-key',
    );
    expect(readKey('UNSPLASH_ACCESS_KEY', {}, file)).toBe('from-file-key');
    expect(readKey('MISSING', {}, file)).toBeNull();
    expect(readKey('UNSPLASH_ACCESS_KEY', {}, join(dir, 'nope.env'))).toBeNull();
  });

  it('parses a .env text', () => {
    expect(dotenvValue("export A='x y'\nB=2\n#C=3", 'A')).toBe('x y');
    expect(dotenvValue('B=2', 'C')).toBeNull();
  });

  it('finds the .env named by STUDIO_ENV_FILE, absolute or under home', () => {
    expect(envFile({ STUDIO_ENV_FILE: '/x/.env' }, '/home/a')).toBe('/x/.env');
    expect(envFile({ STUDIO_ENV_FILE: '~/k.env' }, '/home/a')).toBe('/home/a/k.env');
    expect(envFile({ STUDIO_ENV_FILE: 'relative.env' }, '/home/a')).toMatch(/\.env$/);
    expect(envFile({ STUDIO_ENV_FILE: 'relative.env' }, '/home/a')).not.toBe('relative.env');
  });

  it('takes remembered keys and bearer tokens out of any text', () => {
    rememberSecret('super-secret-value');
    expect(redact('key super-secret-value here')).toBe('key [key] here');
    expect(redact('Authorization: Bearer abcdef123456')).toBe('Authorization: Bearer [key]');
    expect(redact('Authorization: Client-ID abcdef123456')).toBe('Authorization: Client-ID [key]');
  });

  it('honours an API override only for a loopback http address', () => {
    expect(apiBase('https://a.example', 'http://127.0.0.1:5000/')).toBe('http://127.0.0.1:5000');
    expect(apiBase('https://a.example', 'http://evil.example')).toBe('https://a.example');
    expect(apiBase('https://a.example', 'https://127.0.0.1')).toBe('https://a.example');
    expect(openverseBase({ OPENVERSE_API_BASE: 'http://localhost:1' })).toBe('http://localhost:1');
    expect(unsplashBase({})).toBe(UNSPLASH_BASE);
  });

  it('downloads only from https, or from this machine', () => {
    expect(downloadAllowed('https://cdn.example.org/a.mp3')).toBe(true);
    expect(downloadAllowed('http://127.0.0.1:9/a.mp3')).toBe(true);
    expect(downloadAllowed('http://cdn.example.org/a.mp3')).toBe(false);
    expect(downloadAllowed('file:///etc/passwd')).toBe(false);
    expect(downloadAllowed('not a url')).toBe(false);
  });

  it('refuses a download of the wrong type, too big or empty', async () => {
    const serve = (body: string, type: string, length?: string) =>
      (async () =>
        new Response(body, {
          headers: { 'content-type': type, ...(length ? { 'content-length': length } : {}) },
        })) as unknown as typeof fetch;
    const audio = { maxBytes: 10, typeOk: (t: string) => t.startsWith('audio/') };
    await expect(
      downloadBytes(serve('x', 'text/html'), 'https://a.example/f', audio),
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      downloadBytes(serve('x', 'audio/mpeg', '999'), 'https://a.example/f', audio),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      downloadBytes(serve('x'.repeat(20), 'audio/mpeg'), 'https://a.example/f', audio),
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      downloadBytes(serve('', 'audio/mpeg'), 'https://a.example/f', audio),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      downloadBytes(serve('x', 'audio/mpeg'), 'http://a.example/f', audio),
    ).rejects.toBeInstanceOf(StockError);
    const ok = await downloadBytes(
      serve('abc', 'audio/mpeg; charset=x'),
      'https://a.example/f',
      audio,
    );
    expect(ok.bytes.toString()).toBe('abc');
    expect(ok.type).toBe('audio/mpeg');
  });
});

describe('openverse (sound effects)', () => {
  it('asks for short CC0, public domain and CC BY sound effects, as a registered application', async () => {
    const fake = fakeServices();
    const client = createOpenverse({ clientId: 'cid', clientSecret: 'csecret', fetch: fake.fetch });
    const found = await client.searchSfx('whoosh', { maxSeconds: 15, limit: 8 });

    const [token, search] = fake.calls;
    expect(token?.url).toBe(`${OPENVERSE_BASE}/v1/auth_tokens/token/`);
    expect(token?.method).toBe('POST');
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(token?.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(token?.body).get('client_id')).toBe('cid');

    const url = new URL(search?.url ?? '');
    expect(url.pathname).toBe('/v1/audio/');
    expect(url.searchParams.get('q')).toBe('whoosh');
    // By source, never `category=sound_effect`: Openverse leaves every Freesound sound's category empty.
    expect(url.searchParams.get('source')).toBe('freesound');
    expect(url.searchParams.has('category')).toBe(false);
    expect(url.searchParams.get('length')).toBe('shortest');
    expect(url.searchParams.get('license')).toBe('cc0,pdm,by');
    expect(url.searchParams.get('mature')).toBe('false');
    expect(search?.headers.authorization).toBe('Bearer ov-token-123456');

    expect(found).toEqual([
      {
        sourceId: 'ov-1',
        title: 'Whoosh',
        creator: 'Jane Doe',
        creatorUrl: 'https://freesound.org/people/jane/',
        license: 'by',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        sourceUrl: 'https://freesound.org/s/1/',
        downloadUrl: 'https://cdn.example.org/whoosh.mp3',
        trackUrl: null,
        fileType: 'mp3',
        durationMs: 1200,
        width: null,
        height: null,
      },
    ]);
  });

  it('asks the token once and works anonymously without keys', async () => {
    const fake = fakeServices();
    const registered = createOpenverse({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch });
    await registered.searchSfx('a', { maxSeconds: 15, limit: 2 });
    await registered.searchSfx('b', { maxSeconds: 15, limit: 2 });
    expect(fake.calls.filter((c) => c.url.includes('auth_tokens'))).toHaveLength(1);

    const anon = fakeServices();
    await createOpenverse({ fetch: anon.fetch }).searchSfx('a', { maxSeconds: 15, limit: 2 });
    expect(anon.calls).toHaveLength(1);
    expect(anon.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('keeps only what an edit may use: license, length, url', () => {
    const keep = (over: Record<string, unknown>) =>
      sfxCandidate(openverseResult(over), { maxMs: 15_000 });
    expect(keep({})).not.toBeNull();
    expect(keep({ license: 'cc0' })?.license).toBe('cc0');
    expect(keep({ license: 'pdm' })?.license).toBe('pdm');
    expect(keep({ license: 'by-nc' })).toBeNull();
    expect(keep({ license: 'by-nd' })).toBeNull();
    expect(keep({ license: 'sampling+' })).toBeNull();
    expect(keep({ duration: 15_001 })).toBeNull();
    expect(keep({ duration: 15_000 })).not.toBeNull();
    expect(keep({ duration: null })).toBeNull();
    expect(keep({ duration: 0 })).toBeNull();
    expect(keep({ url: null })).toBeNull();
    // A sound with no category is Freesound's; one Openverse calls music or speech is not a sound effect.
    expect(keep({ category: null })).not.toBeNull();
    expect(keep({ category: 'sound_effect' })).not.toBeNull();
    for (const category of ['music', 'podcast', 'audiobook', 'news', 'pronunciation']) {
      expect(keep({ category }), category).toBeNull();
    }
    expect(keep({ creator: null })?.creator).toBe('');
    expect(sfxCandidate(null, { maxMs: 1 })).toBeNull();
  });

  it('stops at the limit it was given', async () => {
    const fake = fakeServices();
    fake.sfxResults = [1, 2, 3, 4].map((n) => openverseResult({ id: `ov-${n}` }));
    const found = await createOpenverse({ fetch: fake.fetch }).searchSfx('a', {
      maxSeconds: 15,
      limit: 3,
    });
    expect(found.map((c) => c.sourceId)).toEqual(['ov-1', 'ov-2', 'ov-3']);
  });

  it('knows a sound file type from its name, its mime type or a dot', () => {
    expect(audioFileType('MP3')).toBe('mp3');
    expect(audioFileType('audio/mpeg')).toBe('mp3');
    expect(audioFileType('.wav')).toBe('wav');
    expect(audioFileType('audio/x-wav')).toBe('wav');
    expect(audioFileType('exe')).toBeNull();
    expect(audioFileType(undefined)).toBeNull();
  });

  it('turns the services answers into the codes the script uses', async () => {
    const asked = async (status: number, body = '') => {
      const fake = fakeServices();
      fake.override = () => new Response(body, { status });
      return createOpenverse({ fetch: fake.fetch })
        .searchSfx('a', { maxSeconds: 15, limit: 2 })
        .then(
          () => 'ok',
          (error: StockError) => error.code,
        );
    };
    expect(await asked(429)).toBe('rate_limited');
    expect(await asked(401)).toBe('key_rejected');
    expect(await asked(500)).toBe('unavailable');
    expect(await asked(400, 'bad q')).toBe('bad_request');

    const down = fakeServices();
    down.override = () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      createOpenverse({ fetch: down.fetch }).searchSfx('a', { maxSeconds: 15, limit: 2 }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects a token answer without a token', async () => {
    const fake = fakeServices();
    fake.override = (call) =>
      call.url.includes('auth_tokens') ? new Response('{}', { status: 200 }) : null;
    await expect(
      createOpenverse({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch }).searchSfx('a', {
        maxSeconds: 15,
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: 'key_rejected' });
  });
});

describe('unsplash (photos)', () => {
  it('searches with the access key and says what it wants', async () => {
    const fake = fakeServices();
    const client = createUnsplash({ accessKey: 'unsplash-key-1', fetch: fake.fetch });
    const found = await client.searchPhotos('night street', { orientation: 'portrait', limit: 5 });

    const call = fake.calls[0];
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe(`${UNSPLASH_BASE}/search/photos`);
    expect(url.searchParams.get('query')).toBe('night street');
    expect(url.searchParams.get('orientation')).toBe('portrait');
    expect(url.searchParams.get('content_filter')).toBe('high');
    expect(call?.headers.authorization).toBe('Client-ID unsplash-key-1');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sourceId: 'ph1',
      title: 'A street at night',
      creator: 'Sam Lee',
      creatorUrl: 'https://unsplash.com/@sam?utm_source=studio_engine&utm_medium=referral',
      license: 'unsplash',
      licenseUrl: 'https://unsplash.com/license',
      sourceUrl: 'https://unsplash.com/photos/ph1?utm_source=studio_engine&utm_medium=referral',
      trackUrl: `${UNSPLASH_BASE}/photos/ph1/download`,
      width: 4000,
      height: 6000,
      durationMs: null,
    });
  });

  it('downloads the raw photo as a 2160 px JPEG and keeps its ixid', () => {
    const url = new URL(photoFileUrl(`${PHOTO_FILE_URL}?ixid=abc123`) ?? '');
    expect(url.hostname).toBe('images.unsplash.com');
    expect(url.searchParams.get('ixid')).toBe('abc123');
    expect(url.searchParams.get('w')).toBe('2160');
    expect(url.searchParams.get('fm')).toBe('jpg');
  });

  it('takes only files from Unsplash’s image host', () => {
    expect(photoFileUrl('https://evil.example/p.jpg')).toBeNull();
    expect(photoFileUrl('http://images.unsplash.com/p')).toBeNull();
    expect(photoFileUrl('http://127.0.0.1:1/p')).toBeNull();
    expect(photoFileUrl('http://127.0.0.1:1/p', { allowLoopback: true })).not.toBeNull();
    expect(photoCandidate(unsplashResult({ urls: { raw: 'https://evil.example/p' } }))).toBeNull();
    expect(photoCandidate({ id: 5 })).toBeNull();
  });

  it('adds the referral parameters Unsplash asks for', () => {
    expect(withUtm('https://unsplash.com/@sam')).toContain(
      '?utm_source=studio_engine&utm_medium=referral',
    );
    expect(withUtm('https://unsplash.com/x?a=1')).toContain('?a=1&utm_source=');
    expect(withUtm(undefined)).toBeNull();
  });

  it('cuts a photo’s long description to a line', () => {
    const candidate = photoCandidate(unsplashResult({ description: 'word '.repeat(60) }));
    expect(candidate?.title.length).toBeLessThanOrEqual(90);
    expect(candidate?.title.endsWith('…')).toBe(true);
  });

  it('falls back to the alt text for a title and leaves a missing creator empty', () => {
    const candidate = photoCandidate(
      unsplashResult({ description: null, alt_description: 'a dog', user: {} }),
    );
    expect(candidate?.title).toBe('a dog');
    expect(candidate?.creator).toBe('');
    expect(candidate?.creatorUrl).toBeNull();
  });

  it('tells Unsplash a photo is used, only at Unsplash’s own address', async () => {
    const fake = fakeServices();
    const client = createUnsplash({ accessKey: 'unsplash-key-1', fetch: fake.fetch });
    await client.trackDownload(`${UNSPLASH_BASE}/photos/ph1/download`);
    expect(fake.calls[0]?.url).toBe(`${UNSPLASH_BASE}/photos/ph1/download`);
    expect(fake.calls[0]?.headers.authorization).toBe('Client-ID unsplash-key-1');
    await expect(
      client.trackDownload('https://evil.example/photos/ph1/download'),
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('needs a key, and reports a rate limit as such', async () => {
    expect(() => createUnsplash({ accessKey: null })).toThrow(/UNSPLASH_ACCESS_KEY/);
    const fake = fakeServices();
    fake.override = () => new Response('Rate Limit Exceeded', { status: 403 });
    await expect(
      createUnsplash({ accessKey: 'unsplash-key-1', fetch: fake.fetch }).searchPhotos('a', {
        limit: 3,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    fake.override = () => new Response('', { status: 401 });
    await expect(
      createUnsplash({ accessKey: 'unsplash-key-1', fetch: fake.fetch }).searchPhotos('a', {
        limit: 3,
      }),
    ).rejects.toMatchObject({ code: 'key_rejected' });
  });
});
