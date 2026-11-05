import type { JobFeedResponse } from '@studio/shared';
import { QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApi, feedPictureUrl } from './api';
import { JOB_FEED_POLL_MS, jobFeedKey, jobFeedQueryOptions } from './job-feed';
import { BASE_URL, createTestQueryClient } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const FEED: JobFeedResponse = {
  jobId: 'job1',
  rev: 4,
  items: [{ id: 'L2-0', at: null, kind: 'text', text: 'Reading the brief.' }],
};

describe('jobFeedQueryOptions', () => {
  it('asks GET /api/jobs/:id/feed and keys the answer by job', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs/job1/feed`, () => HttpResponse.json(FEED)));
    const client = createTestQueryClient();
    const data = await client.fetchQuery(jobFeedQueryOptions(api, 'job1', { live: false }));
    expect(data).toEqual(FEED);
    expect(client.getQueryData(jobFeedKey('job1'))).toEqual(FEED);
  });

  it('polls only while the run goes on', () => {
    expect(jobFeedQueryOptions(api, 'job1', { live: true }).refetchInterval).toBe(JOB_FEED_POLL_MS);
    expect(jobFeedQueryOptions(api, 'job1', { live: false }).refetchInterval).toBe(false);
  });

  it('keeps the cached chat when a poll brings back the same rev', async () => {
    let answers = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/job1/feed`, () => {
        answers += 1;
        return HttpResponse.json({ ...FEED, items: [...FEED.items] });
      }),
    );
    const client = createTestQueryClient();
    const options = jobFeedQueryOptions(api, 'job1', { live: false });
    const observer = new QueryObserver(client, options);
    const first = await observer.refetch();
    const second = await observer.refetch();
    expect(answers).toBe(2);
    expect(second.data).toBe(first.data);
  });

  it('does not ask again after a 404 (Draft & chat off, or the job gone)', async () => {
    let answers = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/job1/feed`, () => {
        answers += 1;
        return HttpResponse.json({ error: 'Draft & chat is off.' }, { status: 404 });
      }),
    );
    const client = createTestQueryClient();
    await expect(
      client.fetchQuery({ ...jobFeedQueryOptions(api, 'job1', { live: false }), retryDelay: 0 }),
    ).rejects.toThrow('Draft & chat is off.');
    expect(answers).toBe(1);
  });
});

describe('feedPictureUrl', () => {
  it('points at the chat’s picture route', () => {
    expect(feedPictureUrl('job 1', 'L3-0-0.png')).toBe('/api/jobs/job%201/feed/img/L3-0-0.png');
  });
});
