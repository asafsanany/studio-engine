import type { ClientStyleResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import type { StyleSessionState } from './style-session';
import { FAILED_TEXT, styleStatus } from './style-status';

type ServerStyle = Pick<ClientStyleResponse, 'state' | 'error' | 'pass'>;

const none: ServerStyle = { state: 'none', error: null, pass: null };
const ready: ServerStyle = { state: 'ready', error: null, pass: null };
const analysing = (fileCount: number): ServerStyle => ({
  state: 'analysing',
  error: null,
  pass: { kind: 'read', mode: 'add', fileCount, jobId: null, job: null },
});
const failed: ServerStyle = {
  state: 'failed',
  error: 'Style stopped: the first line is wrong.',
  pass: null,
};
const quiet: Pick<StyleSessionState, 'upload' | 'notice'> = { upload: null, notice: null };

describe('styleStatus', () => {
  it('has nothing to say for a style that is none or ready, and nothing is going on', () => {
    expect(styleStatus(none, quiet)).toBeNull();
    expect(styleStatus(ready, quiet)).toBeNull();
  });

  it('says how far an upload has got', () => {
    expect(
      styleStatus(ready, {
        ...quiet,
        upload: { names: ['a.png', 'b.txt', 'c.pdf'], percent: 42.4 },
      }),
    ).toEqual({ kind: 'uploading', text: 'Uploading 3 files… 42%', percent: 42 });
    expect(styleStatus(none, { ...quiet, upload: { names: ['a.png'], percent: 0 } })).toEqual({
      kind: 'uploading',
      text: 'Uploading 1 file… 0%',
      percent: 0,
    });
  });

  it('says the files are being analysed, and that style.md updates when it is done', () => {
    expect(styleStatus(analysing(3), quiet)).toEqual({
      kind: 'busy',
      text: 'Analysing 3 files. style.md updates when it’s done.',
    });
    expect(styleStatus(analysing(1), quiet)?.text).toBe(
      'Analysing 1 file. style.md updates when it’s done.',
    );
  });

  it('does not count the files when the run does not say how many', () => {
    const text = 'Analysing the files. style.md updates when it’s done.';
    expect(styleStatus(analysing(0), quiet)?.text).toBe(text);
    expect(styleStatus({ state: 'analysing', error: null, pass: null }, quiet)?.text).toBe(text);
    expect(styleStatus({ state: 'analysing', error: null }, quiet)?.text).toBe(text);
  });

  it('says which job the style is being learned from, for a Learn pass', () => {
    const learning: ServerStyle = {
      state: 'analysing',
      error: null,
      pass: { kind: 'learn', mode: 'create', fileCount: 0, jobId: 'j1', job: 'השקת תפריט חדש' },
    };
    expect(styleStatus(learning, quiet)).toEqual({
      kind: 'busy',
      text: 'Learning the style from השקת תפריט חדש.',
      job: 'השקת תפריט חדש',
    });
  });

  it('says so when a Learn pass has no job name', () => {
    const learning: ServerStyle = {
      state: 'analysing',
      error: null,
      pass: { kind: 'learn', mode: 'replace', fileCount: 0, jobId: null, job: null },
    };
    expect(styleStatus(learning, quiet)?.text).toBe('Learning the style from a finished job.');
  });

  it('gives the error of a failed run, with Retry', () => {
    expect(styleStatus(failed, quiet)).toEqual({
      kind: 'error',
      text: 'Style stopped: the first line is wrong.',
      retry: true,
    });
  });

  it('has words for a failed run that gave no reason', () => {
    expect(styleStatus({ ...failed, error: null }, quiet)).toEqual({
      kind: 'error',
      text: FAILED_TEXT,
      retry: true,
    });
  });

  it('says the files were added, when the notice is up and nothing else is going on', () => {
    const notice = { tone: 'done', text: 'Added 2 files to the style.' } as const;
    expect(styleStatus(ready, { ...quiet, notice })).toEqual({
      kind: 'done',
      text: 'Added 2 files to the style.',
    });
  });

  it('says "still working" calmly, over an analysing run: it is not a failure', () => {
    const notice = { tone: 'info', text: 'Still working on the last files.' } as const;
    expect(styleStatus(analysing(2), { ...quiet, notice })).toEqual({
      kind: 'info',
      text: 'Still working on the last files.',
    });
  });

  it('gives a refusal of the upload without Retry, over an analysing run', () => {
    const notice = { tone: 'error', text: 'The files are larger than 2 GB together.' } as const;
    expect(styleStatus(analysing(2), { ...quiet, notice })).toEqual({
      kind: 'error',
      text: 'The files are larger than 2 GB together.',
      retry: false,
    });
  });

  it('puts bytes on their way before everything else', () => {
    const notice = { tone: 'error', text: 'x' } as const;
    expect(styleStatus(failed, { upload: { names: ['a'], percent: 5 }, notice })?.kind).toBe(
      'uploading',
    );
  });

  it('puts a failed run and a run in progress before a "done" notice that is still up', () => {
    const notice = { tone: 'done', text: 'Added 2 files to the style.' } as const;
    expect(styleStatus(failed, { ...quiet, notice })?.kind).toBe('error');
    expect(styleStatus(analysing(1), { ...quiet, notice })?.kind).toBe('busy');
  });
});
