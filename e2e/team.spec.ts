// TM6: the Team feature end to end, on the built server with the fake runner. The owner is the admin and
// sees everything; Yael and Amit are editors who see only the clients assigned to them. The engine
// is told the Mac's Tailscale name and the owner's login (config.json), so a request with that Host and
// a `Tailscale-User-Login` is a Tailscale Serve request, as in real use. Every person is played by
// forged Serve headers (e2e/support/serve.ts); the real web app is driven through a proxy that does
// what Serve does for one person.
//
// The unit tests (apps/server/src/team, remote/viewer.test.ts) cover each piece with the app in
// process. This is the layer on top, on a real socket with the real stream and the real UI:
//
//   leaks        Yael cannot see, stream, fetch or change anything of Amit's, nor of a client nobody
//                is assigned to; the admin-only routes are 403; paths with tricks give nothing
//   doors        Funnel (no login), an unknown login, a Host the engine does not own: 403
//   assignment   reassigning a client changes the editor's lists and makes their open stream
//                reconnect, in the API and in the open page
//   own client   a client an editor creates is theirs alone
//   the UI       Yael's Mac layout and phone layout have none of the admin's pages or actions
//
// A forged login from a non-loopback address cannot be played here (the engine only listens on
// loopback); viewer.test.ts covers it with a fake socket address.

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { openRowMenu, rowOf } from './support/jobs-ui.ts';
import {
  ADMIN,
  AMIT,
  ApiClient,
  type Caller,
  headersOf,
  openStream,
  type Person,
  rawRequest,
  rawSocket,
  SERVE_HOST,
  type ServeProxy,
  STRANGER,
  startServeProxy,
  YAEL,
} from './support/serve.ts';

const YAEL_CLIENT = 'Yael Studio';
const AMIT_CLIENT = 'Amit Studio';
const ORPHAN_CLIENT = 'Orphan Studio';
const WAIT = { timeout: 30_000 };

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';

interface JobRow {
  id: string;
  name: string;
  client: string;
  clientId: string;
  state: string;
  note?: string | null;
}
interface ClientListRow {
  clientId: string;
  client: string;
  jobs: number;
}

let engine: Engine;
let admin: ApiClient;
let yael: ApiClient;
let amit: ApiClient;
let local: ApiClient;
let ids: {
  yaelJob: string;
  amitJob: string;
  orphanJob: string;
  yaelClient: string;
  amitClient: string;
  orphanClient: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  what: string,
  read: () => Promise<T | null | undefined | false>,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function jobsOf(api: ApiClient): Promise<JobRow[]> {
  const response = await api.get<JobRow[]>('/api/jobs');
  expect(response.status).toBe(200);
  return response.json;
}

async function clientsOf(api: ApiClient): Promise<ClientListRow[]> {
  const response = await api.get<ClientListRow[]>('/api/clients');
  expect(response.status).toBe(200);
  return response.json;
}

/**
 * Drops a job folder into the inbox and waits until the engine has seen it. Folders made close
 * together are sometimes never seen by the inbox watcher (reported by TM6), so the spec makes
 * them one at a time.
 */
async function dropJob(client: string, job: string): Promise<void> {
  await engine.createJob({ client, job });
  await until(`${job} to be seen`, async () =>
    (await jobsOf(admin)).some((row) => row.name === job),
  );
}

async function addNote(api: ApiClient, jobId: string, text: string) {
  return api.send('POST', `/api/jobs/${jobId}/notes`, { atSec: 1, text });
}

async function assign(clientId: string, editors: Person[]): Promise<void> {
  const response = await admin.send(
    'PUT',
    `/api/clients/${encodeURIComponent(clientId)}/assignees`,
    {
      editors: editors.map((person) => person.login),
    },
  );
  expect(response.status).toBe(200);
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  // Review on (the default): every edit ends in Review, with a preview to ask for.
  engine = await startEngine({
    settleMs: 1_000,
    fakeSpeed: 30,
    review: true,
    config: { remoteHosts: [SERVE_HOST], remoteLogins: [ADMIN.login] },
  });
  admin = new ApiClient(engine.baseURL, ADMIN);
  yael = new ApiClient(engine.baseURL, YAEL);
  amit = new ApiClient(engine.baseURL, AMIT);
  local = new ApiClient(engine.baseURL, 'local');

  // The team: added by the admin through the API, as the Team page does.
  for (const person of [YAEL, AMIT]) {
    const added = await admin.send('POST', '/api/team', {
      name: person.name,
      email: person.login,
      role: 'editor',
    });
    expect(added.status).toBe(201);
  }

  // The inbox watcher starts a moment after the port opens, and a folder made before it is ready
  // is not seen (until the next start): wait for it.
  await until('the inbox watcher', async () =>
    (await engine.readLog()).includes('"msg":"watching the inbox"'),
  );
  // One at a time, each seen before the next folder is made: folders made together right after
  // the start were sometimes missed by the watcher (the third one never showed up).
  for (const [client, name] of [
    [YAEL_CLIENT, 'yael-promo'],
    [AMIT_CLIENT, 'amit-promo'],
    [ORPHAN_CLIENT, 'orphan-promo'],
  ] as const) {
    await dropJob(client, name);
  }
  const rows = await until(
    'the three jobs to reach Review',
    async () => {
      const all = await jobsOf(admin);
      return all.length === 3 && all.every((job) => job.state === 'review') ? all : null;
    },
    180_000,
  );
  const job = (name: string) => rows.find((row) => row.name === name) as JobRow;
  ids = {
    yaelJob: job('yael-promo').id,
    amitJob: job('amit-promo').id,
    orphanJob: job('orphan-promo').id,
    yaelClient: job('yael-promo').clientId,
    amitClient: job('amit-promo').clientId,
    orphanClient: job('orphan-promo').clientId,
  };
  await assign(ids.yaelClient, [YAEL]);
  await assign(ids.amitClient, [AMIT]);
  // Orphan Studio is assigned to no one.
});

test.afterAll(async () => {
  await engine?.stop();
});

/** Everything that identifies Amit's side or the unassigned client, to look for in answers. */
function foreignMarkers(): string[] {
  return [
    ids.amitJob,
    ids.orphanJob,
    ids.amitClient,
    ids.orphanClient,
    AMIT_CLIENT,
    ORPHAN_CLIENT,
    'amit-promo',
    'orphan-promo',
  ];
}

function expectNoneOf(text: string, markers: string[], where: string): void {
  for (const marker of markers) {
    expect(text.includes(marker), `${where} leaks ${marker}`).toBe(false);
  }
}

// --- 1. Yael cannot reach Amit's side ---------------------------------------------------------

