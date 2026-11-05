import {
  type ClientInstagram,
  INSTAGRAM_LINK_MESSAGES,
  INSTAGRAM_MESSAGES,
  type InstagramReel,
} from '@studio/shared';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import { createInstagramApi } from '@/data/instagram-api';
import { clientInstagramKey } from '@/data/instagram-cache';
import { linkReelMutationOptions, unlinkReelMutationOptions } from '@/data/instagram-mutations';
import { clientInstagramQueryOptions } from '@/data/instagram-query';
import { makeClientInstagram, makeInstagramReel } from '@/data/instagram-test-utils';
import { BASE_URL, createTestQueryClient } from '@/data/test-utils';
import type { ReelLinkDeps } from './reel-link-changes';
import { FALCON_TIME_ZONE } from './test-instagram';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { linkReelToJob, refusalWords, unlinkReelFromJob } = await import('./reel-link-changes');

// These run the real mutations of the data layer against an MSW server that keeps the links the way
// the engine's rules do: the message's Undo is a call to the opposite route, a refusal puts the row
// back, and the page is asked again afterwards.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createInstagramApi({ baseUrl: BASE_URL });
const CLIENT = '1c9823704bf5';
const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: Date.parse('2026-10-28T10:00:00.000Z') };

const ROOFTOP = { id: 'job-rooftop', name: 'Rooftop Run' };
const WINTER = { id: 'job-winter', name: 'Winter reel' };

const POSTED = {
  ours: '2026-10-20T17:05:00.000Z',
  theirs: '2026-10-22T05:15:00.000Z',
  third: '2026-10-17T09:30:00.000Z',
};

/** The engine's links: which video each reel has, and which videos are delivered. */
let links: Record<'ours' | 'theirs' | 'third', { id: string; name: string } | null>;

function reel(key: keyof typeof links): InstagramReel {
  return makeInstagramReel({
    shortcode: `reel-${key}`,
    postedAt: POSTED[key],
    job: links[key],
  });
}

/** The page the engine would answer: the reels as they are linked, and the delivered videos no reel has. */
function page(): ClientInstagram {
  const taken = new Set(Object.values(links).flatMap((job) => (job === null ? [] : [job.id])));
  return makeClientInstagram({
    reels: [reel('theirs'), reel('ours'), reel('third')],
    linkableJobs: [ROOFTOP, WINTER]
      .filter((job) => !taken.has(job.id))
      .map((job) => ({
        jobId: job.id,
        name: job.name,
        deliveredAt: '2026-10-19T10:00:00.000Z',
        stage: 'delivered' as const,
      })),
  });
}

const keyOf = (shortcode: string) => shortcode.replace('reel-', '') as keyof typeof links;

let queryClient: QueryClient;
let stop: () => void;
beforeEach(async () => {
  queryClient = createTestQueryClient();
  links = { ours: ROOFTOP, theirs: null, third: null };
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
  server.use(
    http.get(`${BASE_URL}/api/clients/:clientId/instagram`, () => HttpResponse.json(page())),
    http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async ({ request, params }) => {
      const key = keyOf(String(params.shortcode));
      const { jobId } = (await request.json()) as { jobId: string };
      const job = [ROOFTOP, WINTER].find((one) => one.id === jobId);
      if (job === undefined)
        return HttpResponse.json({ error: `Job ${jobId} not found` }, { status: 404 });
      if (links[key] !== null && links[key]?.id !== jobId) {
        return HttpResponse.json(
          { error: INSTAGRAM_LINK_MESSAGES['reel-linked'], reason: 'reel-linked' },
          { status: 409 },
        );
      }
      if (Object.entries(links).some(([other, linked]) => other !== key && linked?.id === jobId)) {
        return HttpResponse.json(
          { error: INSTAGRAM_LINK_MESSAGES['job-linked'], reason: 'job-linked' },
          { status: 409 },
        );
      }
      links[key] = job;
      return HttpResponse.json(reel(key));
    }),
    http.delete(`${BASE_URL}/api/instagram/reels/:shortcode/link`, ({ params }) => {
      const key = keyOf(String(params.shortcode));
      if (links[key] === null)
        return HttpResponse.json({ error: INSTAGRAM_MESSAGES.notLinked }, { status: 404 });
      links[key] = null;
      return HttpResponse.json(reel(key));
    }),
  );
  // The page on screen.
  const observer = new QueryObserver(queryClient, clientInstagramQueryOptions(api, CLIENT));
  stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(cached()).toBeDefined());
});
afterEach(() => stop());

