import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeJob } from '@/data/test-utils';
import { DELIVERY_ROW_JOBS, REVIEW_ROW_JOBS } from '../test-jobs';
import { ActionCell } from './ActionCell';
import { canvasJob, renderCell } from './test-helpers';
import { RowActionsContext } from './use-row-actions';

const reviewJob = REVIEW_ROW_JOBS.find((job) => job.state === 'review');

const actionCell = (id: string) => renderCell(<ActionCell job={canvasJob(id)} />);

/** The accessible names of the buttons and links in a cell, left to right. */
const names = (markup: string) => [...markup.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);

describe('<ActionCell>: the one button of each state', () => {
  it('shows a Play button during Render when a preview already exists', () => {
    const job = makeJob({
      state: 'editing',
      runKind: 'render',
      step: 8,
      preview: { durationSec: 30, width: 1080, height: 1920 },
    });
    const markup = renderCell(<ActionCell job={job} />);
    expect(names(markup)).toEqual(['View preview']);
    expect(markup).toContain('lucide-play');
  });

  it.each([
    ['j1', 'arriving', ['Start now']],
    ['j2', 'queued', []],
    ['j3', 'held', ['Release']],
    ['j5', 'editing', []],
    ['j6', 'ready', ['Mark delivered']],
    ['j7', 'failed', ['Retry from Render']],
    ['j8', 'cancelled', ['Resume']],
  ] as const)('%s (%s) has %j', (id, _state, expected) => {
    expect(names(actionCell(id))).toEqual(expected);
  });

  it('opens the job’s chat from a job that waits or runs, with Draft & chat on', () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, {
      ok: true,
      version: '0.57.0',
      settleMs: 60_000,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
      music: false,
      luts: false,
      lutsInEdits: false,
      fonts: false,
      fontsInNotes: false,
      quickFixes: false,
      draftChat: true,
    });
    for (const state of ['queued', 'editing'] as const) {
      const markup = renderCell(<ActionCell job={makeJob({ state, step: 2 })} />, queryClient);
      expect(names(markup)).toEqual(['Open the chat']);
    }
    // Off, a running job has no button, as before.
    expect(names(renderCell(<ActionCell job={makeJob({ state: 'editing', step: 2 })} />))).toEqual(
      [],
    );
  });

  it('keeps Hold, Cancel and Copy error out of the cell: they are in the row menu', () => {
    for (const id of ['j1', 'j2', 'j5', 'j7']) {
      const markup = actionCell(id);
      expect(markup).not.toContain('aria-label="Hold"');
      expect(markup).not.toContain('aria-label="Cancel');
      expect(markup).not.toContain('aria-label="Copy error"');
      expect(markup).not.toContain('lucide-copy');
    }
  });

  it('right-aligns the button in a 32 px tall box, which is there even when it holds nothing', () => {
    for (const id of ['j1', 'j2', 'j5']) {
      expect(actionCell(id)).toContain('class="flex min-h-8 items-center justify-end"');
    }
  });

  it('draws every button as a 32 px ghost icon button', () => {
    for (const id of ['j1', 'j3', 'j6', 'j7', 'j8']) {
      const markup = actionCell(id);
      expect(markup).toContain('data-size="icon-sm"');
      expect(markup).toContain('data-variant="ghost"');
      expect(markup).not.toContain('data-variant="outline"');
      expect(markup).not.toContain('data-variant="default"');
    }
  });

  it('uses the play icon for Start now, Release and Resume, and rotate-ccw for Retry', () => {
    expect(actionCell('j1')).toContain('lucide-play');
    expect(actionCell('j3')).toContain('lucide-play');
    expect(actionCell('j8')).toContain('lucide-play');
    expect(actionCell('j7')).toContain('lucide-rotate-ccw');
    expect(actionCell('j6')).toContain('lucide-send');
  });
});

