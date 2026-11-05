import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEED_MESSAGES, jobFeedResponseSchema } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { makeTempDir } from '../test-temp.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const JOB = { id: 'abc123def456' };

function app(draftChat: boolean, picture: string | null = null) {
  const feed = {
    feed: vi.fn(async (jobId: string) => ({
      jobId,
      rev: 3,
      items: [{ id: 'L2-0', at: null, kind: 'text' as const, text: 'Reading the brief.' }],
    })),
    picturePath: vi.fn(() => picture),
  };
  const jobs = { get: (id: string) => (id === JOB.id ? (JOB as never) : null) };
  return { feed, app: createApp({ draftChat, feedRoutes: { jobs, feed } }) };
}

describe('the job chat routes', () => {
  it('answer the job’s chat', async () => {
    const { app: api } = app(true);
    const res = await api.request(`/api/jobs/${JOB.id}/feed`);
    expect(res.status).toBe(200);
    expect(jobFeedResponseSchema.parse(await res.json())).toMatchObject({ rev: 3 });
  });

  it('say an unknown job is not found', async () => {
    const { app: api } = app(true);
    expect((await api.request('/api/jobs/nope/feed')).status).toBe(404);
    expect((await api.request('/api/jobs/nope/feed/img/L1-0-0.png')).status).toBe(404);
  });

  it('serve a picture the chat made, and nothing else', async () => {
    const dir = makeTempDir('studio-engine-feed-route-');
    const path = join(dir, 'L3-0-0.png');
    writeFileSync(path, 'png!');
    const { app: api } = app(true, path);
    const res = await api.request(`/api/jobs/${JOB.id}/feed/img/L3-0-0.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(await res.text()).toBe('png!');

    const { app: none } = app(true, null);
    const missing = await none.request(`/api/jobs/${JOB.id}/feed/img/nope.png`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: FEED_MESSAGES.noPicture });
  });

  it('are off while the switch is, whatever was given', async () => {
    const { app: api, feed } = app(false);
    for (const path of [`/api/jobs/${JOB.id}/feed`, `/api/jobs/${JOB.id}/feed/img/L3-0-0.png`]) {
      const res = await api.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: FEED_MESSAGES.off });
    }
    expect(feed.feed).not.toHaveBeenCalled();
  });
});
