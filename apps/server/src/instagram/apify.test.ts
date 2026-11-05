import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../test-temp.js';
import {
  ApifyError,
  type FetchLike,
  PROFILE_ACTOR,
  profileScraperInput,
  REEL_ACTOR,
  readApifyToken,
  readRunCost,
  reelScraperInput,
  runActor,
} from './apify.js';

// The client against a fake Apify: every call is recorded and answered from a script, so nothing
// here reaches the network. The items of the happy path are the answers of real runs
// (testdata/profile.json and reels.json, see README.md).

const TESTDATA = fileURLToPath(new URL('./testdata/', import.meta.url));
const fixture = (name: string): unknown[] =>
  JSON.parse(readFileSync(join(TESTDATA, `${name}.json`), 'utf8')) as unknown[];

const TOKEN = 'apify_api_TESTKEY0123456789';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

interface Reply {
  status?: number;
  /** A JSON answer. */
  json?: unknown;
  /** A raw answer (not JSON, say). */
  text?: string;
  /** The request never answers until it is aborted. */
  hang?: boolean;
  /** The request fails on the network. */
  breaks?: string;
}

/** A run object as Apify writes it. */
const run = (status: string, extra: Record<string, unknown> = {}): Reply => ({
  status: status === 'READY' ? 201 : 200,
  json: { data: { id: 'run1', status, defaultDatasetId: 'ds1', ...extra } },
});

class FakeApify {
  readonly calls: Call[] = [];
  private readonly script = new Map<string, Reply[]>();

  /** Answers `METHOD /path` with these replies in turn; the last one repeats. */
  on(route: string, ...replies: Reply[]): this {
    this.script.set(route, replies);
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const route = `${method} ${url.pathname}`;
    this.calls.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const replies = this.script.get(route);
    if (!replies) throw new Error(`no reply scripted for ${route}`);
    const reply = (replies.length > 1 ? replies.shift() : replies[0]) as Reply;
    if (reply.breaks) throw new TypeError(reply.breaks);
    if (reply.hang) {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
    });
  };

  routes(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }
}

const START = 'POST /v2/acts/apify~instagram-reel-scraper/runs';
const POLL = 'GET /v2/actor-runs/run1';
const ABORT = 'POST /v2/actor-runs/run1/abort';
const ITEMS = 'GET /v2/datasets/ds1/items';

/** The options every test shares: the fake, a key, no pause between polls. */
const opts = (fake: FakeApify) => ({ fetch: fake.fetch, token: TOKEN, pollGapMs: 0 });

async function failureOf(promise: Promise<unknown>): Promise<ApifyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApifyError);
    return error as ApifyError;
  }
  throw new Error('the run did not fail');
}

