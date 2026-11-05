import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../test-temp.js';
import { DM_SLOW_DOWN_MS, DmInbox } from './dm-inbox.js';
import type { FetchLike } from './graph.js';
import { KEY_REFRESH_EVERY_MS } from './key.js';

// The inbox against a fake Instagram (its API and its file server): every call is recorded and
// answered from the tables below, so nothing here reaches the network.

const KEY = 'IGAAtestkey0123456789';
/** A Unified login key: Meta's system-user key, read on graph.facebook.com. */
const META_KEY = 'EAAtestkey0123456789';
const CDN = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=';
/** The start of an MP4 file: what the file server sends for a reel. */
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42isom'),
  Buffer.alloc(64),
]);

interface Call {
  url: URL;
  auth: string | null;
}

interface FakeInstagram {
  calls: Call[];
  fetch: FetchLike;
  /** The answer (or `{ status, error }`) of a graph path, by its path. */
  graph: Map<string, unknown>;
  /** The answer of a file link, by its asset id. */
  files: Map<string, { status?: number; type: string; body: Buffer | string }>;
}

function fakeInstagram(): FakeInstagram {
  const calls: Call[] = [];
  const graph = new Map<string, unknown>([
    ['/me', { id: '17841400000000001', username: 'studio_account' }],
    [
      '/me/conversations',
      {
        data: [
          {
            id: 'c-owner',
            updated_time: '2026-10-30T10:05:00+0000',
            participants: { data: [{ username: 'studio_account' }, { username: 'owner_account' }] },
          },
          {
            id: 'c-client',
            updated_time: '2026-10-30T09:00:00+0000',
            participants: { data: [{ username: 'studio_account' }, { username: 'falcon.fpv' }] },
          },
        ],
      },
    ],
    [
      '/c-owner',
      {
        id: 'c-owner',
        messages: {
          data: [
            {
              id: 'm3',
              created_time: '2026-10-30T10:05:00+0000',
              from: { username: 'studio_account' },
            },
            {
              id: 'm2',
              created_time: '2026-10-30T10:04:00+0000',
              from: { username: 'owner_account' },
            },
            {
              id: 'm1',
              created_time: '2026-10-30T10:00:00+0000',
              from: { username: 'Owner_Account' },
            },
          ],
        },
      },
    ],
    [
      '/c-client',
      {
        id: 'c-client',
        messages: {
          data: [
            {
              id: 'm9',
              created_time: '2026-10-30T09:00:00+0000',
              from: { username: 'falcon.fpv' },
            },
          ],
        },
      },
    ],
    [
      '/m1',
      {
        id: 'm1',
        created_time: '2026-10-30T10:00:00+0000',
        from: { username: 'Owner_Account', id: '1' },
        message: 'for the gym video',
        shares: { data: [{ type: 'ig_reel', name: 'Gym hook', url: `${CDN}reel1` }] },
      },
    ],
    [
      '/m2',
      {
        id: 'm2',
        created_time: '2026-10-30T10:04:00+0000',
        from: { username: 'owner_account', id: '1' },
        message: 'this sound https://www.instagram.com/reels/audio/1043357377036343/',
      },
    ],
    [
      '/m3',
      {
        id: 'm3',
        created_time: '2026-10-30T10:05:00+0000',
        from: { username: 'studio_account', id: '2' },
        message: 'like this one https://www.instagram.com/reel/DfBUU0nDswI/',
      },
    ],
    [
      '/m9',
      {
        id: 'm9',
        created_time: '2026-10-30T09:00:00+0000',
        from: { username: 'falcon.fpv', id: '3' },
        message: 'https://www.instagram.com/reel/FalconReel1/',
      },
    ],
  ]);
  const files = new Map<string, { status?: number; type: string; body: Buffer | string }>([
    ['reel1', { type: 'video/mp4', body: MP4 }],
  ]);
  const fetchFake: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization') });
    if (url.hostname === 'lookaside.fbsbx.com') {
      const file = files.get(url.searchParams.get('asset_id') ?? '');
      if (file === undefined) return new Response('gone', { status: 404 });
      return new Response(file.body, {
        status: file.status ?? 200,
        headers: { 'content-type': file.type },
      });
    }
    if (url.pathname === '/refresh_access_token') {
      return Response.json({
        access_token: 'IGAArefreshed',
        token_type: 'bearer',
        expires_in: 5184000,
      });
    }
    const answer = graph.get(url.pathname);
    if (answer === undefined) {
      return Response.json(
        { error: { message: 'Unsupported get request.', code: 100 } },
        { status: 400 },
      );
    }
    if (typeof answer === 'object' && answer !== null && 'status' in answer && 'error' in answer) {
      const { status, error } = answer as { status: number; error: unknown };
      return Response.json({ error }, { status });
    }
    // A conversation asked for its messages whole: each message as its own path answers it.
    if (url.searchParams.get('fields')?.startsWith('messages{id,created_time,from,message,')) {
      const { messages, ...rest } = answer as { messages: { data: { id: string }[] } };
      const data = messages.data.map((ref) => ({ ...ref, ...(graph.get(`/${ref.id}`) ?? {}) }));
      return Response.json({ ...rest, messages: { data } });
    }
    return Response.json(answer);
  };
  return { calls, fetch: fetchFake, graph, files };
}