const cached = () => queryClient.getQueryData<ClientInstagram>(clientInstagramKey(CLIENT, 'since'));
const jobOf = (key: keyof typeof links) =>
  cached()?.reels.find((one) => one.shortcode === `reel-${key}`)?.job ?? null;

/**
 * What the page said of one reel (its video) and of the Link to job list, each time the cache
 * changed, one line for each distinct state: the row's life from the click to the server's answer.
 */
function watchRow(key: keyof typeof links) {
  const state = () =>
    `${jobOf(key)?.name ?? '-'}|${cached()
      ?.linkableJobs.map((job) => job.jobId)
      .join(',')}`;
  const history = [state()];
  queryClient.getQueryCache().subscribe(() => {
    const now = state();
    if (history.at(-1) !== now) history.push(now);
  });
  return history;
}

function deps(): ReelLinkDeps {
  const params = { queryClient, api };
  return {
    link: (variables) =>
      new MutationObserver(queryClient, linkReelMutationOptions(params)).mutate(variables),
    unlink: (shortcode) =>
      new MutationObserver(queryClient, unlinkReelMutationOptions(params)).mutate(shortcode),
    textOptions: OPTIONS,
  };
}

const THEIRS_REEL = { shortcode: 'reel-theirs', postedAt: POSTED.theirs };
const OURS_REEL = { shortcode: 'reel-ours', postedAt: POSTED.ours };

/** What the toast of `fn`'s last call says, and how it was asked for. */
function lastToast(fn: ReturnType<typeof vi.fn>) {
  const [message, options] = fn.mock.calls.at(-1) as [React.ReactNode, Record<string, unknown>];
  const text = typeof message === 'string' ? message : renderToStaticMarkup(message);
  return { text, options };
}

const undoOf = (options: Record<string, unknown>) =>
  (options.action as { label: string; onClick: () => void } | undefined)?.onClick;