test.describe('1. an editor sees only her own clients', () => {
  test('/api/me names her, and her lists hold her own client only', async () => {
    const me = await yael.get<{ email: string; role: string }>('/api/me');
    expect(me.json).toMatchObject({ email: YAEL.login, role: 'editor' });

    const jobs = await yael.get('/api/jobs');
    expect((jobs.json as JobRow[]).map((row) => row.name)).toEqual(['yael-promo']);
    expectNoneOf(jobs.text, foreignMarkers(), 'GET /api/jobs');

    const clients = await yael.get('/api/clients');
    expect((clients.json as ClientListRow[]).map((row) => row.client)).toEqual([YAEL_CLIENT]);
    expectNoneOf(clients.text, foreignMarkers(), 'GET /api/clients');

    // The admin sees all three; each editor, only theirs.
    expect((await jobsOf(admin)).map((row) => row.name).sort()).toEqual([
      'amit-promo',
      'yael-promo',
      'orphan-promo',
    ]);
    expect((await jobsOf(amit)).map((row) => row.name)).toContain('amit-promo');
  });

  test("reading anything of Amit's job or client is a 404 like a job that does not exist", async () => {
    const reads = (jobId: string, clientId: string) => [
      `/api/jobs/${jobId}/download`,
      `/api/jobs/${jobId}/steps`,
      `/api/jobs/${jobId}/sent-notes`,
      `/api/jobs/${jobId}/preview/index.html`,
      `/api/jobs/${jobId}/preview/edit.json`,
      `/api/jobs/${jobId}/preview-poster`,
      `/api/jobs/${jobId}/preview-video`,
      `/api/jobs/${jobId}/preview-video.mp4`,
      `/api/jobs/${jobId}/versions`,
      `/api/jobs/${jobId}/versions/1/preview/index.html`,
      `/api/jobs/${jobId}/review-export`,
      `/api/jobs/${jobId}/review-export.mp4`,
      `/api/jobs/${jobId}/notes`,
      `/api/jobs/${jobId}/notes/some-note/audio`,
      `/api/jobs/${jobId}/still`,
      `/api/jobs/${jobId}/music`,
      `/api/jobs/${jobId}/music/anything`,
      `/api/clients/${clientId}/style`,
      `/api/clients/${clientId}/series`,
    ];
    const missing = reads('no-such-job', 'no-such-client');
    for (const foreign of [
      reads(ids.amitJob, ids.amitClient),
      reads(ids.orphanJob, ids.orphanClient),
    ]) {
      for (const [index, path] of foreign.entries()) {
        const got = await yael.get(path);
        const none = await yael.get(missing[index] as string);
        expect(got.status, `GET ${path}`).toBe(404);
        // The answer must not tell a job that is there from one that is not.
        expect(got.text, `GET ${path}`).toBe(none.text);
        // And the admin does get something (a 404 for a thing the file system lacks is fine, but
        // not the same refusal): at least the job's own routes are really there.
      }
    }
    // Control: the same reads on her own job are not refused.
    for (const path of [
      `/api/jobs/${ids.yaelJob}/steps`,
      `/api/jobs/${ids.yaelJob}/notes`,
      `/api/jobs/${ids.yaelJob}/versions`,
      `/api/clients/${ids.yaelClient}/style`,
    ]) {
      expect((await yael.get(path)).status, `GET ${path}`).toBe(200);
    }
  });

  test("Amit's job and client cannot be changed by Yael", async () => {
    const before = await admin.get<JobRow[]>('/api/jobs');
    const writes: [string, string, unknown][] = [
      ['PUT', `/api/jobs/${ids.amitJob}/note`, { note: 'Yael was here' }],
      ['PUT', `/api/jobs/${ids.amitJob}/effort`, { effort: 'medium' }],
      ['POST', `/api/jobs/${ids.amitJob}/notes`, { atSec: 1, text: 'Yael was here' }],
      ['POST', `/api/jobs/${ids.amitJob}/review-export`, {}],
      ['POST', `/api/jobs/${ids.amitJob}/cancel`, {}],
      ['POST', `/api/jobs/${ids.amitJob}/retry`, {}],
      ['POST', `/api/jobs/${ids.amitJob}/use-look`, {}],
      ['POST', `/api/jobs/${ids.amitJob}/review-time`, { seconds: 5 }],
      ['POST', `/api/jobs/${ids.amitJob}/series`, {}],
      ['PUT', `/api/jobs/${ids.amitJob}/series`, { seriesId: null }],
      ['POST', `/api/clients/${ids.amitClient}/style/retry`, {}],
      ['POST', `/api/clients/${ids.amitClient}/style/undo`, {}],
      ['POST', `/api/jobs/archive`, { ids: [ids.yaelJob, ids.amitJob] }],
      ['POST', `/api/jobs/unarchive`, { ids: [ids.amitJob] }],
      ['POST', `/api/jobs/archive`, { ids: [ids.amitJob, ids.yaelJob] }],
    ];
    for (const [method, path, body] of writes) {
      const got = await yael.send(method, path, body);
      expect([400, 403, 404], `${method} ${path}`).toContain(got.status);
      expectNoneOf(got.text, foreignMarkers(), `${method} ${path}`);
    }
    // A batch with one foreign id changes nothing at all, not even her own job in it.
    const after = await admin.get<JobRow[]>('/api/jobs');
    expect(after.json).toEqual(before.json);
    expect((await admin.get<unknown[]>(`/api/jobs/${ids.amitJob}/notes`)).json).toEqual([]);
  });

  test('the money, analytics, graphics, LUTs and team routes are 403 for her; so is Mark delivered and Mark paid', async () => {
    const closed: [string, string, unknown?][] = [
      ['GET', '/api/money'],
      ['GET', '/api/money/price'],
      ['GET', '/api/analytics'],
      ['GET', '/api/graphics'],
      ['POST', '/api/graphics', { message: 'x' }],
      ['GET', '/api/graphics/some-id'],
      ['GET', '/api/luts'],
      ['POST', '/api/luts', {}],
      ['GET', '/api/team'],
      ['POST', '/api/team', { name: 'Eve', email: 'eve@example.com', role: 'admin' }],
      ['PUT', `/api/team/${encodeURIComponent(YAEL.login)}`, { role: 'admin' }],
      ['DELETE', `/api/team/${encodeURIComponent(AMIT.login)}`],
      ['PUT', `/api/clients/${ids.yaelClient}/assignees`, { editors: [YAEL.login, AMIT.login] }],
      ['PUT', `/api/clients/${ids.amitClient}/assignees`, { editors: [YAEL.login] }],
      // Her own job: delivered and paid are the admin's, and so are Delete and Show in Finder.
      ['POST', `/api/jobs/${ids.yaelJob}/deliver`, {}],
      ['POST', `/api/jobs/${ids.yaelJob}/undeliver`, {}],
      ['POST', '/api/payments', { jobIds: [ids.yaelJob] }],
      ['POST', '/api/payments/undo', {}],
      ['DELETE', `/api/jobs/${ids.yaelJob}`],
      ['POST', `/api/jobs/${ids.yaelJob}/reveal`, {}],
      ['POST', `/api/clients/${ids.yaelClient}/reveal`, {}],
    ];
    for (const [method, path, body] of closed) {
      const got = await yael.send(method, path, body);
      expect(got.status, `${method} ${path}`).toBe(403);
    }
    // Nothing of that happened: she is still an editor, her job is still there and not delivered.
    expect((await yael.get<{ role: string }>('/api/me')).json.role).toBe('editor');
    expect((await jobsOf(admin)).find((row) => row.id === ids.yaelJob)?.state).toBe('review');
    expect((await admin.get<{ users: unknown[] }>('/api/team')).json.users).toHaveLength(2);
  });

  test("an unassigned client's jobs are the admin's alone", async () => {
    for (const person of [yael, amit]) {
      const names = (await jobsOf(person)).map((row) => row.name);
      expect(names).not.toContain('orphan-promo');
      expect((await clientsOf(person)).map((row) => row.client)).not.toContain(ORPHAN_CLIENT);
      for (const path of [
        `/api/jobs/${ids.orphanJob}/steps`,
        `/api/jobs/${ids.orphanJob}/preview-poster`,
        `/api/clients/${ids.orphanClient}/style`,
      ]) {
        expect((await person.get(path)).status, path).toBe(404);
      }
    }
    expect((await jobsOf(admin)).map((row) => row.name)).toContain('orphan-promo');
    expect((await clientsOf(admin)).map((row) => row.client)).toContain(ORPHAN_CLIENT);
    expect((await admin.get(`/api/clients/${ids.orphanClient}/style`)).status).toBe(200);
  });
});

// --- 2. The doors -----------------------------------------------------------------------------

test.describe('2. who is let in at all', () => {
  const PATHS = ['/api/me', '/api/jobs', '/api/events', '/api/health', '/', '/jobs'];

  test('Funnel (the Mac’s name, no login) is 403 on every path, and so is an unknown login', async () => {
    for (const caller of ['funnel', STRANGER] as Caller[]) {
      const api = new ApiClient(engine.baseURL, caller);
      for (const path of PATHS) {
        const got = await api.get(path);
        expect(got.status, `${typeof caller === 'string' ? caller : caller.login} ${path}`).toBe(
          403,
        );
        expectNoneOf(got.text, [...foreignMarkers(), YAEL_CLIENT, 'yael-promo'], path);
      }
      // A write is refused as well.
      expect((await api.send('PUT', `/api/jobs/${ids.yaelJob}/note`, { note: 'x' })).status).toBe(
        403,
      );
    }
  });

  test('a Serve header without a login, an empty login, and a login of a Host the engine does not own are 403', async () => {
    const port = new URL(engine.baseURL).host;
    const cases: [string, Record<string, string>][] = [
      ['x-forwarded-for on the Mac’s own Host', { host: port, 'x-forwarded-for': '100.64.0.7' }],
      ['tailscale-user-name only', { host: port, 'tailscale-user-name': 'Yael' }],
      ['an empty login', { ...headersOf(YAEL), 'tailscale-user-login': '' }],
      ['a blank login', { ...headersOf(YAEL), 'tailscale-user-login': '   ' }],
      ['a login on a host that is not the Mac’s', { ...headersOf(YAEL), host: 'evil.example.com' }],
      ['a login on another .ts.net name', { ...headersOf(YAEL), host: 'other.tail1234.ts.net' }],
      [
        'a login on a lookalike of the Mac’s name',
        { ...headersOf(YAEL), host: `${SERVE_HOST}.evil.com` },
      ],
      [
        'two logins in two headers',
        { ...headersOf(YAEL), 'tailscale-user-login': `${YAEL.login}, ${ADMIN.login}` },
      ],
    ];
    for (const [what, headers] of cases) {
      const got = await rawRequest(engine.baseURL, { path: '/api/jobs', headers });
      expect(got.status, what).toBe(403);
      expectNoneOf(got.body, ['yael-promo', 'amit-promo'], what);
    }
    // Two separate header lines: whichever way they are combined, never the admin and never in.
    const doubled = await rawRequest(engine.baseURL, {
      path: '/api/me',
      headers: {
        ...headersOf(YAEL),
        'tailscale-user-login': [YAEL.login, ADMIN.login] as unknown as string,
      },
    });
    expect([403]).toContain(doubled.status);
  });

  test('who she is comes from the headers only: not the query, a cookie, or a body; and case does not matter', async () => {
    const forged = await yael.get<{ role: string; email: string }>(
      `/api/me?tailscale-user-login=${ADMIN.login}&login=${ADMIN.login}&role=admin&viewer=${ADMIN.login}`,
      { cookie: `tailscale-user-login=${ADMIN.login}; role=admin` },
    );
    expect(forged.json).toMatchObject({ email: YAEL.login, role: 'editor' });
    // A login in capitals is the same person, not a new one, and not the admin.
    const shouting = new ApiClient(engine.baseURL, {
      login: YAEL.login.toUpperCase(),
      name: 'YAEL',
    });
    expect((await shouting.get<{ email: string; role: string }>('/api/me')).json).toMatchObject({
      email: YAEL.login,
      role: 'editor',
    });
    // Her Host being loopback does not make her the Mac: the headers still say who she is.
    const claimed = await rawRequest(engine.baseURL, {
      path: '/api/me',
      headers: { ...headersOf(YAEL), host: new URL(engine.baseURL).host },
    });
    expect(JSON.parse(claimed.body)).toMatchObject({ email: YAEL.login, role: 'editor' });
    // A Mac request (no Serve header, loopback Host) is the admin.
    expect((await local.get<{ role: string }>('/api/me')).json.role).toBe('admin');
    expect((await local.get('/api/team')).status).toBe(200);
  });

  test('a write that carries another page’s Origin is refused, for the admin too', async () => {
    const got = await admin.send(
      'POST',
      `/api/jobs/${ids.yaelJob}/notes`,
      { atSec: 1, text: 'from a web page' },
      { origin: 'https://evil.example.com' },
    );
    expect(got.status).toBe(403);
    const same = await admin.send(
      'POST',
      `/api/jobs/${ids.yaelJob}/notes`,
      { atSec: 1, text: 'from the page itself' },
      {
        origin: `https://${SERVE_HOST}`,
      },
    );
    expect(same.status).toBe(201);
  });

  test('removing someone closes the door at once, and adding them opens it again', async () => {
    const carol = { login: 'carol@example.com', name: 'Carol' };
    const api = new ApiClient(engine.baseURL, carol);
    expect((await api.get('/api/me')).status).toBe(403);
    expect(
      (await admin.send('POST', '/api/team', { name: 'Carol', email: carol.login, role: 'editor' }))
        .status,
    ).toBe(201);
    const stream = await openStream(engine.baseURL, carol);
    expect(stream.status).toBe(200);
    expect((await api.get('/api/me')).status).toBe(200);
    expect(await api.get<unknown[]>('/api/jobs').then((r) => r.json)).toEqual([]);
    expect(
      (await admin.send('DELETE', `/api/team/${encodeURIComponent(carol.login)}`)).status,
    ).toBe(200);
    expect((await api.get('/api/me')).status).toBe(403);
    // The stream she had open is closed on her.
    await Promise.race([stream.closed, sleep(5_000)]);
    expect(stream.isClosed(), 'her open stream is closed when she is removed').toBe(true);
    stream.close();
  });
});

