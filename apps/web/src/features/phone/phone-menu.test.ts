import { type Job, orphanAsJob } from '@studio/shared';
import { Share } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { downloadUrl } from '@/data';
import { makeJob, makeOrphanDelivery, makeSeriesSummary } from '@/data/test-utils';
import {
  JOB_SHEET_STATES,
  type JobSheetState,
  jobSheetJobs,
} from '@/features/job-sheet/test-fixtures';
import type { RowActions } from '@/features/jobs/cells/use-row-actions';
import { type JobMenuEntry, rowMenuEntries } from '@/features/jobs/row-menu';
import type { SeriesMenuContext } from '@/features/series/series-menu';
import {
  EFFORT_SUBMENU_HINT,
  effortDetail,
  type PhoneItemRow,
  type PhoneMenuRow,
  type PhoneSubmenuRow,
  phoneMenuRows,
} from './phone-menu';
import { SHARE_IDLE, type ShareFlow, type ShareTarget } from './share-video';

type Actions = Pick<
  RowActions,
  'run' | 'busy' | 'setEffort' | 'archive' | 'unarchive' | 'archiveAllPaid'
>;

function actionsOf(overrides: Partial<Actions> = {}): Actions {
  return {
    run: vi.fn(),
    busy: false,
    setEffort: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    archiveAllPaid: vi.fn(),
    ...overrides,
  };
}

function entriesOf(
  job: Job,
  actions: Actions = actionsOf(),
  series?: SeriesMenuContext,
  paidIds: readonly string[] = [],
): JobMenuEntry[] {
  return rowMenuEntries(job, actions, null, series, { paidIds });
}

function rowsOf(job: Job, actions?: Actions, series?: SeriesMenuContext): PhoneMenuRow[] {
  return phoneMenuRows(entriesOf(job, actions, series), job);
}

/** The rows as a line of ids. */
const shape = (rows: readonly PhoneMenuRow[]): string[] => rows.map((row) => row.id);

const itemOf = (rows: readonly PhoneMenuRow[], id: string): PhoneItemRow => {
  const row = rows.find((candidate) => candidate.kind === 'item' && candidate.id === id);
  if (row === undefined || row.kind !== 'item') throw new Error(`no item row ${id}`);
  return row;
};

const submenuOf = (rows: readonly PhoneMenuRow[], id: string): PhoneSubmenuRow => {
  const row = rows.find((candidate) => candidate.kind === 'submenu' && candidate.id === id);
  if (row === undefined || row.kind !== 'submenu') throw new Error(`no submenu row ${id}`);
  return row;
};