function inbox(
  instagram: FakeInstagram,
  options: { env?: Record<string, string>; now?: () => number; dataDir?: string } = {},
) {
  const dataDir = options.dataDir ?? makeTempDir('studio-engine-dms-');
  const envFile = join(dataDir, 'missing.env');
  return new DmInbox({
    dataDir,
    from: ['owner_account'],
    env: { INSTAGRAM_DM_TOKEN: KEY, ...options.env },
    envFile,
    fetch: instagram.fetch,
    now: options.now ?? (() => Date.parse('2026-10-30T10:10:00Z')),
  });
}

describe('DmInbox', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off, and asks Instagram nothing, while .env has no key', async () => {
    const instagram = fakeInstagram();
    const dataDir = makeTempDir('studio-engine-dms-');
    const dms = new DmInbox({
      dataDir,
      from: ['owner_account'],
      env: {},
      envFile: join(dataDir, 'missing.env'),
      fetch: instagram.fetch,
    });
    const answer = await dms.check();
    expect(answer.connection).toMatchObject({ state: 'off', account: null, checkedAt: null });
    expect(answer.connection.from).toEqual(['owner_account']);
    expect(answer.items).toEqual([]);
    expect(instagram.calls).toEqual([]);
  });

  it('keeps only the reels, both ways, newest first, with each one downloaded', async () => {
    const instagram = fakeInstagram();
    const dms = inbox(instagram);
    const answer = await dms.check();

    expect(answer.connection).toMatchObject({
      state: 'connected',
      account: 'studio_account',
      checkedAt: '2026-10-30T10:10:00.000Z',
      error: null,
      everySecs: 60,
    });
    // m2 (a sound) is not a reel; m3 is the studio's own reel to @owner_account.
    expect(answer.items.map((item) => [item.id, item.kind, item.from])).toEqual([
      ['m3:0', 'reel', 'studio_account'],
      ['m1:0', 'reel', 'Owner_Account'],
    ]);
    const [sent, reel] = answer.items;
    expect(sent).toMatchObject({
      at: '2026-10-30T10:05:00.000Z',
      link: 'https://www.instagram.com/reel/DfBUU0nDswI/',
      text: 'like this one https://www.instagram.com/reel/DfBUU0nDswI/',
      file: null,
      missing: null,
    });
    expect(reel).toMatchObject({
      title: 'Gym hook',
      text: 'for the gym video',
      file: { contentType: 'video/mp4', bytes: MP4.length },
      missing: null,
    });
    const name = reel?.file?.name ?? '';
    expect(name).toMatch(/^2026-10-30-reel-[0-9a-f]{10}\.mp4$/);
    expect(readFileSync(join(dms.filesDir, name)).equals(MP4)).toBe(true);
  });

  it("reads only the conversations with a sender, and sends the key only to Instagram's API", async () => {
    const instagram = fakeInstagram();
    await inbox(instagram).check();
    const paths = instagram.calls.map((call) => call.url.pathname);
    const list = instagram.calls.find((call) => call.url.pathname === '/me/conversations');
    expect(list?.url.searchParams.get('fields')).toBe('id,updated_time,participants');
    // One call reads the conversation's messages whole; none needs a call of its own.
    expect(paths).toContain('/c-owner');
    expect(paths.filter((path) => /^\/m\d$/.test(path))).toEqual([]);
    expect(paths).not.toContain('/c-client'); // a client's conversation is never read
    for (const call of instagram.calls) {
      expect(call.url.toString()).not.toContain(KEY);
      if (call.url.hostname === 'graph.instagram.com') expect(call.auth).toBe(`Bearer ${KEY}`);
      else expect(call.auth).toBeNull();
    }
  });

  it('reads a conversation again only when it has a new message, and keeps what it has', async () => {
    const instagram = fakeInstagram();
    const dataDir = makeTempDir('studio-engine-dms-');
    await inbox(instagram, { dataDir }).check();
    instagram.calls.length = 0;

    // A new engine on the same folder: the items and the account are kept, nothing is read again.
    const again = inbox(instagram, { dataDir });
    expect(again.read().items).toHaveLength(2);
    expect(again.read().connection.account).toBe('studio_account');
    await again.check();
    expect(instagram.calls.map((call) => call.url.pathname)).toEqual(['/me/conversations']);

    // A new message: only that conversation is read.
    const list = instagram.graph.get('/c-owner') as { messages: { data: unknown[] } };
    list.messages.data.unshift({
      id: 'm4',
      created_time: '2026-10-30T10:20:00+0000',
      from: { username: 'owner_account' },
    });
    instagram.graph.set('/m4', {
      id: 'm4',
      from: { username: 'owner_account' },
      message: 'https://www.instagram.com/reel/DgNewReel1/',
    });
    const list2 = instagram.graph.get('/me/conversations') as { data: { updated_time: string }[] };
    if (list2.data[0] !== undefined) list2.data[0].updated_time = '2026-10-30T10:20:00+0000';
    instagram.calls.length = 0;
    const answer = await again.check();
    expect(instagram.calls.map((call) => call.url.pathname)).toEqual([
      '/me/conversations',
      '/c-owner',
    ]);
    expect(answer.items.map((item) => item.id)).toEqual(['m4:0', 'm3:0', 'm1:0']);
  });

  it("reads every conversation when Instagram does not say who is in it, keeping the studio's reels only to a sender", async () => {
    const instagram = fakeInstagram();
    const plain = instagram.fetch;
    instagram.fetch = async (input, init) => {
      if (new URL(input).searchParams.get('fields')?.includes('participants')) {
        return Response.json(
          {
            error: {
              message: '(#100) Tried accessing nonexisting field (participants)',
              code: 100,
            },
          },
          { status: 400 },
        );
      }
      return plain(input, init);
    };
    const conversations = instagram.graph.get('/me/conversations') as {
      data: { participants?: unknown }[];
    };
    for (const conversation of conversations.data) delete conversation.participants;
    // The studio's reel to the client: not kept, as nobody in that conversation is a sender.
    const client = instagram.graph.get('/c-client') as { messages: { data: unknown[] } };
    client.messages.data.unshift({
      id: 'm8',
      created_time: '2026-10-30T09:30:00+0000',
      from: { username: 'studio_account' },
    });
    instagram.graph.set('/m8', {
      id: 'm8',
      from: { username: 'studio_account' },
      message: 'https://www.instagram.com/reel/ForTheClient/',
    });
    const answer = await inbox(instagram).check();
    expect(answer.connection.state).toBe('connected');
    expect(answer.items.map((item) => item.id)).toEqual(['m3:0', 'm1:0']);
    expect(instagram.calls.map((call) => call.url.pathname)).toContain('/c-client');
  });

  it('reads each message on its own when Instagram will not give a conversation whole', async () => {
    const instagram = fakeInstagram();
    const plain = instagram.fetch;
    instagram.fetch = async (input, init) => {
      if (
        new URL(input).searchParams
          .get('fields')
          ?.startsWith('messages{id,created_time,from,message,')
      ) {
        return Response.json(
          { error: { message: '(#100) Tried accessing nonexisting field (message)', code: 100 } },
          { status: 400 },
        );
      }
      return plain(input, init);
    };
    const answer = await inbox(instagram).check();
    expect(answer.items.map((item) => item.id)).toEqual(['m3:0', 'm1:0']);
    const paths = instagram.calls.map((call) => call.url.pathname);
    expect(paths).toEqual(expect.arrayContaining(['/m1', '/m2', '/m3']));
  });

  it('reads again from the start a state kept under the old rules', async () => {
    const dataDir = makeTempDir('studio-engine-dms-');
    const dir = join(dataDir, 'instagram-dms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        account: { id: '17841400000000001', username: 'studio_account' },
        conversations: { 'c-owner': '2026-10-30T10:05:00+0000' },
        seen: ['m1', 'm2', 'm3'],
        items: [{ id: 'm2:0', kind: 'text', text: 'hi' }],
        checkedAt: '2026-10-30T10:06:00.000Z',
        error: null,
      }),
    );
    const instagram = fakeInstagram();
    const dms = inbox(instagram, { dataDir });
    expect(dms.read().items).toEqual([]);
    const answer = await dms.check();
    expect(answer.items.map((item) => item.id)).toEqual(['m3:0', 'm1:0']);
  });

  it('waits 15 minutes before the next check when Instagram asks to slow down', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-30T10:10:00Z') });
    const instagram = fakeInstagram();
    instagram.graph.set('/me/conversations', {
      status: 403,
      error: { message: '(#4) Application request limit reached', code: 4 },
    });
    const dms = inbox(instagram, { now: Date.now });
    const listed = () =>
      instagram.calls.filter((call) => call.url.pathname === '/me/conversations').length;
    dms.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listed()).toBe(1);
    expect(dms.read().connection.error).toBe(
      'Instagram asks to slow down: (#4) Application request limit reached. The next check is in 15 min.',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listed()).toBe(1);
    await vi.advanceTimersByTimeAsync(DM_SLOW_DOWN_MS - 60_000);
    expect(listed()).toBe(2);
    await dms.stop();
  });

  it('asks again with plainer fields when Instagram refuses one', async () => {
    const instagram = fakeInstagram();
    const plain = instagram.fetch;
    instagram.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.searchParams.get('fields')?.includes('link')) {
        return Response.json(
          { error: { message: '(#100) Tried accessing nonexisting field (link)', code: 100 } },
          { status: 400 },
        );
      }
      return plain(input, init);
    };
    const answer = await inbox(instagram).check();
    expect(answer.connection.state).toBe('connected');
    expect(answer.items.map((item) => item.kind)).toEqual(['reel', 'reel']);
  });

  it('says what went wrong, without the key, when Instagram refuses the key', async () => {
    const instagram = fakeInstagram();
    instagram.graph.set('/me', {
      status: 400,
      error: { message: `Error validating access token ${KEY}: expired`, code: 190 },
    });
    const answer = await inbox(instagram).check();
    expect(answer.connection.state).toBe('failing');
    expect(answer.connection.error).toBe(
      'Instagram refused the key: Error validating access token <key>: expired',
    );
    expect(answer.items).toEqual([]);
  });

  it('keeps an item whose file failed, and tries it again with a fresh link', async () => {
    const instagram = fakeInstagram();
    instagram.files.set('reel1', { type: 'text/html', body: '<html>login</html>' });
    const dms = inbox(instagram);
    const first = await dms.check();
    const reel = first.items.find((item) => item.id === 'm1:0');
    expect(reel).toMatchObject({
      file: null,
      missing: 'Instagram sent a page instead of the file.',
    });

    instagram.graph.set('/m1', {
      id: 'm1',
      from: { username: 'owner_account' },
      shares: { data: [{ type: 'ig_reel', url: `${CDN}reel1-fresh` }] },
    });
    instagram.files.set('reel1-fresh', { type: 'application/octet-stream', body: MP4 });
    const second = await dms.check();
    const fixed = second.items.find((item) => item.id === 'm1:0');
    expect(fixed?.missing).toBeNull();
    // The file server said only octet-stream: the first bytes say it is an MP4.
    expect(fixed?.file).toMatchObject({ contentType: 'video/mp4' });
    expect(fixed?.file?.name.endsWith('.mp4')).toBe(true);
  });

  it('takes the senders from INSTAGRAM_DM_FROM', async () => {
    const instagram = fakeInstagram();
    const answer = await inbox(instagram, {
      env: { INSTAGRAM_DM_FROM: '@Falcon.FPV, owner_account' },
    }).check();
    expect(answer.connection.from).toEqual(['falcon.fpv', 'owner_account']);
    expect(answer.items.find((item) => item.id === 'm9:0')).toMatchObject({ from: 'falcon.fpv' });
  });

  it('refreshes the key every couple of days and keeps it readable by this user only', async () => {
    const instagram = fakeInstagram();
    const dataDir = makeTempDir('studio-engine-dms-');
    let now = Date.parse('2026-10-30T10:10:00Z');
    const dms = inbox(instagram, { dataDir, now: () => now });
    await dms.check();
    const keyFile = join(dataDir, 'instagram-dms', 'key.json');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(instagram.calls.some((call) => call.url.pathname === '/refresh_access_token')).toBe(
      false,
    );

    now += KEY_REFRESH_EVERY_MS + 1;
    await dms.check();
    const refresh = instagram.calls.find((call) => call.url.pathname === '/refresh_access_token');
    expect(refresh?.url.searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(JSON.parse(readFileSync(keyFile, 'utf8')).token).toBe('IGAArefreshed');

    // The next check reads with the refreshed key.
    instagram.calls.length = 0;
    await dms.check();
    expect(instagram.calls[0]?.auth).toBe('Bearer IGAArefreshed');
  });

  it('reads with a Unified login key on graph.facebook.com, and never refreshes it', async () => {
    const instagram = fakeInstagram();
    instagram.graph.set('/me/assigned_instagram_accounts', {
      data: [{ id: '17841400000000001', username: 'studio_account' }],
    });
    instagram.graph.set(
      '/17841400000000001/conversations',
      instagram.graph.get('/me/conversations'),
    );
    instagram.graph.delete('/me');
    instagram.graph.delete('/me/conversations');
    let now = Date.parse('2026-10-30T10:10:00Z');
    const dms = inbox(instagram, { env: { INSTAGRAM_DM_TOKEN: META_KEY }, now: () => now });

    const answer = await dms.check();
    expect(answer.connection).toMatchObject({ state: 'connected', account: 'studio_account' });
    expect(answer.items.map((item) => item.id)).toEqual(['m3:0', 'm1:0']);
    for (const call of instagram.calls) {
      expect(call.url.toString()).not.toContain(META_KEY);
      if (call.url.hostname === 'lookaside.fbsbx.com') {
        expect(call.auth).toBeNull();
      } else {
        expect(call.url.hostname).toBe('graph.facebook.com');
        expect(call.auth).toBe(`Bearer ${META_KEY}`);
      }
    }

    now += KEY_REFRESH_EVERY_MS + 1;
    await dms.check();
    const paths = instagram.calls.map((call) => call.url.pathname);
    expect(paths).not.toContain('/refresh_access_token');
  });

  it('says so when a Unified login key has no Instagram account', async () => {
    const instagram = fakeInstagram();
    instagram.graph.set('/me/assigned_instagram_accounts', { data: [] });
    const answer = await inbox(instagram, { env: { INSTAGRAM_DM_TOKEN: META_KEY } }).check();
    expect(answer.connection.state).toBe('failing');
    expect(answer.connection.error).toMatch(/^The key has no Instagram account/);
  });

  it('sets an unreadable state file aside and starts again', () => {
    const dataDir = makeTempDir('studio-engine-dms-');
    const dir = join(dataDir, 'instagram-dms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{ not json');
    const dms = inbox(fakeInstagram(), { dataDir });
    expect(dms.read().items).toEqual([]);
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith('state.json.unreadable-'))).toBe(true);
  });
});