// --- 3. The live stream -----------------------------------------------------------------------

test.describe('3. the live stream', () => {
  test('Yael’s stream carries nothing about Amit’s or the unassigned client, however they change', async () => {
    const yaelStream = await openStream(engine.baseURL, YAEL);
    const amitStream = await openStream(engine.baseURL, AMIT);
    const adminStream = await openStream(engine.baseURL, ADMIN);
    try {
      expect([yaelStream.status, amitStream.status, adminStream.status]).toEqual([200, 200, 200]);
      await until(
        'hello',
        async () => yaelStream.events.length > 0 && amitStream.events.length > 0,
      );
      expect(yaelStream.events[0]).toEqual({ type: 'hello' });

      // Everything about Amit's side changes at once: a job note, a review note, a new video, a new
      // client, the unassigned client's video too. Yael's own job changes as the positive control.
      expect((await addNote(admin, ids.amitJob, 'secret amit review note')).status).toBe(201);
      expect((await addNote(admin, ids.orphanJob, 'secret orphan note')).status).toBe(201);
      expect((await admin.send('POST', '/api/clients', { name: 'Amit Extra Client' })).status).toBe(
        201,
      );
      await dropJob(AMIT_CLIENT, 'amit-second');
      await dropJob(ORPHAN_CLIENT, 'orphan-second');
      await dropJob(YAEL_CLIENT, 'yael-second');
      expect((await addNote(yael, ids.yaelJob, 'yael note')).status).toBe(201);
      expect((await addNote(yael, ids.amitJob, 'yael tries amit')).status).toBe(404);

      // Wait for Amit's second job to be edited (events keep coming while it runs), and for Yael's own.
      await until(
        'Yael’s own events',
        async () =>
          yaelStream.events.some((e) => e.type === 'note.upsert') &&
          yaelStream.events.some(
            (e) => e.type === 'job.upsert' && (e.job as JobRow).name === 'yael-second',
          ),
      );
      await until('the second jobs to reach Review', async () => {
        const all = await jobsOf(admin);
        return all.filter((job) => job.state === 'review').length === 6 ? all : null;
      });
      await sleep(1_000);

      const everything = yaelStream.frames.join('\n');
      expectNoneOf(
        everything,
        [
          ...foreignMarkers(),
          'secret',
          'amit',
          'Amit',
          'orphan',
          'Orphan',
          'Extra',
          'amit-second',
          'orphan-second',
        ],
        'Yael’s stream',
      );
      // What she may get: her own events, and the housekeeping frames.
      for (const event of yaelStream.events) {
        expect(
          [
            'hello',
            'job.upsert',
            'job.remove',
            'note.upsert',
            'note.remove',
            'client.upsert',
            'client.added',
            'client.removed',
            'series.changed',
            'series.removed',
            'job.music',
          ],
          `${event.type} on Yael's stream`,
        ).toContain(event.type);
      }
      expect(
        yaelStream.events.some(
          (e) => e.type === 'job.upsert' && (e.job as JobRow).name === 'yael-second',
        ),
      ).toBe(true);
      // Money, graphics and LUT events are never sent to an editor.
      expect(yaelStream.events.filter((e) => /^(money|graphic|lut)\./.test(e.type))).toEqual([]);

      // Amit's stream has their, and not Yael's; the admin's has all of it.
      const amitText = amitStream.frames.join('\n');
      expect(amitText).toContain(ids.amitJob);
      expect(amitText).toContain('secret amit review note');
      expectNoneOf(
        amitText,
        [
          ids.yaelJob,
          ids.orphanJob,
          ids.orphanClient,
          YAEL_CLIENT,
          ORPHAN_CLIENT,
          'secret orphan note',
          'Amit Extra',
        ],
        'Amit’s stream',
      );
      const adminText = adminStream.frames.join('\n');
      for (const marker of [
        ids.yaelJob,
        ids.amitJob,
        ids.orphanJob,
        'Amit Extra Client',
        'secret orphan note',
      ]) {
        expect(adminText, `the admin's stream has ${marker}`).toContain(marker);
      }
    } finally {
      yaelStream.close();
      amitStream.close();
      adminStream.close();
    }
  });

  test('a reconnect with Last-Event-ID (header or query) gets hello and the lists, never a replay of what happened', async () => {
    // Make something happen on Amit's side first, so a replay would have something to leak.
    await addNote(admin, ids.amitJob, 'before reconnect');
    for (const options of [
      { headers: { 'last-event-id': '0' } },
      { headers: { 'last-event-id': '1' } },
      { headers: { 'last-event-id': 'not-a-number' } },
      { path: `/api/events?lastEventId=0&clientId=${ids.amitClient}&jobId=${ids.amitJob}` },
    ]) {
      const stream = await openStream(engine.baseURL, YAEL, options);
      await sleep(700);
      expect(stream.events, JSON.stringify(options)).toEqual([{ type: 'hello' }]);
      expectNoneOf(
        stream.frames.join('\n'),
        [...foreignMarkers(), 'before reconnect'],
        JSON.stringify(options),
      );
      stream.close();
    }
  });
});

// --- 4. Reassigning a client --------------------------------------------------------------------