describe('phoneMenuRows: every state of the Job sheet boards', () => {
  // What each state's list is, top to bottom: flat, as the boards draw it (the Mac's lines between
  // groups are left out). The next step (its big button) and Copy error (the error box) are not in
  // it; Note and Effort are not once the job has locked them (editing, rendering, ready).
  const EXPECTED: Record<JobSheetState, string[]> = {
    arriving: ['note', 'effort', 'hold'],
    queued: ['note', 'effort', 'hold'],
    held: ['note', 'effort', 'archive'],
    editing: ['cancel'],
    failed: ['note', 'effort', 'archive'],
    cancelled: ['note', 'effort', 'archive'],
    review: ['effort', 'archive'],
    reviewRound2: ['effort', 'archive'],
    rendering: ['cancel'],
    approved: ['view-preview', 'deliver', 'download', 'use-look', 'unapprove', 'archive'],
    delivered: ['download', 'undeliver', 'archive'],
    paid: ['download', 'unpay', 'archive'],
    archived: ['download', 'unpay', 'unarchive'],
  };

  for (const state of JOB_SHEET_STATES) {
    it(`${state}: ${EXPECTED[state].join(' ')}`, () => {
      expect(shape(rowsOf(jobSheetJobs[state]))).toEqual(EXPECTED[state]);
    });
  }

  it('leaves out the next step: its label is the big button’s', () => {
    // Start now (arriving), Release (held), Retry from Render (failed), Resume (cancelled),
    // Mark paid… (delivered).
    expect(shape(rowsOf(jobSheetJobs.arriving))).not.toContain('start');
    expect(shape(rowsOf(jobSheetJobs.held))).not.toContain('release');
    expect(shape(rowsOf(jobSheetJobs.failed))).not.toContain('retry');
    expect(shape(rowsOf(jobSheetJobs.cancelled))).not.toContain('resume');
    expect(shape(rowsOf(jobSheetJobs.delivered))).not.toContain('pay');
  });

  it('keeps Mark delivered in an approved job’s list: its button is Share video (Mobile 4)', () => {
    const rows = rowsOf(jobSheetJobs.approved);
    expect(itemOf(rows, 'deliver').label).toBe('Mark delivered');
    expect(shape(rows)[0]).toBe('view-preview');
  });

  it('leaves out the entry the sheet says is its button: Download MP4 where the phone can’t share', () => {
    const job = jobSheetJobs.approved;
    expect(shape(phoneMenuRows(entriesOf(job), job, 'download'))).toEqual([
      'view-preview',
      'deliver',
      'use-look',
      'unapprove',
      'archive',
    ]);
  });

  describe('with the share flow (U16): Share video in place of Download MP4', () => {
    const target = {
      url: '/api/jobs/x/download',
      fileName: 'x.mp4',
      sizeBytes: 27_000_000,
    } satisfies ShareTarget;
    const rowsShared = (state: JobSheetState, flow: ShareFlow, onShare = vi.fn()) => {
      const job = jobSheetJobs[state];
      return phoneMenuRows(entriesOf(job), job, undefined, { flow, target, onShare });
    };

    it('a delivered, paid or archived job’s list has Share video where Download MP4 was', () => {
      const delivered = rowsShared('delivered', SHARE_IDLE);
      expect(shape(delivered)).toEqual(['share', 'undeliver', 'archive']);
      expect(shape(rowsShared('paid', SHARE_IDLE))).toEqual(['share', 'unpay', 'archive']);
      expect(shape(rowsShared('archived', SHARE_IDLE))).toEqual(['share', 'unpay', 'unarchive']);
      const share = itemOf(delivered, 'share');
      expect(share).toMatchObject({ label: 'Share video', href: null, reason: null });
      expect(share.icon).toBe(Share);
    });

    it('an approved job has no Download MP4 row either: its big button is Share video', () => {
      expect(shape(rowsShared('approved', SHARE_IDLE))).toEqual([
        'view-preview',
        'deliver',
        'use-look',
        'unapprove',
        'archive',
      ]);
    });

    it('the tap on the row is the flow’s share', () => {
      const onShare = vi.fn();
      itemOf(rowsShared('delivered', SHARE_IDLE, onShare), 'share').onSelect();
      expect(onShare).toHaveBeenCalledOnce();
    });

    it('says Preparing the video with the megabytes while it comes in', () => {
      const row = itemOf(
        rowsShared('paid', { phase: 'getting', loaded: 12_000_000, total: 27_000_000 }),
        'share',
      );
      expect(row.label).toBe('Preparing the video · 12 of 27 MB');
      expect(row.href).toBeNull();
    });

    it('is Share video again once the video is in hand, and while the share sheet is open', () => {
      const file = new File([new Uint8Array(3)], 'x.mp4', { type: 'video/mp4' });
      for (const flow of [
        { phase: 'ready', file },
        { phase: 'sharing', file },
      ] as const) {
        expect(itemOf(rowsShared('delivered', flow), 'share').label).toBe('Share video');
      }
    });

    it('is the Mac’s Download MP4 link, with the reason, only where the browser can’t share', () => {
      const unsupported = itemOf(rowsShared('delivered', { phase: 'unsupported' }), 'download');
      expect(unsupported).toMatchObject({
        label: 'Download MP4',
        href: target.url,
        reason: 'This browser can’t share files, so it downloads instead.',
      });
      const failed = itemOf(
        rowsShared('paid', { phase: 'failed', message: 'The export file is missing.' }),
        'download',
      );
      expect(failed.href).toBe(target.url);
      expect(failed.reason).toBe('Couldn’t get the video to share: The export file is missing.');
    });
  });

  it('leaves out Review…: the sheet’s big button opens the phone Review', () => {
    expect(shape(rowsOf(jobSheetJobs.review))).not.toContain('review');
  });

  it('leaves out Copy error: the error box has its own', () => {
    expect(shape(rowsOf(jobSheetJobs.failed))).not.toContain('copy');
  });
});