const stageJob = (id: string) => {
  const job = DELIVERY_ROW_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no job ${id}`);
  return job;
};

describe('<ActionCell>: the stages of a ready job', () => {
  const stageCell = (id: string, run = () => {}, busy = false) =>
    renderCell(
      <RowActionsContext.Provider
        value={{
          run,
          setEffort: () => {},
          setReviewEffort: () => {},
          archive: () => {},
          unarchive: () => {},
          archiveAllPaid: () => {},
          busy,
          refusal: null,
          dismissRefusal: () => {},
        }}
      >
        <ActionCell job={stageJob(id)} />
      </RowActionsContext.Provider>,
    );

  it('Approved: Send, named Mark delivered', () => {
    const markup = stageCell('d3');
    expect(names(markup)).toEqual(['Mark delivered']);
    expect(markup).toContain('lucide-send');
    expect(markup).toContain('data-variant="ghost"');
    expect(markup).toContain('data-size="icon-sm"');
  });

  it('Delivered: Banknote, named Mark paid…', () => {
    const markup = stageCell('d6');
    expect(names(markup)).toEqual(['Mark paid…']);
    expect(markup).toContain('lucide-banknote');
  });

  it('Paid: nothing, but the 32 px box the refusal tooltip points at', () => {
    const markup = stageCell('d9');
    expect(names(markup)).toEqual([]);
    expect(markup).not.toContain('<button');
    expect(markup).toContain('class="flex min-h-8 items-center justify-end"');
  });

  it('no longer has Download MP4 at any stage: the file is in the row menu', () => {
    for (const id of ['d3', 'd6', 'd9']) {
      const markup = stageCell(id);
      expect(markup).not.toContain('Download MP4');
      expect(markup).not.toContain('lucide-download');
      expect(markup).not.toContain('<a ');
    }
  });

  it('disables Mark delivered while one of the row’s requests is in flight, but not Mark paid…, which sends none', () => {
    expect(stageCell('d3', () => {}, true)).toContain(' disabled=""');
    expect(stageCell('d6', () => {}, true)).not.toContain(' disabled=""');
  });
});

describe('<ActionCell>: nothing mid-air', () => {
  it('starts with every button enabled and no error showing', () => {
    for (const id of ['j1', 'j3', 'j7', 'j8']) {
      const markup = actionCell(id);
      expect(markup).not.toContain(' disabled=""');
      expect(markup).not.toContain('role="alert"');
    }
  });

  it('does not carry the Stop this edit? dialog: that belongs to the page (CancelDialogHost)', () => {
    const markup = actionCell('j5');
    expect(markup).not.toContain('Stop this edit?');
    expect(markup).not.toContain('alertdialog');
  });

  it('marks its box with the job id, so the page can give focus back to its button', () => {
    expect(actionCell('j5')).toContain('data-row-actions="j5"');
    expect(actionCell('j7')).toContain('data-row-actions="j7"');
  });
});

describe('<ActionCell>: Review', () => {
  const reviewCell = (busy: boolean) => {
    if (!reviewJob) throw new Error('no review job in the fixtures');
    return renderCell(
      <RowActionsContext.Provider
        value={{
          run: () => {},
          setEffort: () => {},
          setReviewEffort: () => {},
          archive: () => {},
          unarchive: () => {},
          archiveAllPaid: () => {},
          busy,
          refusal: null,
          dismissRefusal: () => {},
        }}
      >
        <ActionCell job={reviewJob} />
      </RowActionsContext.Provider>,
    );
  };

  it('is a ghost icon button named Review, with the play icon', () => {
    const markup = reviewCell(false);
    expect(names(markup)).toEqual(['Review']);
    expect(markup).toContain('lucide-play');
    expect(markup).toContain('data-variant="ghost"');
    expect(markup).toContain('data-size="icon-sm"');
    expect(markup).toContain('data-row-actions="r1"');
  });

  it('is not disabled while one of the row’s requests is in flight: it sends none', () => {
    expect(reviewCell(true)).not.toContain(' disabled=""');
  });

  it('is a button, not a link', () => {
    expect(reviewCell(false)).not.toContain('<a ');
  });
});
