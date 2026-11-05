import { afterEach, describe, expect, it, vi } from 'vitest';
import { askReviewExport } from './use-review-export';

// What the Export MP4 button asks the engine, per format (Formats, C65). There is no DOM, so the
// ask is tested on its own, with a fetch that records what it was asked.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(answer: Response | Error) {
  const calls: { url: string; method: string | undefined }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('askReviewExport', () => {
  it('asks about the main format with no format in the address, as it always did', async () => {
    const calls = stubFetch(json({ state: 'ready' }));
    expect(await askReviewExport('a1b2c3d4e5f6', null, false)).toBe('ready');
    expect(await askReviewExport('a1b2c3d4e5f6', undefined, false)).toBe('ready');
    expect(calls).toEqual([
      { url: '/api/jobs/a1b2c3d4e5f6/review-export', method: 'GET' },
      { url: '/api/jobs/a1b2c3d4e5f6/review-export', method: 'GET' },
    ]);
  });

  it('asks about an extra format by its id, and starts its render with a POST', async () => {
    const calls = stubFetch(json({ state: 'making' }));
    expect(await askReviewExport('a1b2c3d4e5f6', '1x1', false)).toBe('making');
    expect(await askReviewExport('a1b2c3d4e5f6', '1x1', true)).toBe('making');
    expect(calls).toEqual([
      { url: '/api/jobs/a1b2c3d4e5f6/review-export?format=1x1', method: 'GET' },
      { url: '/api/jobs/a1b2c3d4e5f6/review-export?format=1x1', method: 'POST' },
    ]);
  });

  it('reads the states the engine answers', async () => {
    stubFetch(json({ state: 'failed', message: 'boom' }));
    expect(await askReviewExport('a1b2c3d4e5f6', null, false)).toBe('failed');
    stubFetch(json({ state: 'idle' }));
    expect(await askReviewExport('a1b2c3d4e5f6', null, false)).toBe('idle');
  });

  it('is idle for a 404 (nothing to export, or a size the job no longer has)', async () => {
    stubFetch(json({ error: 'This job has no such format.' }, 404));
    expect(await askReviewExport('a1b2c3d4e5f6', '1x1', false)).toBe('idle');
  });

  it('is failed when the engine errs or cannot be reached, so the button offers a new try', async () => {
    stubFetch(json({ error: 'boom' }, 500));
    expect(await askReviewExport('a1b2c3d4e5f6', null, true)).toBe('failed');
    stubFetch(new Error('network'));
    expect(await askReviewExport('a1b2c3d4e5f6', null, true)).toBe('failed');
  });
});