describe('Link to job', () => {
  it('links the reel, turns the row ours, and says so with an Undo', async () => {
    expect(await linkReelToJob(deps(), THEIRS_REEL, WINTER)).toBe(true);

    expect(links.theirs).toEqual(WINTER);
    expect(jobOf('theirs')).toEqual(WINTER);
    const { text, options } = lastToast(sonner.toast);
    expect(text).toBe('Linked “<bdi>Winter reel</bdi>” to the reel of Thu 22 Oct');
    expect(options.duration).toBe(7000);
    expect((options.action as { label: string }).label).toBe('Undo');
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('Undo unlinks the reel again, and the row is theirs', async () => {
    await linkReelToJob(deps(), THEIRS_REEL, WINTER);
    const undo = undoOf(lastToast(sonner.toast).options);
    undo?.();

    await vi.waitFor(() => expect(links.theirs).toBeNull());
    await vi.waitFor(() => expect(jobOf('theirs')).toBeNull());
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('a refusal puts the row back and says why in plain words, with no Undo', async () => {
    // Another reel was linked to that video meanwhile; this page does not know yet.
    links.third = WINTER;
    const row = watchRow('theirs');

    expect(await linkReelToJob(deps(), THEIRS_REEL, WINTER)).toBe(false);

    expect(links.theirs).toBeNull();
    // Ours at once (and Winter reel off the list), then back as it was.
    expect(row.slice(0, 3)).toEqual(['-|job-winter', 'Winter reel|', '-|job-winter']);
    expect(jobOf('theirs')).toBeNull();
    expect(sonner.toast).not.toHaveBeenCalled();
    const { text, options } = lastToast(sonner.toast.error);
    expect(text).toBe('Couldn&#x27;t link “<bdi>Winter reel</bdi>”');
    expect(options.description).toBe('That video is linked to a reel already. Unlink it first.');
    expect(options.id).toBe('reel-link:refused:reel-theirs');
    expect(undoOf(options)).toBeUndefined();
  });

  it('after a refusal the page is asked again, so the job that was linked meanwhile leaves the list', async () => {
    links.third = WINTER;
    expect(cached()?.linkableJobs.map((job) => job.jobId)).toContain('job-winter');
    await linkReelToJob(deps(), THEIRS_REEL, WINTER);
    await vi.waitFor(() =>
      expect(cached()?.linkableJobs.map((job) => job.jobId)).not.toContain('job-winter'),
    );
    expect(jobOf('third')).toEqual(WINTER);
  });

  it('a refusal of a reel that has a video already says that', async () => {
    links.theirs = ROOFTOP;
    links.ours = null;
    expect(await linkReelToJob(deps(), THEIRS_REEL, WINTER)).toBe(false);
    expect(lastToast(sonner.toast.error).options.description).toBe(
      'That reel is linked to a video already. Unlink it first.',
    );
  });

  it('says a video that is gone is not there any more, without its id', async () => {
    expect(await linkReelToJob(deps(), THEIRS_REEL, { id: 'gone', name: 'Gone video' })).toBe(
      false,
    );
    expect(lastToast(sonner.toast.error).options.description).toBe(
      'That video is not there any more.',
    );
  });

  it('says when the engine cannot be reached', async () => {
    server.use(
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, () => HttpResponse.error()),
    );
    expect(await linkReelToJob(deps(), THEIRS_REEL, WINTER)).toBe(false);
    expect(jobOf('theirs')).toBeNull();
    expect(lastToast(sonner.toast.error).options.description).toEqual(expect.any(String));
  });

  it('an Undo that is refused says so in a message of its own', async () => {
    await linkReelToJob(deps(), THEIRS_REEL, WINTER);
    const undo = undoOf(lastToast(sonner.toast).options);
    // Somebody unlinked it meanwhile.
    links.theirs = null;
    undo?.();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const { text, options } = lastToast(sonner.toast.error);
    expect(text).toBe("Couldn't undo");
    expect(options.description).toBe('That reel is not linked to a video.');
  });
});

describe('Unlink', () => {
  it('unlinks the reel, turns the row theirs, and says so with an Undo', async () => {
    expect(await unlinkReelFromJob(deps(), OURS_REEL, ROOFTOP)).toBe(true);

    expect(links.ours).toBeNull();
    expect(jobOf('ours')).toBeNull();
    const { text, options } = lastToast(sonner.toast);
    expect(text).toBe('Unlinked “<bdi>Rooftop Run</bdi>” from the reel of Tue 20 Oct');
    expect((options.action as { label: string }).label).toBe('Undo');
  });

  it('Undo links the reel to the same video again', async () => {
    await unlinkReelFromJob(deps(), OURS_REEL, ROOFTOP);
    expect(jobOf('ours')).toBeNull();
    undoOf(lastToast(sonner.toast).options)?.();

    await vi.waitFor(() => expect(links.ours).toEqual(ROOFTOP));
    await vi.waitFor(() => expect(jobOf('ours')).toEqual(ROOFTOP));
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('a refusal puts the row back and says why', async () => {
    // Somebody unlinked it from another window.
    links.ours = null;
    const row = watchRow('ours');

    expect(await unlinkReelFromJob(deps(), OURS_REEL, ROOFTOP)).toBe(false);

    // Theirs at once, then back as it was.
    expect(row.slice(0, 3)).toEqual([
      'Rooftop Run|job-winter',
      '-|job-winter',
      'Rooftop Run|job-winter',
    ]);
    const { text, options } = lastToast(sonner.toast.error);
    expect(text).toBe('Couldn&#x27;t unlink “<bdi>Rooftop Run</bdi>”');
    expect(options.description).toBe('That reel is not linked to a video.');
  });
});

describe('refusalWords', () => {
  it('is the server’s sentence for a refusal', () => {
    expect(refusalWords(new ApiError(409, INSTAGRAM_LINK_MESSAGES['not-this-client']))).toBe(
      'That video belongs to another client.',
    );
    expect(refusalWords(new ApiError(409, INSTAGRAM_LINK_MESSAGES['not-delivered']))).toBe(
      'Mark the video delivered before linking it to a reel.',
    );
  });

  it('leaves a video’s id out of "not found"', () => {
    expect(refusalWords(new ApiError(404, 'Job a1b2c3d4e5f6 not found'))).toBe(
      'That video is not there any more.',
    );
    expect(refusalWords(new ApiError(404, 'There is no such reel.'))).toBe(
      'There is no such reel.',
    );
  });

  it('is the message of anything else, or the thing itself', () => {
    expect(refusalWords(new Error('boom'))).toBe('boom');
    expect(refusalWords('plain')).toBe('plain');
  });
});