describe('runActor', () => {
  it('starts the run, polls it, reads the items and gives back the cost', async () => {
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(POLL, run('RUNNING'), run('SUCCEEDED', { usageTotalUsd: 0.0116 }))
      .on(ITEMS, { json: fixture('reels') });

    const input = reelScraperInput({
      usernames: ['natgeo'],
      resultsLimit: 5,
      newerThanDays: 28,
      shares: true,
    });
    const result = await runActor(REEL_ACTOR, input, opts(fake));

    expect(result).toEqual({ items: fixture('reels'), runId: 'run1', costUsd: 0.0116 });
    expect(fake.routes()).toEqual([START, POLL, POLL, ITEMS]);

    const [start, firstPoll, , items] = fake.calls;
    expect(start?.body).toEqual({
      username: ['natgeo'],
      resultsLimit: 5,
      onlyPostsNewerThan: '28 days',
      includeSharesCount: true,
      includeTranscript: false,
      includeDownloadedVideo: false,
    });
    // The run's own time limit is the cap, so Apify stops it even when this process is gone.
    expect(start?.query).toEqual({ timeout: '600' });
    expect(firstPoll?.query.waitForFinish).toBe('30');
    expect(items?.query).toEqual({ format: 'json', clean: '1' });
  });

  it('passes the cost cap to the run when asked', async () => {
    const fake = new FakeApify()
      .on(START, run('SUCCEEDED', { usageTotalUsd: 0 }))
      .on(ITEMS, { json: [] });
    await runActor(REEL_ACTOR, {}, { ...opts(fake), maxChargeUsd: 0.05, timeoutMs: 90_000 });
    expect(fake.calls[0]?.query).toEqual({ timeout: '90', maxTotalChargeUsd: '0.05' });
  });

  it('does not poll a run that the start already shows as finished', async () => {
    const profileStart = 'POST /v2/acts/apify~instagram-profile-scraper/runs';
    const fake = new FakeApify()
      .on(profileStart, run('SUCCEEDED', { usageTotalUsd: 0.0026 }))
      .on(ITEMS, { json: fixture('profile') });
    const result = await runActor(PROFILE_ACTOR, profileScraperInput(['natgeo']), opts(fake));
    expect(fake.routes()).toEqual([profileStart, ITEMS]);
    expect(fake.calls[0]?.body).toEqual({ usernames: ['natgeo'] });
    expect(result.items).toEqual(fixture('profile'));
    expect(result.costUsd).toBe(0.0026);
  });

  it('sends the key in the Authorization header only, never in a URL or a body', async () => {
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(POLL, run('SUCCEEDED', { usageTotalUsd: 0.01 }))
      .on(ITEMS, { json: [] });
    await runActor(REEL_ACTOR, { username: ['natgeo'] }, opts(fake));
    for (const call of fake.calls) {
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify([call.path, call.query, call.body])).not.toContain(TOKEN);
    }
  });

  it('says costUsd is null when Apify does not say what the run cost', async () => {
    const fake = new FakeApify().on(START, run('SUCCEEDED')).on(ITEMS, { json: [] });
    expect((await runActor(REEL_ACTOR, {}, opts(fake))).costUsd).toBeNull();
  });

  it('hands the answers for a missing or private account on as they are', async () => {
    for (const file of ['profile-not-found', 'profile-private', 'reels-not-found']) {
      const fake = new FakeApify()
        .on(START, run('SUCCEEDED', { usageTotalUsd: 0.0026 }))
        .on(ITEMS, { json: fixture(file) });
      expect((await runActor(REEL_ACTOR, {}, opts(fake))).items).toEqual(fixture(file));
    }
  });

  it('tries a poll again when the network breaks or Apify answers 5xx, and reads the items again too', async () => {
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(
        POLL,
        { breaks: 'fetch failed' },
        { status: 502, json: { error: { type: 'bad-gateway', message: 'bad' } } },
        run('SUCCEEDED', { usageTotalUsd: 0.02 }),
      )
      .on(ITEMS, { status: 503, text: 'busy' }, { json: [{ a: 1 }] });
    const result = await runActor(REEL_ACTOR, {}, opts(fake));
    expect(result.items).toEqual([{ a: 1 }]);
    expect(fake.routes()).toEqual([START, POLL, POLL, POLL, ITEMS, ITEMS]);
  });

  it('does not start the run twice when the start breaks', async () => {
    const fake = new FakeApify().on(START, { breaks: 'fetch failed' });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.message).toContain('fetch failed');
    expect(fake.routes()).toEqual([START]);
  });

  it('turns the actor id into the path form of the API', async () => {
    const fake = new FakeApify().on(
      'POST /v2/acts/someone~some-actor/runs',
      run('SUCCEEDED', { usageTotalUsd: 0 }),
    );
    fake.on(ITEMS, { json: [] });
    await runActor('someone/some-actor', {}, opts(fake));
    expect(fake.calls[0]?.path).toBe('/v2/acts/someone~some-actor/runs');
  });
});

