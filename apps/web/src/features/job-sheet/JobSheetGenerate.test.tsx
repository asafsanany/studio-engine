import { generateErrorMessage } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeGenerateState, makeJob } from '@/data/test-utils';
import { JobSheetFiles } from './JobSheetFiles';
import { GeneratedPanel } from './JobSheetGenerated';
import { NowError } from './JobSheetNow';
import { sheetGenerated } from './sheet-generated';
import { sheetError, sheetFiles } from './sheet-now';

// The markup of the parts a generated job adds to the sheet (Generated videos, GN9).

const panel = (job = makeJob({ generate: makeGenerateState() }), variant?: 'phone') => {
  const view = sheetGenerated(job);
  if (view === null) throw new Error('not a generated job');
  return renderToStaticMarkup(<GeneratedPanel view={view} {...(variant ? { variant } : {})} />);
};

describe('GeneratedPanel', () => {
  it('has the heading, who made what and a row for each part', () => {
    const html = panel();
    expect(html).toContain('aria-label="Generated"');
    expect(html).toContain('Higgsfield · ElevenLabs');
    for (const key of ['Voice', 'Looks', 'Keyframes', 'Clips', 'Spend']) {
      expect(html).toContain(`data-generated="${key}"`);
    }
    expect(html).toContain('$1.65 of $3');
    expect(html).toContain('4 of 6');
  });

  it('draws a bar for what is under way, in the colour of its tone', () => {
    const html = panel();
    expect(html).toContain('data-bar="normal"');
    expect(html).toContain('width:67%');
    const stopped = panel(
      makeJob({
        state: 'failed',
        failedAt: 1,
        error: generateErrorMessage('balance_empty'),
        generate: makeGenerateState(),
      }),
    );
    expect(stopped).toContain('data-bar="muted"');
    expect(stopped).toContain('4 of 6 · kept');
  });

  it('colours a clip below the bar and spent money amber', () => {
    const html = panel(
      makeJob({
        state: 'review',
        generate: makeGenerateState({
          phase: 'done',
          spendUsd: 3,
          counts: { ...makeGenerateState().counts, clips: { done: 6, total: 6 }, belowBar: 1 },
        }),
      }),
    );
    expect(html).toContain('text-amber-400');
    expect(html).toContain('data-bar="warn"');
  });

  it('is wider in its label column on the phone', () => {
    expect(panel(undefined, 'phone')).toContain('grid-cols-[112px_minmax(0,1fr)]');
    expect(panel()).toContain('grid-cols-[96px_minmax(0,1fr)]');
  });
});

describe('JobSheetFiles', () => {
  const ready = makeJob({
    id: 'gn1',
    name: '97 Window Ad',
    state: 'ready',
    output: {
      fileName: 'Pinewood/97 Window Ad.mp4',
      durationSec: 35,
      width: 1080,
      height: 1920,
      sizeBytes: 27_000_000,
      outputs: [
        { format: '9x16', fileName: 'Pinewood/97 Window Ad.mp4', bytes: 27_000_000 },
        { format: '1x1', fileName: 'Pinewood/97 Window Ad (1x1).mp4', bytes: 21_000_000 },
      ],
    },
  });

  it('has a Download for each file, named by its format', () => {
    const html = renderToStaticMarkup(<JobSheetFiles files={sheetFiles(ready)} />);
    expect(html).toContain('97 Window Ad.mp4');
    expect(html).toContain('97 Window Ad (1x1).mp4');
    expect(html).toContain('href="/api/jobs/gn1/download?format=1x1"');
    expect(html).toContain('aria-label="Download 9:16"');
    expect(html).toContain('1:1 · 0:35 · 21 MB');
  });

  it('shows nothing for a job with one file, and waits while the engine is out of reach', () => {
    expect(renderToStaticMarkup(<JobSheetFiles files={[]} />)).toBe('');
    const waiting = renderToStaticMarkup(<JobSheetFiles files={sheetFiles(ready)} waiting />);
    expect(waiting).toContain('aria-disabled="true"');
    expect(waiting).not.toContain('href=');
  });
});

describe('NowError for a stop in Generate', () => {
  const error = sheetError(
    makeJob({
      state: 'failed',
      failedAt: 1,
      error: generateErrorMessage('balance_empty'),
      generate: makeGenerateState(),
    }),
  );

  it('shows the title, the code line and the help on the Mac', () => {
    if (error === null) throw new Error('no error');
    const html = renderToStaticMarkup(<NowError error={error} />);
    expect(html).toContain('Higgsfield balance is empty');
    expect(html).toContain('HTTP 403 · Insufficient balance');
    expect(html).toContain('Add funds in the Higgsfield console');
    expect(html).toContain('Copy');
  });

  it('shows the same three on the phone, with Copy error', () => {
    if (error === null) throw new Error('no error');
    const html = renderToStaticMarkup(<NowError error={error} variant="phone" />);
    expect(html).toContain('Higgsfield balance is empty');
    expect(html).toContain('HTTP 403 · Insufficient balance');
    expect(html).toContain('Copy error');
  });

  it('is what it was for any other failure', () => {
    const plain = sheetError(makeJob({ state: 'failed', failedAt: 8, error: 'Disk is full.' }));
    if (plain === null) throw new Error('no error');
    const html = renderToStaticMarkup(<NowError error={plain} variant="phone" />);
    expect(html).toContain('Disk is full.');
    expect(html).not.toContain('HTTP');
  });
});
