import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createTestQueryClient, makeFontRequest, makeJob } from '@/data/test-utils';
import { MissingFontBar } from './MissingFontBar';

// The bar on the Fonts page with the job list in the query cache (C51): which tense it speaks in
// follows the state of the job that asked, live (the cache is what the event stream keeps current).

const REQUEST = makeFontRequest({
  jobId: 'job-asking',
  name: 'Gotham Bold',
  jobName: 'Demo · Horizon FPV',
});

function bar(jobs: ReturnType<typeof makeJob>[] | undefined): string {
  const client = createTestQueryClient();
  if (jobs !== undefined) client.setQueryData(JOBS_KEY, jobs);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MissingFontBar requests={[REQUEST]} offline={false} onImport={() => {}} />
    </QueryClientProvider>,
  )
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the missing font bar of the Fonts page', () => {
  it('says the edit is using the closest font while the job that asked is editing', () => {
    expect(bar([makeJob({ id: 'job-asking', state: 'editing' })])).toBe(
      'Demo · Horizon FPV asked for Gotham Bold in a note. It isn’t in your library, so the edit is using the closest font it has.Not a fontImport fonts',
    );
  });

  it('says it used it once the job has finished, or has stopped', () => {
    for (const state of ['review', 'ready', 'failed', 'cancelled'] as const) {
      expect(bar([makeJob({ id: 'job-asking', state })])).toContain(
        'so the edit used the closest font it has.',
      );
    }
  });

  it('has “Not a font” beside Import fonts (C52)', () => {
    expect(bar(undefined)).toMatch(/Not a fontImport fonts$/);
  });

  it('keeps the sentence as it was when the jobs are not known: none loaded, or not that one', () => {
    expect(bar(undefined)).toContain('so the edit used the closest font it has.');
    expect(bar([makeJob({ id: 'another-job', state: 'editing' })])).toContain(
      'so the edit used the closest font it has.',
    );
  });
});