describe('runActor errors', () => {
  it('no-token: there is no key, and nothing is sent', async () => {
    const fake = new FakeApify();
    const dir = makeTempDir('studio-engine-apify-');
    const error = await failureOf(
      runActor(REEL_ACTOR, {}, { fetch: fake.fetch, env: {}, envFile: join(dir, '.env') }),
    );
    expect(error.code).toBe('no-token');
    expect(error.message).toContain('APIFY_TOKEN');
    expect(fake.calls).toEqual([]);
  });

  it('no-token: a key that is blank counts as none', async () => {
    const fake = new FakeApify();
    const dir = makeTempDir('studio-engine-apify-');
    const error = await failureOf(
      runActor(
        REEL_ACTOR,
        {},
        { fetch: fake.fetch, env: { APIFY_TOKEN: '  ' }, envFile: join(dir, '.env') },
      ),
    );
    expect(error.code).toBe('no-token');
  });

  it('no-token: Apify refuses the key (401)', async () => {
    const fake = new FakeApify().on(START, {
      status: 401,
      json: { error: { type: 'invalid-token', message: 'Authentication token is not valid.' } },
    });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('no-token');
    expect(error.status).toBe(401);
    expect(error.message).toContain('invalid-token');
    expect(error.message).not.toContain(TOKEN);
  });

  it('no-credit: Apify refuses for usage (402 not-enough-usage-to-run-paid-actor)', async () => {
    const fake = new FakeApify().on(START, {
      status: 402,
      json: {
        error: {
          type: 'not-enough-usage-to-run-paid-actor',
          message:
            'By launching this job you will exceed the remaining usage of your Apify account.',
        },
      },
    });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('no-credit');
    expect(error.status).toBe(402);
    expect(error.message).toContain('not-enough-usage-to-run-paid-actor');
    expect(fake.routes()).toEqual([START]);
  });

  it('no-credit: by the error type too, and in the middle of the wait', async () => {
    const fake = new FakeApify().on(START, run('READY')).on(POLL, {
      status: 403,
      json: { error: { type: 'apify-plan-required-to-use-paid-actor', message: 'Upgrade' } },
    });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('no-credit');
    expect(error.runId).toBe('run1');
  });

  it('timeout: the cap aborts the run on Apify and the error carries the run and its cost', async () => {
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(POLL, run('RUNNING', { usageTotalUsd: 0.006 }))
      .on(ABORT, run('ABORTING'));
    const error = await failureOf(
      runActor(REEL_ACTOR, {}, { ...opts(fake), timeoutMs: 40, pollGapMs: 5 }),
    );
    expect(error.code).toBe('timeout');
    expect(error.runId).toBe('run1');
    expect(fake.routes().filter((route) => route === ABORT)).toHaveLength(1);
    // The abort is followed by one read of the run, for what it cost until then.
    expect(fake.routes().slice(-2)).toEqual([ABORT, POLL]);
    expect(fake.calls.at(-1)?.query.waitForFinish).toBeUndefined();
    expect(error.costUsd).toBe(0.006);
    // Nothing was read from the dataset.
    expect(fake.routes()).not.toContain(ITEMS);
  });

  it('timeout: a wait that never answers is cut at the cap and the run is aborted', async () => {
    // The first wait hangs; the read of the run after the abort is answered, with its cost.
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(POLL, { hang: true }, run('ABORTED', { usageTotalUsd: 0.004 }))
      .on(ABORT, run('ABORTING'));
    const started = Date.now();
    const error = await failureOf(
      runActor(REEL_ACTOR, {}, { ...opts(fake), timeoutMs: 60, pollGapMs: 5 }),
    );
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fake.routes()).toContain(ABORT);
    expect(error.costUsd).toBe(0.004);
  });

  it('timeout: Apify timing the run out itself is a timeout, and the run is not aborted', async () => {
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(POLL, run('TIMED-OUT', { usageTotalUsd: 0.03, statusMessage: 'Actor timed out' }));
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('timeout');
    expect(error.costUsd).toBe(0.03);
    expect(fake.routes()).not.toContain(ABORT);
  });

  it('failed: a run that FAILED says why and what it cost', async () => {
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(
        POLL,
        run('FAILED', { statusMessage: 'Instagram blocked the scraper', usageTotalUsd: 0.001 }),
      );
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.message).toBe('The Apify run failed: Instagram blocked the scraper');
    expect(error.runId).toBe('run1');
    expect(error.costUsd).toBe(0.001);
    expect(fake.routes()).toEqual([START, POLL]);
  });

  it('failed: a run that was ABORTED (by someone else)', async () => {
    const fake = new FakeApify().on(START, run('READY')).on(POLL, run('ABORTED'));
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.message).toBe('The Apify run aborted');
  });

  it('failed: the network is down', async () => {
    const fake = new FakeApify().on(START, { breaks: 'getaddrinfo ENOTFOUND api.apify.com' });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.message).toContain('ENOTFOUND');
  });

  it('failed: Apify answers an error that is not about the key or usage', async () => {
    const fake = new FakeApify().on(START, {
      status: 404,
      json: { error: { type: 'record-not-found', message: 'Actor was not found' } },
    });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Apify answered 404: record-not-found: Actor was not found');
  });

  it('failed: the answer about the run is not JSON', async () => {
    const fake = new FakeApify().on(START, { text: '<html>oops</html>' });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.message).toContain('could not be read');
  });

  it('failed: the items are not JSON, or not a list', async () => {
    for (const reply of [{ text: 'not json{' }, { json: { items: [] } }]) {
      const fake = new FakeApify()
        .on(START, run('SUCCEEDED', { usageTotalUsd: 0.01 }))
        .on(ITEMS, reply);
      const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
      expect(error.code).toBe('failed');
      expect(error.message).toContain('could not be read');
      expect(error.costUsd).toBe(0.01);
    }
  });

  it('failed: a finished run with no dataset', async () => {
    const fake = new FakeApify().on(START, {
      json: { data: { id: 'run1', status: 'SUCCEEDED', usageTotalUsd: 0.01 } },
    });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.code).toBe('failed');
    expect(error.message).toBe('The Apify run has no dataset');
  });

  it('never puts the key in an error, even when Apify echoes it back', async () => {
    const fake = new FakeApify().on(START, {
      status: 400,
      json: { error: { type: 'invalid-input', message: `Bad request for ${TOKEN}` } },
    });
    const error = await failureOf(runActor(REEL_ACTOR, {}, opts(fake)));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('[token]');
  });

  it('cancelled: the caller aborting stops the run on Apify too', async () => {
    const controller = new AbortController();
    const fake = new FakeApify()
      .on(START, run('READY'))
      .on(POLL, { hang: true }, run('ABORTED', { usageTotalUsd: 0.002 }))
      .on(ABORT, run('ABORTING'));
    const promise = failureOf(
      runActor(REEL_ACTOR, {}, { ...opts(fake), signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    const error = await promise;
    expect(error.code).toBe('failed');
    expect(error.cancelled).toBe(true);
    expect(error.runId).toBe('run1');
    expect(error.costUsd).toBe(0.002);
    expect(fake.routes()).toContain(ABORT);
  });

  it('cancelled: a signal that is aborted already sends nothing', async () => {
    const fake = new FakeApify();
    const error = await failureOf(
      runActor(REEL_ACTOR, {}, { ...opts(fake), signal: AbortSignal.abort() }),
    );
    expect(error.cancelled).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

describe('readRunCost', () => {
  it('reads the run again and gives its status and what it cost now', async () => {
    const fake = new FakeApify().on(POLL, run('SUCCEEDED', { usageTotalUsd: 0.0322 }));

    const reading = await readRunCost('run1', opts(fake));

    expect(reading).toEqual({ status: 'SUCCEEDED', finished: true, costUsd: 0.0322 });
    expect(fake.routes()).toEqual([POLL]);
    // No wait on Apify's side: a finished run answers at once.
    expect(fake.calls[0]?.query).toEqual({});
    expect(fake.calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('says a run that is still going is not finished, and costUsd is null when Apify says no number', async () => {
    const going = await readRunCost(
      'run1',
      opts(new FakeApify().on(POLL, run('RUNNING', { usageTotalUsd: 0.001 }))),
    );
    expect(going).toEqual({ status: 'RUNNING', finished: false, costUsd: 0.001 });

    const silent = await readRunCost('run1', opts(new FakeApify().on(POLL, run('ABORTED'))));
    expect(silent).toEqual({ status: 'ABORTED', finished: true, costUsd: null });
  });

  it('tries the read again when the network breaks or Apify answers 5xx', async () => {
    const fake = new FakeApify().on(
      POLL,
      { breaks: 'fetch failed' },
      { status: 503, json: { error: { type: 'unavailable', message: 'try later' } } },
      run('SUCCEEDED', { usageTotalUsd: 0.0244 }),
    );

    const reading = await readRunCost('run1', opts(fake));

    expect(reading.costUsd).toBe(0.0244);
    expect(fake.routes()).toEqual([POLL, POLL, POLL]);
  });

  it('failed with the HTTP status for a run Apify no longer has', async () => {
    const fake = new FakeApify().on(POLL, {
      status: 404,
      json: { error: { type: 'record-not-found', message: 'Run was not found' } },
    });

    const error = await failureOf(readRunCost('run1', opts(fake)));

    expect(error.code).toBe('failed');
    expect(error.status).toBe(404);
    expect(error.runId).toBe('run1');
    expect(fake.routes()).toEqual([POLL]);
  });

  it('failed without a status when the network is down, after three tries', async () => {
    const fake = new FakeApify().on(POLL, { breaks: 'fetch failed' });

    const error = await failureOf(readRunCost('run1', opts(fake)));

    expect(error.code).toBe('failed');
    expect(error.status).toBeNull();
    expect(error.runId).toBe('run1');
    expect(fake.routes()).toEqual([POLL, POLL, POLL]);
  });

  it('timeout: a read that never answers is cut at its cap', async () => {
    const fake = new FakeApify().on(POLL, { hang: true });

    const error = await failureOf(readRunCost('run1', { ...opts(fake), timeoutMs: 30 }));

    expect(error.code).toBe('timeout');
  });

  it('no-token: there is no key, and nothing is sent', async () => {
    const fake = new FakeApify();
    const dir = makeTempDir('studio-engine-apify-');

    const error = await failureOf(
      readRunCost('run1', { fetch: fake.fetch, env: {}, envFile: join(dir, '.env') }),
    );

    expect(error.code).toBe('no-token');
    expect(fake.calls).toEqual([]);
  });

  it('never puts the key in an error, even when Apify echoes it back', async () => {
    const fake = new FakeApify().on(POLL, {
      status: 400,
      json: { error: { type: 'invalid-input', message: `Bad request for ${TOKEN}` } },
    });

    const error = await failureOf(readRunCost('run1', opts(fake)));

    expect(error.message).not.toContain(TOKEN);
  });
});

describe('readApifyToken', () => {
  it('reads APIFY_TOKEN from the environment first, then from the .env file', () => {
    const dir = makeTempDir('studio-engine-apify-');
    const file = join(dir, '.env');
    writeFileSync(file, '# keys\nOTHER=1\nexport APIFY_TOKEN="from-file"\n');
    expect(readApifyToken({ APIFY_TOKEN: ' from-env ' }, file)).toBe('from-env');
    expect(readApifyToken({}, file)).toBe('from-file');
    writeFileSync(file, "APIFY_TOKEN='quoted'\n");
    expect(readApifyToken({}, file)).toBe('quoted');
  });

  it('is null with no variable, no file, or an empty value', () => {
    const dir = makeTempDir('studio-engine-apify-');
    const file = join(dir, '.env');
    expect(readApifyToken({}, file)).toBeNull();
    writeFileSync(file, 'APIFY_TOKEN=\nAPIFY_TOKEN_OTHER=x\n');
    expect(readApifyToken({}, file)).toBeNull();
  });
});

describe('the actors’ inputs', () => {
  it('asks the profile scraper for the usernames', () => {
    expect(profileScraperInput(['a', 'b'])).toEqual({ usernames: ['a', 'b'] });
  });

  it('asks the reel scraper for reels, newer than a date, with the add-ons off unless shares are asked', () => {
    expect(reelScraperInput({ usernames: ['a'], resultsLimit: 25, newerThanDays: 1 })).toEqual({
      username: ['a'],
      resultsLimit: 25,
      onlyPostsNewerThan: '1 day',
      includeSharesCount: false,
      includeTranscript: false,
      includeDownloadedVideo: false,
    });
    expect(reelScraperInput({ usernames: ['a'], resultsLimit: 3 })).not.toHaveProperty(
      'onlyPostsNewerThan',
    );
  });
});

describe('the fixtures of real runs', () => {
  const list = (name: string) => fixture(name) as Record<string, unknown>[];

  it('profile.json is one profile with the numbers a scan reads', () => {
    const [profile, ...rest] = list('profile');
    expect(rest).toEqual([]);
    expect(profile).toMatchObject({
      username: 'natgeo',
      id: '787132',
      private: false,
      fullName: 'National Geographic',
    });
    for (const field of ['followersCount', 'followsCount', 'postsCount']) {
      expect(typeof profile?.[field]).toBe('number');
    }
    expect(typeof profile?.biography).toBe('string');
    expect(String(profile?.profilePicUrlHD)).toMatch(/^https:\/\/[^?]+$/);
  });

  it('reels.json is five reels, one with another owner, and the shares are not in it', () => {
    const reels = list('reels');
    expect(reels).toHaveLength(5);
    for (const reel of reels) {
      expect(reel.shortCode).toMatch(/^[\w-]{11}$/);
      expect(typeof reel.timestamp).toBe('string');
      expect(typeof reel.videoPlayCount).toBe('number');
      expect(typeof reel.likesCount).toBe('number');
      expect(typeof reel.commentsCount).toBe('number');
      expect(typeof reel.videoDuration).toBe('number');
      expect(reel).toHaveProperty('musicInfo');
      expect(reel).toHaveProperty('hashtags');
      expect(reel).toHaveProperty('isPinned');
      expect(reel).toHaveProperty('paidPartnership');
      expect(Object.keys(reel).filter((key) => /share/i.test(key))).toEqual([]);
    }
    expect(reels.filter((reel) => reel.ownerUsername !== 'natgeo')).toHaveLength(1);
    expect(reels.filter((reel) => 'coauthorProducers' in reel)).toHaveLength(3);
  });

  it('the missing account answers with an error item, and the private one says private', () => {
    for (const name of ['profile-not-found', 'reels-not-found']) {
      expect(list(name)).toEqual([
        {
          url: 'https://www.instagram.com/studio_engine_no_such_user_8f3k2',
          username: 'studio_engine_no_such_user_8f3k2',
          error: 'not_found',
          errorDescription: 'Profile does not exist',
        },
      ]);
    }
    expect(list('profile-private')[0]).toMatchObject({ private: true });
  });

  it('hold no key and no signed link', () => {
    for (const name of [
      'profile',
      'reels',
      'profile-not-found',
      'profile-private',
      'reels-not-found',
    ]) {
      const text = readFileSync(join(TESTDATA, `${name}.json`), 'utf8');
      expect(text).not.toMatch(/apify_api_|Bearer |[?&](oh|_nc_\w+|efg)=/);
    }
  });
});