test.describe('4. reassigning a client', () => {
  test('moves it into and out of the editor’s lists and makes her open stream reconnect', async () => {
    try {
      const first = await openStream(engine.baseURL, YAEL);
      await until('hello', async () => first.events.length > 0);
      expect((await jobsOf(yael)).map((row) => row.name)).not.toContain('amit-promo');

      // Give her Amit's client as well (several editors may share one).
      await assign(ids.amitClient, [AMIT, YAEL]);
      await Promise.race([first.closed, sleep(5_000)]);
      expect(first.isClosed(), 'her stream ends when her access changes').toBe(true);

      const second = await openStream(engine.baseURL, YAEL);
      await until('hello', async () => second.events.length > 0);
      expect(second.events[0]).toEqual({ type: 'hello' });
      const names = (await jobsOf(yael)).map((row) => row.name).sort();
      expect(names).toContain('amit-promo');
      expect((await clientsOf(yael)).map((row) => row.client).sort()).toEqual([
        AMIT_CLIENT,
        YAEL_CLIENT,
      ]);
      expect((await yael.get(`/api/jobs/${ids.amitJob}/steps`)).status).toBe(200);
      // The new stream now carries Amit's client.
      await addNote(admin, ids.amitJob, 'shared note');
      await until('the shared client’s event on her stream', async () =>
        second.events.some(
          (e) => e.type === 'note.upsert' && (e.note as { jobId: string }).jobId === ids.amitJob,
        ),
      );
      // Amit's own stream is not cut: their access did not change... or if it was, they reconnect fine.
      expect((await jobsOf(amit)).map((row) => row.name)).toContain('amit-promo');

      // And take it away again.
      await assign(ids.amitClient, [AMIT]);
      await Promise.race([second.closed, sleep(5_000)]);
      expect(second.isClosed(), 'her stream ends when the client is taken away').toBe(true);
      expect((await jobsOf(yael)).map((row) => row.name).sort()).toEqual([
        'yael-promo',
        'yael-second',
      ]);
      expect((await yael.get(`/api/jobs/${ids.amitJob}/steps`)).status).toBe(404);
      const third = await openStream(engine.baseURL, YAEL);
      await sleep(800);
      await addNote(admin, ids.amitJob, 'after removal');
      await sleep(1_200);
      expectNoneOf(
        third.frames.join('\n'),
        [ids.amitJob, 'after removal'],
        'the stream after removal',
      );
      third.close();
      second.close();
      first.close();
    } finally {
      await assign(ids.amitClient, [AMIT]);
    }
  });

  test('an unassigned client given to Yael shows up for her, and only for her', async () => {
    try {
      await assign(ids.orphanClient, [YAEL]);
      expect((await clientsOf(yael)).map((row) => row.client)).toContain(ORPHAN_CLIENT);
      expect((await clientsOf(amit)).map((row) => row.client)).not.toContain(ORPHAN_CLIENT);
      expect((await yael.get(`/api/jobs/${ids.orphanJob}/steps`)).status).toBe(200);
      expect((await amit.get(`/api/jobs/${ids.orphanJob}/steps`)).status).toBe(404);
    } finally {
      await assign(ids.orphanClient, []);
    }
    expect((await clientsOf(yael)).map((row) => row.client)).not.toContain(ORPHAN_CLIENT);
  });

  test('making Yael an admin shows her everything at once, and making her an editor again takes it back', async () => {
    const stream = await openStream(engine.baseURL, YAEL);
    await until('hello', async () => stream.events.length > 0);
    try {
      expect((await yael.get('/api/money')).status).toBe(403);
      const promoted = await admin.send('PUT', `/api/team/${encodeURIComponent(YAEL.login)}`, {
        role: 'admin',
      });
      expect(promoted.status).toBe(200);
      // She is an admin now; the stream she had is closed, and she reconnects to everything.
      await Promise.race([stream.closed, sleep(5_000)]);
      expect(stream.isClosed(), 'her stream ends when her role changes').toBe(true);
      expect((await yael.get<{ role: string }>('/api/me')).json.role).toBe('admin');
      expect((await jobsOf(yael)).map((row) => row.name)).toEqual(
        expect.arrayContaining(['amit-promo', 'orphan-promo']),
      );
      expect((await yael.get('/api/money')).status).toBe(200);
      expect((await yael.get('/api/team')).status).toBe(200);
    } finally {
      stream.close();
      const back = await admin.send('PUT', `/api/team/${encodeURIComponent(YAEL.login)}`, {
        role: 'editor',
      });
      expect(back.status).toBe(200);
    }
    expect((await yael.get<{ role: string }>('/api/me')).json.role).toBe('editor');
    expect((await yael.get('/api/money')).status).toBe(403);
    expect((await jobsOf(yael)).map((row) => row.name)).not.toContain('amit-promo');
    // Her own client is still hers (an assignment survives a round trip through admin).
    expect((await clientsOf(yael)).map((row) => row.client)).toContain(YAEL_CLIENT);
  });

  test('the owner’s own login cannot be put on the team', async () => {
    const owner = await admin.send('POST', '/api/team', {
      name: 'The owner',
      email: ADMIN.login,
      role: 'editor',
    });
    expect(owner.status).toBe(400);
    // The owner stays the admin, whatever team.json says.
    expect((await admin.get<{ role: string }>('/api/me')).json.role).toBe('admin');
  });

  test('the assignment API checks who it assigns', async () => {
    const bad: [unknown, number][] = [
      [{ editors: ['nobody@example.com'] }, 400],
      [{ editors: [ADMIN.login] }, 400],
      [{ editors: 'yael@example.com' }, 400],
      [{}, 400],
    ];
    for (const [body, status] of bad) {
      expect(
        (await admin.send('PUT', `/api/clients/${ids.yaelClient}/assignees`, body)).status,
      ).toBe(status);
    }
    expect(
      (await admin.send('PUT', '/api/clients/no-such-client/assignees', { editors: [] })).status,
    ).toBe(404);
    // Nothing changed.
    expect((await clientsOf(yael)).map((row) => row.client)).toEqual([YAEL_CLIENT]);
  });
});

// --- 5. A client an editor makes ---------------------------------------------------------------

test.describe('5. a client an editor creates', () => {
  test('is hers, shows for the admin, and is invisible to the other editor', async () => {
    const made = await yael.send<{ clientId: string; name: string }>('POST', '/api/clients', {
      name: 'Yael Fresh',
    });
    expect(made.status).toBe(201);
    const fresh = made.json.clientId;
    expect((await clientsOf(yael)).map((row) => row.client)).toContain('Yael Fresh');
    expect((await clientsOf(admin)).map((row) => row.client)).toContain('Yael Fresh');
    expect((await clientsOf(amit)).map((row) => row.client)).not.toContain('Yael Fresh');
    expect((await amit.get(`/api/clients/${fresh}/style`)).status).toBe(404);
    expect((await yael.get(`/api/clients/${fresh}/style`)).status).toBe(200);
    const team = await admin.get<{ assignments: Record<string, { editors: string[] }> }>(
      '/api/team',
    );
    expect(team.json.assignments[fresh]?.editors).toEqual([YAEL.login]);

    // A job dropped into her new client is hers.
    await dropJob('Yael Fresh', 'fresh-job');
    await until('the fresh job to show for her', async () =>
      (await jobsOf(yael)).some((row) => row.name === 'fresh-job'),
    );
    expect((await jobsOf(amit)).map((row) => row.name)).not.toContain('fresh-job');

    // Amit asking for the same name gets the engine's plain refusal, not "already there".
    const clash = await amit.send<{ error: string }>('POST', '/api/clients', {
      name: 'Yael Fresh',
    });
    expect(clash.status).toBe(400);
    expect(clash.text).not.toMatch(/already/i);
    // Yael asking again is told it is hers already.
    expect((await yael.send('POST', '/api/clients', { name: 'Yael Fresh' })).status).toBe(409);
  });

  test('a client folder that appears in the inbox on its own is the admin’s until they assign it', async () => {
    await dropJob('Dropped Co', 'dropped-job');
    await until('the dropped job', async () =>
      (await jobsOf(admin)).some((row) => row.name === 'dropped-job'),
    );
    for (const person of [yael, amit]) {
      expect((await jobsOf(person)).map((row) => row.name)).not.toContain('dropped-job');
      expect((await clientsOf(person)).map((row) => row.client)).not.toContain('Dropped Co');
    }
  });
});

// --- 7. Probing ---------------------------------------------------------------------------------

