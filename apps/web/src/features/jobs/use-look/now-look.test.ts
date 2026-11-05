import { describe, expect, it } from 'vitest';
import { nowLookOf } from './now-look';

const JOBS = [
  { id: 'a', name: 'Coach intro reel' },
  { id: 'b', name: 'Studio tour' },
];

describe('nowLookOf', () => {
  it('is the still of the job the look comes from, with that job’s name', () => {
    expect(nowLookOf({ data: { sourceJobId: 'a' }, isError: false }, JOBS)).toEqual({
      kind: 'job',
      jobId: 'a',
      name: 'Coach intro reel',
    });
  });

  it('is "From your files" when the look was not learned from a job', () => {
    expect(nowLookOf({ data: { sourceJobId: null }, isError: false }, JOBS)).toEqual({
      kind: 'files',
    });
  });

  it('still asks for the still of a source job that has left the list, without a name', () => {
    expect(nowLookOf({ data: { sourceJobId: 'gone' }, isError: false }, JOBS)).toEqual({
      kind: 'job',
      jobId: 'gone',
      name: null,
    });
    expect(nowLookOf({ data: { sourceJobId: 'gone' }, isError: false }, undefined)).toEqual({
      kind: 'job',
      jobId: 'gone',
      name: null,
    });
  });

  it('waits while the style is on its way', () => {
    expect(nowLookOf({ isError: false }, JOBS)).toEqual({ kind: 'loading' });
  });

  it('shows no source when the style could not be read', () => {
    expect(nowLookOf({ isError: true }, JOBS)).toEqual({ kind: 'unknown' });
  });

  it('keeps the style it has when a later read fails', () => {
    expect(nowLookOf({ data: { sourceJobId: 'b' }, isError: true }, JOBS)).toMatchObject({
      kind: 'job',
      jobId: 'b',
    });
  });
});