describe('phoneMenuRows: how a row is drawn', () => {
  it('keeps the entry’s label, icon and action', () => {
    const run = vi.fn();
    const rows = rowsOf(jobSheetJobs.queued, actionsOf({ run }));
    const hold = itemOf(rows, 'hold');
    expect(hold.label).toBe('Hold');
    expect(hold.icon).toBeTruthy();
    expect(hold.destructive).toBe(false);
    expect(hold.disabled).toBe(false);
    hold.onSelect();
    expect(run).toHaveBeenCalledWith({ kind: 'hold', label: 'Hold' });
  });

  it('says Add note… until the job has a note, then Edit note…', () => {
    expect(itemOf(rowsOf(jobSheetJobs.queued), 'note').label).toBe('Edit note…'); // the fixture has one
    expect(itemOf(rowsOf(jobSheetJobs.held), 'note').label).toBe('Add note…');
  });

  it('draws Cancel… red', () => {
    expect(itemOf(rowsOf(jobSheetJobs.editing), 'cancel').destructive).toBe(true);
  });

  it('draws a row disabled while a request for the job is on its way', () => {
    const rows = rowsOf(jobSheetJobs.queued, actionsOf({ busy: true }));
    expect(itemOf(rows, 'hold').disabled).toBe(true);
  });

  it('keeps a row’s reason under its label when it is disabled with one', () => {
    const entries: JobMenuEntry[] = [
      {
        type: 'item',
        id: 'x',
        label: 'Something',
        icon: itemOf(rowsOf(jobSheetJobs.queued), 'hold').icon,
        disabled: true,
        disabledReason: 'Only an approved episode can be the format',
        onSelect: () => {},
      },
    ];
    const [row] = phoneMenuRows(entries, jobSheetJobs.queued);
    expect(row).toMatchObject({
      kind: 'item',
      disabled: true,
      reason: 'Only an approved episode can be the format',
    });
  });

  it('makes Download MP4 a link', () => {
    const download = itemOf(rowsOf(jobSheetJobs.approved), 'download');
    expect(download.href).toBe(downloadUrl(jobSheetJobs.approved.id));
    expect(itemOf(rowsOf(jobSheetJobs.approved), 'archive').href).toBeNull();
  });

  it('names the client in the Use this look row, in its own direction', () => {
    const look = itemOf(rowsOf(jobSheetJobs.approved), 'use-look');
    expect(look.label).toBe(`Use this look for ${jobSheetJobs.approved.client}…`);
    expect(look.bidi).toBe(jobSheetJobs.approved.client);
  });

  it('keeps Archive all paid · N when the paid job has company', () => {
    const job = jobSheetJobs.paid;
    const entries = entriesOf(job, actionsOf(), undefined, [job.id, 'other']);
    expect(shape(phoneMenuRows(entries, job))).toEqual([
      'download',
      'unpay',
      'archive',
      'archive-all-paid',
    ]);
  });

  it('is a list for a video whose folder was deleted: Not delivered yet, and Mark paid… as the button', () => {
    const gone = orphanAsJob(makeOrphanDelivery());
    expect(shape(phoneMenuRows(rowMenuEntries(gone, actionsOf()), gone))).toEqual(['undeliver']);
  });
});

