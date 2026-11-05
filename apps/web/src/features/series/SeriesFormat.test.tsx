import { describe, expect, it } from 'vitest';
import { makeSeries, makeSeriesResponse, seriesByState } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { FAILED_FORMAT_TEXT, formatStatus, SeriesFormat } from './SeriesFormat';

const MARKDOWN = makeSeriesResponse().markdown;

const format = (series = makeSeries(), markdown: string | null = MARKDOWN) =>
  renderAt('/clients/x', <SeriesFormat series={series} markdown={markdown} />);

describe('formatStatus', () => {
  it('has nothing to say about a ready series', () => {
    expect(formatStatus(seriesByState.ready)).toBeNull();
  });

  it('names the job the format is being learned from', () => {
    expect(formatStatus(seriesByState.learning)).toEqual({
      kind: 'busy',
      text: 'Learning the format from מיתוס או אמת 5…',
      job: 'מיתוס או אמת 5',
    });
  });

  it('names the pass’s job when a new format is being learned from another episode', () => {
    const series = {
      ...seriesByState.learning,
      pass: {
        kind: 'series' as const,
        mode: 'replace' as const,
        fileCount: 0,
        jobId: 'myth7myth7ab',
        job: 'מיתוס או אמת 7',
      },
    };
    expect(formatStatus(series)).toMatchObject({
      text: 'Learning the format from מיתוס או אמת 7…',
      job: 'מיתוס או אמת 7',
    });
  });

  it('falls back on the format job when the pass names none', () => {
    expect(formatStatus({ ...seriesByState.learning, pass: null })).toMatchObject({
      text: 'Learning the format from מיתוס או אמת 5…',
    });
  });

  it('says review notes are going in when the pass only reads them', () => {
    const series = {
      ...seriesByState.learning,
      pass: { kind: 'series-read' as const, mode: null, fileCount: 1, jobId: null, job: null },
    };
    expect(formatStatus(series)).toEqual({
      kind: 'busy',
      text: 'Adding the review notes to the format…',
    });
  });

  it('shows the failure, with Retry', () => {
    expect(formatStatus(seriesByState.failed)).toEqual({
      kind: 'error',
      text: 'Series stopped: series.md.new was not written.',
      retry: true,
    });
    expect(formatStatus({ ...seriesByState.failed, error: null })).toEqual({
      kind: 'error',
      text: FAILED_FORMAT_TEXT,
      retry: true,
    });
  });
});

describe('the series page’s Format tab', () => {
  it('draws series.md like the Style page draws style.md, in a 680 px column', async () => {
    const markup = await format();
    expect(markup).toMatch(/<article[^>]*class="[^"]*max-w-\[680px\]/);
    expect(markup).toMatch(/<h1[^>]*>Series: מיתוס או אמת<\/h1>/);
    expect(markup).toMatch(/<h2[^>]*>Flow<\/h2>/);
    expect(markup).toContain('data-slot="style-document"');
    expect(markup).not.toContain('## Flow');
  });

  it('says where and when it was learned, above the document', async () => {
    const markup = await format(makeSeries({ updatedAt: '2026-10-21T10:04:00.000Z' }));
    const line = markup.match(/<span[^>]*>series\.md · learned [\s\S]*?<\/span>/)?.[0] ?? '';
    expect(line).toContain('learned ');
    expect(line).toContain('learned 21 Oct from');
    expect(line).toContain('<bdi>מיתוס או אמת 5</bdi>');
    expect(markup.indexOf('series.md · learned')).toBeLessThan(markup.indexOf('<h1'));
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });

  it('says it is learning, with the job’s name in its own direction, and nothing else while there is no series.md', async () => {
    const markup = await format(seriesByState.learning, null);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-status="busy"');
    expect(markup).toMatch(/Learning the format from <bdi>מיתוס או אמת 5<\/bdi>…/);
    expect(markup).not.toContain('series.md · learned');
    expect(markup).not.toContain('data-slot="style-document"');
    expect(markup).not.toContain('No series.md yet.');
  });

  it('keeps the old series.md under the learning line while a new format is learned', async () => {
    const markup = await format(seriesByState.learning, MARKDOWN);
    expect(markup).toContain('Learning the format from');
    expect(markup).toContain('data-slot="style-document"');
    expect(markup.indexOf('Learning the format')).toBeLessThan(markup.indexOf('<h1'));
  });

  it('shows the error and a Retry button when it failed', async () => {
    const markup = await format(seriesByState.failed, null);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-status="error"');
    expect(markup).toContain('Series stopped: series.md.new was not written.');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(markup).not.toContain('data-slot="style-document"');
  });

  it('has no Retry for a series that is not failed', async () => {
    expect(await format()).not.toContain('Retry');
    expect(await format(seriesByState.learning, null)).not.toContain('Retry');
  });

  it('says so when a ready series has no series.md', async () => {
    const markup = await format(makeSeries(), null);
    expect(markup).toContain('No series.md yet.');
    expect(markup).not.toContain('series.md · learned');
  });
});