test.describe('7. probing', () => {
  test('path tricks give an editor nothing of Amit’s', async () => {
    const a = ids.amitJob;
    const n = ids.yaelJob;
    const amitClient = ids.amitClient;
    const paths = [
      `/api/jobs/${a}/steps`,
      `/api/jobs/${a}/steps/`,
      `/api/jobs/${a}//steps`,
      `//api/jobs/${a}/steps`,
      `/api//jobs/${a}/steps`,
      `/api/jobs/${n}/../${a}/steps`,
      `/api/jobs/${n}/%2e%2e/${a}/steps`,
      `/api/jobs/${n}/..%2f${a}/steps`,
      `/api/jobs/${n}%2f..%2f${a}/steps`,
      `/api/jobs/${a}%2fsteps`,
      `/api/jobs/%61${a.slice(1)}/steps`,
      `/api/jobs/${a.toUpperCase()}/steps`,
      `/api/Jobs/${a}/steps`,
      `/API/jobs/${a}/steps`,
      `/api/jobs/${a};x=1/steps`,
      `/api/jobs/${a}/steps?id=${n}`,
      `/api/jobs/${a}/steps#${n}`,
      `/api/jobs/${n}/preview/..%2f..%2f${a}/steps`,
      `/api/jobs/${n}/preview/../../${a}/steps`,
      `/api/jobs/${n}/preview/%2e%2e/%2e%2e/steps`,
      `/api/jobs/${n}/preview/index.html/../../../${a}/preview/index.html`,
      `/api/jobs/${n}/versions/1/preview/../../../../${a}/steps`,
      `/api/jobs/${a}/preview/index.html`,
      `/api/jobs/${a}/preview/%2e%2e/index.html`,
      `/api/jobs/${n}/preview/%00`,
      `/api/jobs/${n}/preview/index.html%00.png`,
      `/api/clients/${amitClient}/style`,
      `/api/clients/${amitClient}/style/`,
      `/api/clients/${n}/../${amitClient}/style`,
      `/api/clients/${encodeURIComponent(AMIT_CLIENT)}/style`,
      `/api/clients/${amitClient.toUpperCase()}/style`,
      `/api/clients/${amitClient}%2f..%2f${amitClient}/style`,
      `/api/clients/${ids.yaelClient}/style/../../${amitClient}/style`,
      `/api/clients?clientId=${amitClient}`,
      `/api/clients/?clientId=${amitClient}`,
      `/api/jobs?clientId=${amitClient}&client=${encodeURIComponent(AMIT_CLIENT)}&id=${a}`,
      `/api/jobs/?id=${a}`,
      `/api/jobs/${a}`,
      `/api/jobs/${a}/`,
      `/api/series/${a}`,
      `/api/deliveries/unpaid-without-job?clientId=${amitClient}`,
      `/api/deliveries/unpaid-without-job/..%2f..%2fjobs`,
      `/api/events/${a}`,
      `/api/push/devices/${a}`,
    ];
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      for (const path of paths) {
        const got = await rawRequest(engine.baseURL, { method, path, headers: yael.headers() });
        const where = `${method} ${path}`;
        // Never a 5xx, never data of Amit's, whatever the status.
        expect(got.status, where).toBeLessThan(500);
        if (method === 'HEAD') {
          expect(got.body, where).toBe('');
          continue;
        }
        expectNoneOf(got.body, [...foreignMarkers(), 'secret'], where);
        // Anything with Amit's id in it is either refused or the plain 404.
        if (path.includes(a) || path.includes(amitClient)) {
          expect([200, 400, 403, 404, 405], where).toContain(got.status);
          if (got.status === 200) {
            // 200 is only fine where the id is in the query string (her filtered answer, markers
            // already checked) or for the SPA shell; never for a path that names Amit's thing.
            const named =
              path.split('?')[0]?.includes(a) || path.split('?')[0]?.includes(amitClient);
            const html =
              got.body.startsWith('<!doctype html>') || got.body.includes('<div id="root">');
            expect(
              html || !named,
              `${where} answered 200 with something else: ${got.body.slice(0, 120)}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  test('HEAD and OPTIONS do not skip the guard', async () => {
    for (const path of [
      '/api/money',
      '/api/team',
      '/api/analytics',
      '/api/luts',
      '/api/graphics',
    ]) {
      for (const method of ['HEAD', 'OPTIONS', 'GET']) {
        const got = await rawRequest(engine.baseURL, { method, path, headers: yael.headers() });
        expect(got.status, `${method} ${path}`).toBe(403);
      }
    }
    for (const method of ['HEAD', 'OPTIONS']) {
      const got = await rawRequest(engine.baseURL, {
        method,
        path: `/api/jobs/${ids.amitJob}/download`,
        headers: yael.headers(),
      });
      // HEAD follows GET (a foreign job is a 404); no route has an OPTIONS row, so that is 403.
      expect(got.status, method).toBe(method === 'HEAD' ? 404 : 403);
      for (const caller of ['funnel', STRANGER] as Caller[]) {
        const refused = await rawRequest(engine.baseURL, {
          method,
          path: '/api/jobs',
          headers: headersOf(caller),
        });
        expect(
          refused.status,
          `${method} as ${typeof caller === 'string' ? caller : caller.login}`,
        ).toBe(403);
      }
    }
  });

  test('a method the table has no row for is refused for an editor, not run', async () => {
    for (const [method, path] of [
      ['PATCH', '/api/jobs'],
      ['PUT', `/api/jobs/${ids.yaelJob}`],
      ['PATCH', `/api/jobs/${ids.yaelJob}`],
      ['POST', `/api/jobs/${ids.yaelJob}/download`],
      ['DELETE', `/api/clients/${ids.yaelClient}`],
      ['PUT', '/api/clients'],
      ['POST', '/api/me'],
      ['DELETE', '/api/events'],
      ['TRACE', '/api/jobs'],
    ] as const) {
      const got = await rawRequest(engine.baseURL, { method, path, headers: yael.headers() });
      expect([400, 403, 404, 405], `${method} ${path}`).toContain(got.status);
    }
    // Her job was not deleted by any of that.
    expect((await jobsOf(admin)).some((row) => row.id === ids.yaelJob)).toBe(true);
  });

  test('batch and body ids: one foreign id in the list refuses the whole request', async () => {
    const before = (await jobsOf(admin)).map((row) => `${row.id}:${row.state}`);
    for (const body of [
      { ids: [ids.yaelJob, ids.amitJob] },
      { ids: [ids.amitJob, ids.yaelJob] },
      { ids: [ids.yaelJob, ids.orphanJob] },
      { ids: [ids.yaelJob, 'no-such-job'] },
      { ids: [ids.yaelJob, [ids.amitJob]] },
      { ids: ids.amitJob },
      { ids: { 0: ids.amitJob } },
      [ids.amitJob],
    ]) {
      for (const path of ['/api/jobs/archive', '/api/jobs/unarchive']) {
        const got = await yael.send('POST', path, body);
        expect([400, 404], `${path} ${JSON.stringify(body)}`).toContain(got.status);
        expectNoneOf(got.text, foreignMarkers(), path);
      }
    }
    // Duplicate keys and a body smuggled in the query string.
    const smuggled = await rawRequest(engine.baseURL, {
      method: 'POST',
      path: `/api/jobs/archive?ids=${ids.amitJob}`,
      headers: { ...yael.headers(), 'content-type': 'application/json' },
      body: `{"ids":["${ids.amitJob}"],"ids":["${ids.yaelJob}"]}`,
    });
    // JSON.parse keeps the last key: her own job, which is hers to archive. The foreign id in the
    // query string is not read.
    expect([200, 400, 404]).toContain(smuggled.status);
    expect((await jobsOf(admin)).find((row) => row.id === ids.amitJob)).toBeDefined();
    await admin.send('POST', '/api/jobs/unarchive', { ids: [ids.yaelJob] });
    expect((await jobsOf(admin)).map((row) => `${row.id}:${row.state}`).sort()).toEqual(
      before.sort(),
    );
  });

  test('series and body fields cannot pull Amit’s job into her series or her job into their', async () => {
    for (const [method, path, body] of [
      ['PUT', `/api/jobs/${ids.yaelJob}/series`, { seriesId: 'no-such-series' }],
      ['PUT', `/api/jobs/${ids.yaelJob}/series`, { seriesId: ids.amitJob }],
      ['PUT', `/api/jobs/${ids.amitJob}/series`, { seriesId: null }],
      ['POST', `/api/series/no-such-series/format`, { jobId: ids.amitJob }],
      ['POST', `/api/series/${ids.amitJob}/retry`, {}],
      ['GET', `/api/clients/${ids.amitClient}/series`, undefined],
    ] as const) {
      const got = await yael.send(method, path, body);
      expect([400, 404], `${method} ${path}`).toContain(got.status);
    }
  });

  test('the web app’s files are public to anyone let in but nothing outside the build is served', async () => {
    // The shell is the same for everyone; the page itself asks the API. Nothing of the repo or of
    // the data folder leaks through the static handler, even for the admin.
    for (const path of [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/assets/../../../../package.json',
      '/assets/..%2f..%2f..%2f..%2fpackage.json',
      '/.env',
      '/index.html/../../../server/dist/index.js',
      `/${encodeURIComponent(AMIT_CLIENT)}/amit-promo/clip.mp4`,
      '/_Exports/Amit%20Studio/amit-promo.mp4',
      '/Amit%20Studio',
    ]) {
      for (const api of [admin, yael]) {
        const got = await rawRequest(engine.baseURL, { path, headers: api.headers() });
        const label = `${api.caller === ADMIN ? 'admin' : 'yael'} GET ${path}`;
        expect(got.body, label).not.toContain('"workspaces"');
        expect(got.body, label).not.toContain('ANTHROPIC');
        expect(got.body, label).not.toContain('createServer');
        expect(
          got.body.includes('"name": "studio-engine"') ||
            got.body.includes('"name":"studio-engine"'),
          label,
        ).toBe(false);
        expect(got.headers['content-type'] ?? '', label).not.toMatch(/video/);
      }
    }
  });
});

// --- 7b. More probing ---------------------------------------------------------------------------

test.describe('7b. more probing', () => {
  test('a client name that collides with another client’s folder gives her nothing of it', async () => {
    const before = await readdir(engine.inbox);
    const adminBefore = await clientsOf(admin);
    const attempts = [
      'amit studio',
      'AMIT STUDIO',
      'Amit Studio ',
      ' Amit Studio',
      'Amit  Studio',
      'Amit Studio​',
      'Orphan Studio',
      'orphan studio',
      // The same letters composed and decomposed (macOS keeps names decomposed).
      'Café Amit',
      'Café Amit',
      '../Amit Studio',
      '../../Amit Studio',
      'Amit Studio/yael-evil',
      'Yael Studio/../Amit Studio',
      '/Amit Studio',
      'Amit Studio\\..\\x',
      '..',
      '.',
      '.hidden',
      '_Exports',
      '_exports',
      '_Style',
      '_Graphics',
      '_Fonts',
      'CON',
      'x'.repeat(300),
      '',
      '   ',
      'a\u0000b',
    ];
    const seen: string[] = [];
    for (const name of attempts) {
      const got = await yael.send<{ error?: string; client?: string }>('POST', '/api/clients', {
        name,
      });
      seen.push(
        `${JSON.stringify(name.length > 40 ? `${name.slice(0, 12)}…(${name.length})` : name)} → ${got.status} ${got.json?.error ?? got.json?.client ?? ''}`,
      );
      expect(got.status, `POST /api/clients ${JSON.stringify(name)}`).toBeLessThan(500);
      expectNoneOf(
        got.text,
        [ids.amitClient, ids.amitJob, ids.orphanClient, ids.orphanJob],
        `POST ${JSON.stringify(name)}`,
      );
    }
    await test.info().attach('client-name-attempts.txt', {
      body: seen.join('\n'),
      contentType: 'text/plain',
    });

    // Her lists never show Amit's or the unassigned client's videos, whatever she managed to make.
    const jobs = (await jobsOf(yael)).map((row) => row.name);
    expect(jobs).not.toContain('amit-promo');
    expect(jobs).not.toContain('orphan-promo');
    const mine = await clientsOf(yael);
    for (const row of mine) {
      expect(
        row.clientId,
        `her client ${row.client} must not be Amit's or the unassigned one`,
      ).not.toBe(ids.amitClient);
      expect(row.clientId).not.toBe(ids.orphanClient);
    }
    // Amit's and the admin's view of Amit's client is exactly as it was.
    const adminAfter = await clientsOf(admin);
    for (const old of adminBefore) {
      expect(adminAfter.find((row) => row.clientId === old.clientId)).toMatchObject({
        client: old.client,
        jobs: old.jobs,
      });
    }
    expect((await jobsOf(amit)).map((row) => row.name)).toContain('amit-promo');
    // Nothing was made outside the inbox, and no folder with a name that climbs up or splits.
    const after = await readdir(engine.inbox);
    for (const entry of after.filter((e) => !before.includes(e))) {
      expect(entry, `a new folder in the inbox: ${entry}`).not.toMatch(/\/|^\.\.?$/);
    }
    expect(await readdir(join(engine.inbox, '..'))).toEqual(expect.arrayContaining(['inbox']));
    expect((await readdir(join(engine.inbox, '..'))).sort()).toEqual([
      'data',
      'fixtures',
      'home',
      'inbox',
      'server.log',
    ]);
    expect(await readdir(join(engine.inbox, AMIT_CLIENT))).toEqual(
      expect.arrayContaining(['amit-promo']),
    );
  });

  test('a style upload with a path in the file name cannot write into another client', async () => {
    const boundary = '----tm6boundary';
    const part = (filename: string, content: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`;
    const body = `${part(`../../${AMIT_CLIENT}/_Style/planted.md`, 'planted by Yael')}${part(`..%2f..%2f${AMIT_CLIENT}%2f_Style%2fplanted2.md`, 'planted by Yael')}${part('/etc/passwd-planted.md', 'planted by Yael')}--${boundary}--\r\n`;
    const got = await rawRequest(engine.baseURL, {
      method: 'POST',
      path: `/api/clients/${ids.yaelClient}/style/files`,
      headers: {
        ...yael.headers(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(got.status).toBeLessThan(500);
    // To Amit's client it is refused outright.
    const foreign = await rawRequest(engine.baseURL, {
      method: 'POST',
      path: `/api/clients/${ids.amitClient}/style/files`,
      headers: {
        ...yael.headers(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(foreign.status).toBe(404);
    await sleep(500);
    for (const dir of [
      join(engine.inbox, AMIT_CLIENT),
      join(engine.inbox, AMIT_CLIENT, '_Style'),
      join(engine.inbox, ORPHAN_CLIENT),
      engine.inbox,
    ]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      expect(
        names.filter((n) => /planted/.test(n)),
        `planted file in ${dir}`,
      ).toEqual([]);
    }
    expect(existsSync('/etc/passwd-planted.md')).toBe(false);
  });

  test('walking up from her own job’s preview or export routes reaches nothing of Amit’s', async () => {
    const canary = 'AMIT-CANARY-7f2c91';
    const previewDir = join(engine.inbox, AMIT_CLIENT, 'amit-promo', 'edit', 'preview');
    await writeFile(join(previewDir, 'amit-canary.json'), JSON.stringify({ canary }));
    await mkdir(join(engine.exportsDir, AMIT_CLIENT), { recursive: true });
    await writeFile(
      join(engine.exportsDir, AMIT_CLIENT, 'amit-canary.json'),
      JSON.stringify({ canary }),
    );
    // Control: Amit can read the file of their own preview; Yael cannot, by their id.
    expect((await amit.get(`/api/jobs/${ids.amitJob}/preview/amit-canary.json`)).text).toContain(
      canary,
    );
    expect((await yael.get(`/api/jobs/${ids.amitJob}/preview/amit-canary.json`)).status).toBe(404);

    const n = ids.yaelJob;
    const climbs = [
      `/api/jobs/${n}/preview/../../../../${AMIT_CLIENT}/amit-promo/edit/preview/amit-canary.json`,
      `/api/jobs/${n}/preview/..%2f..%2f..%2f..%2f${encodeURIComponent(AMIT_CLIENT)}%2Famit-promo%2Fedit%2Fpreview%2Famit-canary.json`,
      `/api/jobs/${n}/preview/%2e%2e/%2e%2e/%2e%2e/%2e%2e/${encodeURIComponent(AMIT_CLIENT)}/amit-promo/edit/preview/amit-canary.json`,
      `/api/jobs/${n}/preview/%252e%252e/%252e%252e/${encodeURIComponent(AMIT_CLIENT)}/amit-promo/edit/preview/amit-canary.json`,
      `/api/jobs/${n}/preview/....//....//${encodeURIComponent(AMIT_CLIENT)}/amit-promo/edit/preview/amit-canary.json`,
      `/api/jobs/${n}/preview/..%5C..%5C..%5C..%5C${encodeURIComponent(AMIT_CLIENT)}%5Camit-promo%5Cedit%5Cpreview%5Camit-canary.json`,
      `/api/jobs/${n}/versions/1/preview/../../../../../${AMIT_CLIENT}/amit-promo/edit/preview/amit-canary.json`,
      `/api/jobs/${n}/versions/1/preview/..%2f..%2f..%2f..%2f..%2f${encodeURIComponent(AMIT_CLIENT)}%2Famit-promo%2Fedit%2Fpreview%2Famit-canary.json`,
      `/api/jobs/${n}/versions/../${ids.amitJob}/versions`,
      `/api/jobs/${n}/preview/%2e%2e%2f%2e%2e%2f%2e%2e%2f_Exports/${encodeURIComponent(AMIT_CLIENT)}/amit-canary.json`,
      `/api/jobs/${n}/preview/../../../../_Exports/${encodeURIComponent(AMIT_CLIENT)}/amit-canary.json`,
      `/api/jobs/${n}/preview/index.html%00/../amit-canary.json`,
      `/api/jobs/${n}/preview//${encodeURIComponent(AMIT_CLIENT)}/amit-promo/edit/preview/amit-canary.json`,
      `/api/jobs/${n}/preview/${encodeURI(join(engine.inbox, AMIT_CLIENT, 'amit-promo', 'edit', 'preview', 'amit-canary.json'))}`,
      `/api/jobs/${n}/preview/%2F${encodeURIComponent(join(engine.inbox, AMIT_CLIENT, 'amit-promo', 'edit', 'preview', 'amit-canary.json').slice(1))}`,
      `/api/jobs/${n}/notes/..%2f..%2f..%2f${ids.amitJob}%2fnotes/audio`,
      `/api/jobs/${n}/notes/..%2f${n}/audio`,
    ];
    for (const path of climbs) {
      for (const who of [yael, amit]) {
        const got = await rawRequest(engine.baseURL, {
          path: path.replaceAll(' ', '%20'),
          headers: who.headers(),
        });
        expect(got.status, `${who.caller === YAEL ? 'Yael' : 'Amit'} GET ${path}`).toBeLessThan(
          500,
        );
        expect(got.body, `${path} leaks the canary`).not.toContain(canary);
      }
    }
  });

  test('a ready video downloads for its editor and the admin, and is a 404 for the other editor', async () => {
    const id = await readyJob();
    const own = await rawRequest(engine.baseURL, {
      path: `/api/jobs/${id}/download`,
      headers: yael.headers(),
    });
    expect(own.status).toBe(200);
    expect(String(own.headers['content-type'])).toMatch(/video/);
    expect(
      (
        await rawRequest(engine.baseURL, {
          path: `/api/jobs/${id}/download`,
          headers: admin.headers(),
        })
      ).status,
    ).toBe(200);
    const other = await rawRequest(engine.baseURL, {
      path: `/api/jobs/${id}/download`,
      headers: amit.headers(),
    });
    expect(other.status).toBe(404);
    expect(String(other.headers['content-type'])).not.toMatch(/video/);
    // Mark delivered stays the admin's, even for her own approved video.
    expect((await yael.send('POST', `/api/jobs/${id}/deliver`, {})).status).toBe(403);
    expect((await jobsOf(admin)).find((row) => row.id === id)?.state).toBe('ready');
  });

  test('odd request lines and Host headers never let a Serve request in as the Mac or as the owner', async () => {
    const port = new URL(engine.baseURL).host;
    const crlf = '\r\n';
    const request = (target: string, headers: string[]) =>
      `GET ${target} HTTP/1.1${crlf}${headers.join(crlf)}${crlf}Connection: close${crlf}${crlf}`;
    const serve = (login: Person | null) =>
      Object.entries(headersOf(login ?? 'funnel'))
        .filter(([name]) => name !== 'host')
        .map(([name, value]) => `${name}: ${value}`);
    const cases: [string, string, number[]][] = [
      // [what, bytes, the statuses that are fine]
      [
        'absolute-form target, Funnel',
        request(`http://${port}/api/jobs`, [`Host: ${SERVE_HOST}`, ...serve(null)]),
        [400, 403],
      ],
      [
        'absolute-form target, Yael (her own list only)',
        request(`http://${port}/api/jobs`, [`Host: ${SERVE_HOST}`, ...serve(YAEL)]),
        [200, 400, 403],
      ],
      [
        'two Host headers, Funnel',
        request('/api/jobs', [`Host: ${port}`, `Host: ${SERVE_HOST}`, ...serve(null)]),
        [400, 403],
      ],
      [
        'userinfo in Host, Funnel',
        request('/api/jobs', [`Host: ${SERVE_HOST}@${port}`, ...serve(null)]),
        [400, 403],
      ],
      [
        'userinfo in Host, a stranger',
        request('/api/jobs', [`Host: x@${port}`, ...serve(STRANGER)]),
        [400, 403],
      ],
      [
        'Host with a trailing dot, Funnel',
        request('/api/jobs', [`Host: ${SERVE_HOST}.`, ...serve(null)]),
        [400, 403],
      ],
      [
        'Host that rebinds (evil.example.com), no login at all',
        request('/api/jobs', ['Host: evil.example.com']),
        [400, 403],
      ],
      ['no Host at all (HTTP/1.1)', request('/api/jobs', []), [400, 403]],
      [
        'Mac Host but a Serve header, no login',
        request('/api/jobs', [`Host: ${port}`, 'X-Forwarded-Host: x']),
        [400, 403],
      ],
    ];
    for (const [what, bytes, fine] of cases) {
      const got = await rawSocket(engine.baseURL, bytes);
      expect(fine, `${what}: got ${got.status}`).toContain(got.status);
      expectNoneOf(
        got.body,
        what.includes('Yael') ? [] : ['yael-promo', 'amit-promo', 'orphan-promo'],
        what,
      );
    }
    // Control: the same bytes with the Mac's own Host and no Serve header are the Mac (the admin).
    const mac = await rawSocket(engine.baseURL, request('/api/me', [`Host: ${port}`]));
    expect(mac.status).toBe(200);
    expect(mac.body).toContain('"role":"admin"');
  });

  // C40: a removed client folder takes its assignment with it, so the name made again by someone
  // else is theirs alone.
  test('a client folder that is removed takes its assignment with it: the name made again by someone else is theirs alone', async () => {
    const name = 'Reused Name';
    const made = await yael.send<{ clientId: string }>('POST', '/api/clients', { name });
    expect(made.status).toBe(201);
    const clientId = made.json.clientId;
    await dropJob(name, 'reused-job');
    await until('the job in Yael’s list', async () =>
      (await jobsOf(yael)).some((row) => row.name === 'reused-job'),
    );
    // The owner deletes the whole client folder in Finder.
    await rm(join(engine.inbox, name), { recursive: true, force: true });
    await until(
      'the client to be gone for the admin',
      async () => !(await clientsOf(admin)).some((row) => row.clientId === clientId),
    );
    await until(
      'the job to be gone for Yael',
      async () => !(await jobsOf(yael)).some((row) => row.name === 'reused-job'),
    );
    // Amit makes a client with the same name, and a job in it.
    const again = await amit.send('POST', '/api/clients', { name });
    expect(again.status, again.text).toBe(201);
    await dropJob(name, 'amits-reused-job');
    await until('Amit’s job', async () =>
      (await jobsOf(amit)).some((row) => row.name === 'amits-reused-job'),
    );
    try {
      const yaelSees = (await jobsOf(yael)).map((row) => row.name);
      const yaelClients = (await clientsOf(yael)).map((row) => row.clientId);
      expect(yaelSees, 'Amit’s new client of the same name').not.toContain('amits-reused-job');
      expect(yaelClients).not.toContain(clientId);
      expect((await yael.get(`/api/clients/${clientId}/style`)).status).toBe(404);
    } finally {
      // Leave the engine as the other tests expect it: the name is Amit's alone.
      await assign(clientId, [AMIT]);
    }
  });

  // Money is the admin's alone (C41): an editor's Job objects (GET /api/jobs and the live stream)
  // carry no `delivery.price`, `currency` or `paidOn` for her own videos.
  test('an editor’s Job objects leave out the price and the pay date of her own delivered video', async () => {
    await dropJob(YAEL_CLIENT, 'yael-paid');
    const job = await until('yael-paid in Review', async () =>
      (await jobsOf(yael)).find((row) => row.name === 'yael-paid' && row.state === 'review'),
    );
    expect((await yael.send('POST', `/api/jobs/${job.id}/approve`, {})).status).toBeLessThan(300);
    await until('yael-paid to be Ready', async () =>
      (await jobsOf(yael)).some((row) => row.name === 'yael-paid' && row.state === 'ready'),
    );
    const stream = await openStream(engine.baseURL, YAEL);
    try {
      await until('hello', async () => stream.events.length > 0);
      expect((await admin.send('POST', `/api/jobs/${job.id}/deliver`, {})).status).toBe(200);
      expect(
        (await admin.send('POST', '/api/payments', { jobIds: [job.id], paidOn: '2026-10-25' }))
          .status,
      ).toBe(200);
      await sleep(1_000);
      const mine = (await jobsOf(yael)).find((row) => row.id === job.id) as unknown as {
        delivery: Record<string, unknown> | null;
      };
      expect(
        mine.delivery === null || !('price' in mine.delivery),
        'delivery.price in GET /api/jobs',
      ).toBe(true);
      expect(
        mine.delivery === null || !('paidOn' in mine.delivery),
        'delivery.paidOn in GET /api/jobs',
      ).toBe(true);
      expect(stream.frames.join('\n'), 'the stream').not.toMatch(/"price"|"paidOn"/);
    } finally {
      stream.close();
    }
  });

  test('odd Tailscale headers never make a 5xx, and never make anyone the admin', async () => {
    const odd: Record<string, string>[] = [
      { 'tailscale-user-name': '=?bogus-charset?q?x?=' },
      { 'tailscale-user-name': '=?utf-8?b?!!!not-base64!!!?=' },
      { 'tailscale-user-name': '=?utf-8?q?=ZZ=FF=?=' },
      { 'tailscale-user-name': `=?utf-8?q?${'A'.repeat(7_000)}?=` },
      { 'tailscale-user-name': '<script>alert(1)</script>' },
      { 'tailscale-user-login': `${YAEL.login}\u0000` },
      { 'tailscale-user-login': `${'a'.repeat(6_000)}@example.com` },
      { 'tailscale-user-login': ` ${ADMIN.login}.evil` },
      { 'tailscale-user-login': `${ADMIN.login},${YAEL.login}` },
      { 'tailscale-user-login': `${ADMIN.login};` },
      { 'tailscale-user-login': `"${ADMIN.login}"` },
      { 'tailscale-user-login': `${ADMIN.login.replace('@', '%40')}` },
      { 'tailscale-user-login': ADMIN.login.toUpperCase().replace('OWNER', 'OWNERı') },
    ];
    for (const extra of odd) {
      let got: { status: number; body: string };
      try {
        got = await rawRequest(engine.baseURL, {
          path: '/api/me',
          headers: { ...headersOf(YAEL), ...extra },
        });
      } catch {
        continue; // Node refused to send it, or the server hung up: not a 5xx.
      }
      const where = JSON.stringify(extra).slice(0, 80);
      expect(got.status, where).toBeLessThan(500);
      if (got.status === 200) {
        const me = JSON.parse(got.body) as { email: string; role: string };
        // Only the exact login of a person gets in; Yael's stays an editor.
        expect(['yael@example.com', 'owner@example.com'], where).toContain(me.email);
        if (me.email === 'yael@example.com') expect(me.role, where).toBe('editor');
      }
    }
  });
});

// --- 6. The UI ------------------------------------------------------------------------------------

interface Session {
  context: BrowserContext;
  page: Page;
  proxy: ServeProxy;
  errors: string[];
}

async function openAs(
  browser: Browser,
  person: Person,
  path: string,
  options: { phone?: boolean } = {},
): Promise<Session> {
  const proxy = await startServeProxy(new URL(engine.baseURL), person);
  const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  const context = await browser.newContext(
    options.phone
      ? {
          viewport: { width: 393, height: 852 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        }
      : { viewport: { width: 1440, height: 900 } },
  );
  await context.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [LAST_SEEN_KEY, health.version],
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${proxy.url}${path}`);
  return { context, page, proxy, errors };
}

async function closeSession(session: Session): Promise<void> {
  await session.context.close();
  await session.proxy.close();
}

let readyJobId: string | undefined;

/** An approved (ready) video of Yael's, so the menus that depend on it show everything they can. */
async function readyJob(): Promise<string> {
  if (readyJobId !== undefined) return readyJobId;
  await dropJob(YAEL_CLIENT, 'yael-ready');
  const job = await until('yael-ready in Review', async () =>
    (await jobsOf(yael)).find((row) => row.name === 'yael-ready' && row.state === 'review'),
  );
  expect((await yael.send('POST', `/api/jobs/${job.id}/approve`, {})).status).toBeLessThan(300);
  await until('yael-ready to be Ready', async () =>
    (await jobsOf(yael)).some((row) => row.name === 'yael-ready' && row.state === 'ready'),
  );
  readyJobId = job.id;
  return job.id;
}

const SIDEBAR_ADMIN_PAGES = ['Money', 'Analytics', 'Graphics', 'LUTs', 'Team'] as const;

test.describe('6. the UI as Yael (Mac layout)', () => {
  test('her sidebar has no admin page, her lists hold her client only, and the admin pages lead back to Jobs', async ({
    browser,
  }) => {
    const session = await openAs(browser, YAEL, '/jobs');
    try {
      const { page } = session;
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Jobs' })).toBeVisible(WAIT);
      await expect(nav.getByRole('link', { name: 'Clients' })).toBeVisible();
      for (const label of SIDEBAR_ADMIN_PAGES) {
        await expect(nav.getByText(label, { exact: true }), `${label} in her sidebar`).toHaveCount(
          0,
        );
      }
      await expect(page.getByText('yael-promo').first()).toBeVisible(WAIT);
      await expect(page.getByText('amit-promo')).toHaveCount(0);
      await expect(page.getByText('orphan-promo')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toMatch(/Amit Studio|Orphan Studio/);

      // The admin's addresses lead her back to Jobs.
      for (const path of ['/money', '/analytics', '/graphics', '/settings/team']) {
        await page.goto(`${session.proxy.url}${path}`);
        await expect(page, path).toHaveURL(/\/jobs$/, WAIT);
        await expect(page.getByText('yael-promo').first()).toBeVisible(WAIT);
      }
      expect(session.errors).toEqual([]);
    } finally {
      await closeSession(session);
    }
  });

  test('her job’s menu has no Mark delivered / Mark paid / Delete / Show in Finder; Clients has no Assigned to or Assign to…', async ({
    browser,
  }) => {
    const session = await openAs(browser, YAEL, '/jobs');
    try {
      const { page } = session;
      await readyJob();
      const row = rowOf(page, 'yael-ready');
      await expect(row).toBeVisible(WAIT);
      const menu = await openRowMenu(page, row);
      const items = (await menu.getByRole('menuitem').allInnerTexts()).join(' | ');
      expect(items.length).toBeGreaterThan(0);
      expect(items).not.toMatch(/deliver|paid|delete|finder/i);
      await page.keyboard.press('Escape');

      await page.goto(`${session.proxy.url}/clients`);
      await expect(page.locator('tr[data-client-id]').filter({ hasText: YAEL_CLIENT })).toBeVisible(
        WAIT,
      );
      await expect(page.locator('tr[data-client-id]')).toHaveCount((await clientsOf(yael)).length);
      for (const foreign of [ids.amitClient, ids.orphanClient]) {
        await expect(page.locator(`tr[data-client-id="${foreign}"]`)).toHaveCount(0);
      }
      await expect(page.getByRole('columnheader', { name: 'Assigned to' })).toHaveCount(0);
      await page
        .locator('tr[data-client-id]')
        .filter({ hasText: YAEL_CLIENT })
        .click({ button: 'right' });
      const clientMenu = (await page.getByRole('menu').getByRole('menuitem').allInnerTexts()).join(
        ' | ',
      );
      expect(clientMenu).toMatch(/Open/);
      expect(clientMenu).not.toMatch(/Assign|finder/i);
      await page.keyboard.press('Escape');
      expect(session.errors).toEqual([]);
    } finally {
      await closeSession(session);
    }
  });

  test('the name Tailscale sends is shown as plain text, never as markup', async ({ browser }) => {
    const hostile = { login: YAEL.login, name: '<img src=x onerror="window.__pwned=1">Yael' };
    const session = await openAs(browser, hostile, '/jobs');
    try {
      const { page } = session;
      await expect(page.getByText('yael-promo').first()).toBeVisible(WAIT);
      await expect(page.getByText('<img src=x', { exact: false }).first()).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
      ).toBeUndefined();
      expect(await page.locator('img[src="x"]').count()).toBe(0);
    } finally {
      await closeSession(session);
    }
  });

  test('the admin, in the same app, has the sidebar pages, the Assigned to column and Assign to…', async ({
    browser,
  }) => {
    const session = await openAs(browser, ADMIN, '/clients');
    try {
      const { page } = session;
      const nav = page.getByRole('navigation', { name: 'Main' });
      for (const label of ['Money', 'Analytics', 'Graphics', 'Team']) {
        await expect(
          nav.getByText(label, { exact: true }),
          `${label} in the admin's sidebar`,
        ).toBeVisible(WAIT);
      }
      await expect(page.locator('tr[data-client-id]')).toHaveCount(await countClients(admin), WAIT);
      await expect(page.getByRole('columnheader', { name: 'Assigned to' })).toBeVisible();
      // The row menu of the same approved video, for the admin: the money and Delete entries are there.
      await readyJob();
      await page.goto(`${session.proxy.url}/jobs`);
      const menu = await openRowMenu(page, rowOf(page, 'yael-ready'));
      const items = (await menu.getByRole('menuitem').allInnerTexts()).join(' | ');
      expect(items).toMatch(/Mark delivered/);
      expect(items).toMatch(/Delete/);
      await page.keyboard.press('Escape');
      await page.goto(`${session.proxy.url}/settings/team`);
      await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible(WAIT);
      await expect(page.getByText(YAEL.login).first()).toBeVisible();
      await expect(page.getByText(AMIT.login).first()).toBeVisible();
      expect(session.errors).toEqual([]);
    } finally {
      await closeSession(session);
    }
  });

  test('Assign to… in the admin’s page changes what Yael’s open page shows, without a reload', async ({
    browser,
  }) => {
    const adminSession = await openAs(browser, ADMIN, '/clients');
    const yaelSession = await openAs(browser, YAEL, '/clients');
    try {
      const yaelRows = yaelSession.page.locator('tr[data-client-id]');
      const baseline = (await clientsOf(yael)).length;
      await expect(yaelRows.filter({ hasText: YAEL_CLIENT })).toBeVisible(WAIT);
      await expect(yaelRows).toHaveCount(baseline);

      // Through the dialog, as the owner would.
      const row = adminSession.page
        .locator('tr[data-client-id]')
        .filter({ hasText: ORPHAN_CLIENT });
      await expect(row).toBeVisible(WAIT);
      await row.click({ button: 'right' });
      await adminSession.page.getByRole('menuitem', { name: /Assign to/ }).click();
      const dialog = adminSession.page.getByRole('dialog', { name: /Assign to/ });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('checkbox').first().waitFor(WAIT);
      await dialog.getByLabel(/Yael/).check();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden(WAIT);

      // Her page picks the client up by itself (the stream reconnects and the list is read again).
      await expect(yaelRows.filter({ hasText: ORPHAN_CLIENT })).toBeVisible(WAIT);
      await expect(yaelRows).toHaveCount(baseline + 1);
      expect(await clientsOf(yael).then((rows) => rows.map((r) => r.client))).toContain(
        ORPHAN_CLIENT,
      );
      await yaelSession.page.goto(`${yaelSession.proxy.url}/jobs`);
      await expect(yaelSession.page.getByText('orphan-promo').first()).toBeVisible(WAIT);
      await yaelSession.page.goto(`${yaelSession.proxy.url}/clients`);
      await expect(yaelRows).toHaveCount(baseline + 1, WAIT);

      // Taken away again, in the API: her open page drops it.
      await assign(ids.orphanClient, []);
      await expect(yaelRows.filter({ hasText: ORPHAN_CLIENT })).toHaveCount(0, WAIT);
      await expect(yaelRows).toHaveCount(baseline);
      expect(adminSession.errors).toEqual([]);
      expect(yaelSession.errors).toEqual([]);
    } finally {
      await assign(ids.orphanClient, []);
      await closeSession(adminSession);
      await closeSession(yaelSession);
    }
  });
});