describe('phoneMenuRows: the Effort sub-view', () => {
  it('is a row with the choice in use at its end, and the level of Default', () => {
    const queued = jobSheetJobs.queued; // effort: high
    expect(submenuOf(rowsOf(queued), 'effort').value).toBe('High');
    const held = jobSheetJobs.held; // effort: Default
    expect(submenuOf(rowsOf(held), 'effort').value).toBe('Default · Extra high');
    expect(submenuOf(rowsOf({ ...held, effort: 'medium' }), 'effort').value).toBe('Medium');
    expect(submenuOf(rowsOf({ ...held, effort: 'xhigh' }), 'effort').value).toBe('Extra high');
  });

  it('opens “‹ Effort” with the hint line and the four choices, a rule under Default', () => {
    const { view } = submenuOf(rowsOf(jobSheetJobs.queued), 'effort');
    expect(view.title).toBe('Effort');
    expect(view.hint).toBe(EFFORT_SUBMENU_HINT);
    expect(EFFORT_SUBMENU_HINT).toBe(
      'How hard the editor works on this video. Higher takes longer.',
    );
    expect(view.options.map((option) => [option.id, option.label, option.hint])).toEqual([
      ['default', 'Default', 'Extra high'],
      ['medium', 'Medium', 'quickest'],
      ['high', 'High', 'slower'],
      ['xhigh', 'Extra high', 'slowest'],
    ]);
    expect(view.options.map((option) => option.ruleAbove)).toEqual([false, true, false, false]);
    expect(view.options.every((option) => option.icon !== null)).toBe(true);
  });

  it('checks the job’s level: High for a job on High, Default for one on Default', () => {
    const checked = (job: Job) =>
      submenuOf(rowsOf(job), 'effort')
        .view.options.filter((option) => option.checked)
        .map((option) => option.id);
    expect(checked(jobSheetJobs.queued)).toEqual(['high']);
    expect(checked(jobSheetJobs.held)).toEqual(['default']);
  });

  it('saves the choice through the sheet’s own request: a level, or null for Default', () => {
    const setEffort = vi.fn();
    const { view } = submenuOf(rowsOf(jobSheetJobs.queued, actionsOf({ setEffort })), 'effort');
    view.onPick('medium');
    view.onPick('xhigh');
    view.onPick('default');
    expect(setEffort.mock.calls).toEqual([['medium'], ['xhigh'], [null]]);
  });

  it('is not in the list once the edit has started or the job is ready; Details says the level', () => {
    for (const state of ['editing', 'rendering', 'approved', 'delivered', 'paid'] as const) {
      expect(shape(rowsOf(jobSheetJobs[state])), state).not.toContain('effort');
    }
    expect(effortDetail({ effort: null })).toBe('Default · Extra high');
    expect(effortDetail({ effort: 'high' })).toBe('High');
  });
});

describe('phoneMenuRows: series', () => {
  const series = [
    makeSeriesSummary({ id: 'a1', name: 'מיתוס או אמת' }),
    makeSeriesSummary({ id: 'b2', name: 'Second' }),
  ];
  const on = (): SeriesMenuContext => ({
    enabled: true,
    clientSeries: series,
    setJobSeries: vi.fn(),
    openSeries: vi.fn(),
  });
  /** Every row the Mac's menu has for a series. */
  const SERIES_IDS = [
    'series',
    'series-start',
    'series-format',
    'series-is-format',
    'series-open',
    'series-take-out',
  ];

  it('has the Mac’s series entries to start with, so leaving them out is the phone’s choice', () => {
    const queued = { ...jobSheetJobs.queued, seriesId: 'a1', episode: 3 };
    const ids = entriesOf(queued, actionsOf(), on()).map((entry) => entry.id);
    expect(ids).toContain('series');
    expect(ids).toContain('series-open');
  });

  it('has no series row in any state of a job in a series: they all stay on the Mac (boards MJobSheet*)', () => {
    for (const job of Object.values(jobSheetJobs)) {
      const inSeries = { ...job, seriesId: 'a1', episode: 3 };
      const ids = shape(rowsOf(inSeries, actionsOf(), on()));
      for (const id of SERIES_IDS) expect(ids, `${job.state} has no ${id}`).not.toContain(id);
    }
  });

  it('has no Start a series… on a ready job in none', () => {
    const ids = shape(rowsOf(jobSheetJobs.approved, actionsOf(), on()));
    for (const id of SERIES_IDS) expect(ids).not.toContain(id);
  });

  it('keeps the rows the job has without a series, in the same order', () => {
    for (const job of Object.values(jobSheetJobs)) {
      const inSeries = { ...job, seriesId: 'a1', episode: 3 };
      expect(shape(rowsOf(inSeries, actionsOf(), on()))).toEqual(shape(rowsOf(job)));
    }
  });

  it('is what series-off is: no series rows at all', () => {
    expect(shape(rowsOf(jobSheetJobs.queued))).not.toContain('series');
  });
});

