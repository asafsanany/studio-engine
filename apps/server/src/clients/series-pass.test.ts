import { describe, expect, it } from 'vitest';
import {
  parseSeriesPass,
  parseStylePass,
  type SeriesPass,
  seriesPassSchema,
  summarizeSeriesPass,
} from './style-pass.js';

// The series pass kinds of the Series plan §3, as `series.last_pass` stores them. Only the schemas
// are K0's; the worker runs them (K2).

const START: SeriesPass = {
  kind: 'series',
  mode: 'start',
  seriesId: '622212180eef',
  series: 'מיתוס או אמת',
  jobId: '947ef344672b',
  job: 'מיתוס או אמת 5',
};

/** An approved episode with review notes marked Series (C26). */
const APPROVED: SeriesPass = {
  kind: 'series',
  mode: 'replace',
  seriesId: '622212180eef',
  series: 'מיתוס או אמת',
  jobId: '4b16f268bd46',
  job: 'מיתוס או אמת 6',
  notes: [{ name: 'Review notes – מיתוס או אמת 6 – round 1.md', size: 412 }],
};

/** What Send queued before C26, as an older `last_pass` may still hold it. */
const OLD_READ = {
  kind: 'series-read',
  seriesId: '622212180eef',
  series: 'מיתוס או אמת',
  files: [{ name: 'Review notes – מיתוס או אמת 6 – round 1.md', size: 412 }],
};

describe('series passes', () => {
  it('parse as they are, start and replace alike, with their notes', () => {
    expect(parseSeriesPass(START)).toEqual(START);
    expect(parseSeriesPass({ ...START, mode: 'replace' })).toEqual({ ...START, mode: 'replace' });
    expect(parseSeriesPass(APPROVED)).toEqual(APPROVED);
    expect(parseSeriesPass(JSON.parse(JSON.stringify(APPROVED)))).toEqual(APPROVED);
  });

  it.each([
    ['an unknown mode', { ...START, mode: 'merge' }],
    ['a series name with a slash', { ...START, series: 'a/b' }],
    ['a job outside the client folder', { ...START, job: '..' }],
    ['no series id', { ...START, seriesId: '' }],
    ['an empty notes list', { ...APPROVED, notes: [] }],
    [
      'a note outside the series folder',
      { ...APPROVED, notes: [{ name: '../style.md', size: 1 }] },
    ],
    ['a style pass', { kind: 'learn', mode: 'merge', jobId: 'j', job: 'J' }],
    ['a series-read pass from before C26', OLD_READ],
    ['nothing', null],
  ])('refuse %s', (_label, value) => {
    expect(parseSeriesPass(value)).toBeNull();
    expect(seriesPassSchema.safeParse(value).success).toBe(false);
  });

  it('are not style passes: the style worker’s parser leaves them alone', () => {
    expect(parseStylePass(START)).toBeNull();
    expect(parseStylePass(APPROVED)).toBeNull();
  });

  it('summarise for the web: a series pass names its job, with or without notes', () => {
    expect(summarizeSeriesPass(START)).toEqual({
      kind: 'series',
      mode: 'start',
      fileCount: 0,
      jobId: START.jobId,
      job: START.job,
    });
    expect(summarizeSeriesPass(APPROVED)).toEqual({
      kind: 'series',
      mode: 'replace',
      fileCount: 0,
      jobId: APPROVED.jobId,
      job: APPROVED.job,
    });
  });
});