async function countClients(api: ApiClient): Promise<number> {
  return (await clientsOf(api)).length;
}

test.describe('6. the UI as Yael (phone layout)', () => {
  test('the tab bar is Jobs and Clients, there is no Money, and no admin action in a job’s sheet', async ({
    browser,
  }) => {
    const session = await openAs(browser, YAEL, '/jobs', { phone: true });
    try {
      const { page } = session;
      const bar = page.locator('[data-slot="phone-tab-bar"]');
      await expect(bar).toBeVisible(WAIT);
      await expect(bar.getByRole('link')).toHaveText(['Jobs', 'Clients'].map((t) => new RegExp(t)));
      await expect(bar.getByText('Money')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toMatch(
        /Amit Studio|Orphan Studio|amit-promo|orphan-promo/,
      );

      // The admin's address leads back to Jobs.
      await page.goto(`${session.proxy.url}/money`);
      await expect(page).toHaveURL(/\/jobs$/, WAIT);

      // The job's sheet: no Mark delivered, Mark paid, Delete or Show in Finder (the admin's do).
      await readyJob();
      await page.getByRole('button', { name: 'Open yael-ready' }).tap();
      const sheet = page.locator('[data-slot="phone-job-sheet"]');
      await expect(sheet).toBeVisible(WAIT);
      await expect(sheet.locator('[data-slot="job-sheet-status"]')).toHaveText('Approved', WAIT);
      await expect(sheet.locator('[data-menu-row="deliver"]')).toHaveCount(0);
      expect(await sheet.innerText()).not.toMatch(/Mark delivered|Mark paid|Delete|Finder/i);

      await page.goto(`${session.proxy.url}/clients`);
      await expect(page.getByText(YAEL_CLIENT).first()).toBeVisible(WAIT);
      // (Yael made some lookalike names herself in the probing above, so count rather than grep.)
      const mine = await clientsOf(yael);
      await expect(page.getByText(`${mine.length} clients`)).toBeVisible(WAIT);
      expect(await page.locator('body').innerText()).not.toMatch(/Orphan Studio|Assign to/);
      expect(session.errors).toEqual([]);
    } finally {
      await closeSession(session);
    }
  });

  test('the admin’s phone has the Money tab', async ({ browser }) => {
    const session = await openAs(browser, ADMIN, '/jobs', { phone: true });
    try {
      const bar = session.page.locator('[data-slot="phone-tab-bar"]');
      await expect(bar.getByRole('link')).toHaveText(
        ['Jobs', 'Clients', 'Money'].map((t) => new RegExp(t)),
        WAIT,
      );
      // And the admin's sheet for the same video does have Mark delivered.
      await readyJob();
      await session.page.getByRole('button', { name: 'Open yael-ready' }).tap();
      await expect(
        session.page.locator('[data-slot="phone-job-sheet"] [data-menu-row="deliver"]'),
      ).toHaveCount(1, WAIT);
    } finally {
      await closeSession(session);
    }
  });

  test('Funnel and an unknown login get the small “Not allowed.” page, not the app', async ({
    browser,
  }) => {
    for (const person of [null, STRANGER]) {
      const proxy = await startServeProxy(new URL(engine.baseURL), person);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const response = await page.goto(`${proxy.url}/jobs`);
        expect(response?.status()).toBe(403);
        await expect(page.getByText('Not allowed.')).toBeVisible();
        expect(await page.locator('body').innerText()).not.toMatch(/yael-promo|Studio/);
      } finally {
        await context.close();
        await proxy.close();
      }
    }
  });
});