describe('phoneMenuRows: a job made on the spot', () => {
  it('works from a job and its entries alone (no hooks, no network)', () => {
    const job = makeJob({ state: 'queued', placeInLine: 2 });
    expect(shape(phoneMenuRows(entriesOf(job), job))).toEqual(['note', 'effort', 'hold']);
  });

  it('leaves Rename… on the Mac: the phone has no rename', () => {
    const job = makeJob({ state: 'failed' });
    const entries = entriesOf(job);

    expect(entries.map((entry) => entry.id)).toContain('rename');
    expect(phoneMenuRows(entries, job).map((row) => row.id)).not.toContain('rename');
  });
});

describe('phoneMenuRows: the Effort sub-view of a job in Review with Quick fixes on', () => {
  const review = jobSheetJobs.review;
  const withQuickFixes = (job: Job) => {
    const actions = { ...actionsOf(), setReviewEffort: vi.fn() };
    const entries = rowMenuEntries(job, actions, null, undefined, undefined, true, false, true);
    return { actions, rows: phoneMenuRows(entries, job) };
  };

  it('is a row, now that Review lets it change: Auto at its end, or the level', () => {
    expect(shape(withQuickFixes(review).rows)).toContain('effort');
    expect(submenuOf(withQuickFixes({ ...review, reviewEffort: null }).rows, 'effort').value).toBe(
      'Auto',
    );
    expect(
      submenuOf(withQuickFixes({ ...review, reviewEffort: 'medium' }).rows, 'effort').value,
    ).toBe('Medium');
  });

  it('wears sparkles for Auto and the level’s gauge otherwise', () => {
    expect(submenuOf(withQuickFixes({ ...review, reviewEffort: null }).rows, 'effort').icon).toBe(
      effortIcon('auto'),
    );
    expect(submenuOf(withQuickFixes({ ...review, reviewEffort: 'high' }).rows, 'effort').icon).toBe(
      gaugeIcon('high'),
    );
  });

  it('opens “‹ Effort” with Auto’s line of help and the four choices, a rule under Auto', () => {
    const { view } = submenuOf(withQuickFixes(review).rows, 'effort');
    expect(view.title).toBe('Effort');
    expect(view.hint).toBe(
      'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
    );
    expect(view.options.map((option) => [option.id, option.label, option.hint])).toEqual([
      ['auto', 'Auto', 'Default'],
      ['medium', 'Medium', ''],
      ['high', 'High', ''],
      ['xhigh', 'Extra high', ''],
    ]);
    expect(view.options.map((option) => option.ruleAbove)).toEqual([false, true, false, false]);
    expect(view.options.map((option) => option.icon)).toEqual([
      effortIcon('auto'),
      gaugeIcon('medium'),
      gaugeIcon('high'),
      gaugeIcon('xhigh'),
    ]);
  });

  it('checks the job’s review effort', () => {
    const checked = (reviewEffort: Job['reviewEffort']) =>
      submenuOf(withQuickFixes({ ...review, reviewEffort }).rows, 'effort')
        .view.options.filter((option) => option.checked)
        .map((option) => option.id);
    expect(checked(null)).toEqual(['auto']);
    expect(checked('high')).toEqual(['high']);
  });

  it('saves the review effort through the sheet’s own request: null for Auto, else the level', () => {
    const { actions, rows } = withQuickFixes(review);
    const { view } = submenuOf(rows, 'effort');
    view.onPick('xhigh');
    view.onPick('auto');
    expect(actions.setReviewEffort.mock.calls).toEqual([['xhigh'], [null]]);
    expect(actions.setEffort).not.toHaveBeenCalled();
  });

  it('leaves a job that is not in Review alone: its Effort has Default and the phone’s own line', () => {
    const { view } = submenuOf(withQuickFixes(jobSheetJobs.queued).rows, 'effort');
    expect(view.hint).toBe(EFFORT_SUBMENU_HINT);
    expect(view.options.map((option) => option.id)).toEqual(['default', 'medium', 'high', 'xhigh']);
  });

  it('is still left out for a review job with Quick fixes off (the Mac’s Effort, no Auto)', () => {
    const rows = phoneMenuRows(
      rowMenuEntries(review, { ...actionsOf(), setReviewEffort: vi.fn() }),
      review,
    );
    const { view } = submenuOf(rows, 'effort');
    expect(view.options.map((option) => option.id)).toEqual(['default', 'medium', 'high', 'xhigh']);
  });
});
