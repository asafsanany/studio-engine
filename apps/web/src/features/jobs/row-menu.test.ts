import { canEditEffort, canEditNote, JOB_STATES } from '@studio/shared';
import { Check, MessageSquarePlus, MessageSquareText, Palette, Pencil } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gaugeIcon } from '@/components/effort-gauge';
import { ROW_ACTION_ICONS } from '@/components/jobs/IconAction';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { previewViewerStore } from '@/features/review/preview-viewer';
import { reviewDialogStore } from '@/features/review/review-dialog';
import type { RunnableRowAction } from './cells/use-row-actions';
import { EFFORT_OPTIONS } from './effort-options';
import { markPaidRequestStore } from './mark-paid/request';
import { noteDialogStore } from './note-dialog';
import { renameDialogStore } from './rename-job-dialog';
import { CANVAS_JOBS, DELIVERY_ROW_JOBS, REVIEW_ROW_JOBS } from './test-jobs';
import { lookDialogStore } from './use-look/use-look-dialog';

const copyError = vi.fn();
vi.mock('./copy-error', () => ({ copyError: (text: string) => copyError(text) }));

const { effortMenuEntry, leadingMenuEntries, lookMenuEntries, renameMenuEntry, rowMenuEntries } =
  await import('./row-menu');

const canvasJob = (id: string) => {
  const job = CANVAS_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no canvas job ${id}`);
  return job;
};

const run = vi.fn<(action: RunnableRowAction) => void>();
const idle = { run, busy: false };

/** The row's actions, without the note and rename items that lead the menu (they have their own tests below). */
const items = (id: string, actions = idle) =>
  rowMenuEntries(canvasJob(id), actions).flatMap((entry) =>
    entry.type === 'item' && entry.id !== 'note' && entry.id !== 'rename' ? [entry] : [],
  );

beforeEach(() => {
  run.mockClear();
  copyError.mockClear();
  noteDialogStore.getState().reset();
  reviewDialogStore.getState().reset();
  previewViewerStore.getState().reset();
  lookDialogStore.getState().reset();
  markPaidRequestStore.getState().close();
  renameDialogStore.getState().dismiss();
});

describe('rowMenuEntries: what the right-click menu holds', () => {
  it.each([
    ['j1', 'arriving', ['Start now', 'Hold']],
    ['j2', 'queued', ['Hold']],
    ['j3', 'held', ['Release']],
    ['j5', 'editing', ['Cancel…']],
    ['j6', 'ready', ['Mark delivered', 'Download MP4', 'Use this look for Kova Coffee…']],
    ['j7', 'failed', ['Retry from Render', 'Copy error']],
    ['j8', 'cancelled', ['Resume']],
  ] as const)('%s (%s): %j', (id, state, expected) => {
    expect(canvasJob(id).state).toBe(state);
    expect(items(id).map((item) => item.label)).toEqual(expected);
  });

  it('gives every item a key of its own and an icon', () => {
    for (const job of CANVAS_JOBS) {
      const entries = rowMenuEntries(job, idle);
      const ids = entries.map((entry) => entry.id);
      expect(new Set(ids).size, job.id).toBe(ids.length);
      for (const entry of entries) if (entry.type === 'item') expect(entry.icon).toBeDefined();
    }
  });

  it('leads every menu with the note and rename items and a separator, then the actions (a review job leads with Review… instead)', () => {
    for (const job of CANVAS_JOBS.filter((candidate) => candidate.state !== 'review')) {
      const entries = rowMenuEntries(job, idle);
      expect(entries.slice(0, 3).map((entry) => [entry.type, entry.id])).toEqual([
        ['item', 'note'],
        ['item', 'rename'],
        ['separator', 'note-separator'],
      ]);
      // Nothing but the actions after the line: no second note item, and no other line unless the
      // job is ready, which puts what is not the next step after one of its own.
      const rest = entries.slice(3);
      expect(
        rest.every((entry) => entry.id !== 'note' && entry.id !== 'rename'),
        job.id,
      ).toBe(true);
      expect(
        rest.filter((entry) => entry.type === 'separator').map((entry) => entry.id),
        job.id,
      ).toEqual(job.state === 'ready' ? ['stage-separator'] : []);
    }
  });

  it('ends no menu with a separator, in any state', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({
        state,
        failedAt: 8,
        error: 'boom',
        preview: { durationSec: 28.4, width: 1080, height: 1920 },
      });
      expect(rowMenuEntries(job, idle).at(-1)?.type, state).not.toBe('separator');
    }
  });

  it('draws only Cancel… in the destructive (red) style', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, failedAt: 8, error: 'boom' });
      for (const entry of rowMenuEntries(job, idle)) {
        if (entry.type !== 'item') continue;
        expect(Boolean(entry.destructive), `${state}: ${entry.label}`).toBe(
          entry.label === 'Cancel…',
        );
      }
    }
  });
});

describe('rowMenuEntries: choosing an item', () => {
  it('opens a view-only preview in any stage that still has one', () => {
    for (const state of ['queued', 'editing', 'failed', 'cancelled', 'ready'] as const) {
      const job = makeJob({
        id: `preview-${state}`,
        state,
        preview: { durationSec: 28, width: 1080, height: 1920 },
      });
      const entry = rowMenuEntries(job, idle).find((item) => item.id === 'view-preview');
      expect(entry?.type).toBe('item');
      if (entry?.type !== 'item') continue;
      expect(entry.label).toBe('View preview…');
      entry.onSelect();
      expect(previewViewerStore.getState().jobId).toBe(job.id);
    }
    expect(
      rowMenuEntries(makeJob({ state: 'editing', preview: null }), idle).some(
        (item) => item.id === 'view-preview',
      ),
    ).toBe(false);
  });

  it('sends a server action through the row (Start now, Hold, Release, Resume, Retry)', () => {
    items('j1')[0]?.onSelect();
    items('j1')[1]?.onSelect();
    items('j3')[0]?.onSelect();
    items('j7')[0]?.onSelect();
    items('j8')[0]?.onSelect();
    expect(run.mock.calls.map(([action]) => action)).toEqual([
      { kind: 'start', label: 'Start now' },
      { kind: 'hold', label: 'Hold' },
      { kind: 'release', label: 'Release' },
      { kind: 'retry', label: 'Retry from Render' },
      { kind: 'resume', label: 'Resume' },
    ]);
  });

  it('hands Cancel… to the row, which asks the page for the "Stop this edit?" dialog', () => {
    items('j5')[0]?.onSelect();
    expect(run).toHaveBeenCalledWith({ kind: 'cancel', label: 'Cancel…' });
  });

  it('copies the error text for Copy error, and sends nothing to the server', () => {
    const copy = items('j7')[1];
    expect(copy?.label).toBe('Copy error');
    copy?.onSelect();
    expect(copyError).toHaveBeenCalledTimes(1);
    expect(copyError).toHaveBeenCalledWith(canvasJob('j7').error);
    expect(run).not.toHaveBeenCalled();
  });

  it('makes Download MP4 a link to the file, which does nothing else when chosen', () => {
    const download = items('j6').find((item) => item.id === 'download');
    expect(download?.href).toBe('/api/jobs/j6/download');
    download?.onSelect();
    expect(run).not.toHaveBeenCalled();
    expect(copyError).not.toHaveBeenCalled();
  });

  it('is not a link for anything else', () => {
    for (const id of ['j1', 'j2', 'j3', 'j5', 'j7', 'j8']) {
      for (const item of items(id)) expect(item.href, `${id}: ${item.label}`).toBeUndefined();
    }
  });

  it('waits for the answer while one of the row’s requests is in flight', () => {
    const busy = { run, busy: true };
    for (const item of items('j1', busy)) expect(item.disabled, item.label).toBe(true);
    const [retry, copy] = items('j7', busy);
    expect(retry?.disabled).toBe(true);
    // Copy error and the download link do not touch the server, so they stay on.
    expect(copy?.disabled).toBeFalsy();
    const [deliver, download] = items('j6', busy);
    expect(deliver?.disabled).toBe(true);
    expect(download?.disabled).toBeFalsy();
  });

  it('is enabled when nothing is in flight', () => {
    for (const id of ['j1', 'j2', 'j3', 'j5', 'j6', 'j7', 'j8']) {
      for (const item of items(id)) expect(item.disabled, `${id}: ${item.label}`).toBeFalsy();
    }
  });
});

describe('leadingMenuEntries: the note item', () => {
  const noteItem = (job: Parameters<typeof leadingMenuEntries>[0]) => {
    const [item] = leadingMenuEntries(job);
    if (item?.type !== 'item') throw new Error('the first entry is the note item');
    return item;
  };

  it('is "Add note…" with the plus icon while the job has no note', () => {
    const item = noteItem(makeJob({ state: 'queued', note: null }));
    expect(item.label).toBe('Add note…');
    expect(item.icon).toBe(MessageSquarePlus);
  });

  it('is "Edit note…" with the text icon once it has one', () => {
    const item = noteItem(makeJob({ state: 'queued', note: 'Keep it under 30 seconds.' }));
    expect(item.label).toBe('Edit note…');
    expect(item.icon).toBe(MessageSquareText);
  });

  it.each([
    ['arriving', false],
    ['queued', false],
    ['held', false],
    ['editing', true],
    ['review', true],
    ['ready', true],
    ['failed', false],
    ['cancelled', false],
  ] as const)(
    'is disabled in %s: %s (exactly when the server would answer 409)',
    (state, disabled) => {
      for (const note of [null, 'A note']) {
        const job = makeJob({ state, note, failedAt: 8, error: 'boom' });
        expect(noteItem(job).disabled, `${state} with note ${note}`).toBe(disabled);
        expect(noteItem(job).disabled).toBe(!canEditNote(job));
      }
    },
  );

  it('is not a link, not red, and not held back by a request in flight on the row', () => {
    const item = rowMenuEntries(canvasJob('j1'), { run, busy: true })[0];
    expect(item?.type).toBe('item');
    if (item?.type !== 'item') return;
    expect(item.href).toBeUndefined();
    expect(item.destructive).toBeFalsy();
    expect(item.disabled).toBe(false);
  });

  it('asks the page for the dialog, with the job, and sends nothing to the server', () => {
    const job = makeJob({ id: 'j1', state: 'queued', note: 'Old note' });
    noteItem(job).onSelect();
    expect(noteDialogStore.getState().asked).toEqual(job);
    expect(run).not.toHaveBeenCalled();
  });

  it('asks for nothing when it is disabled (the page ignores a job that cannot take a note)', () => {
    noteItem(makeJob({ id: 'j5', state: 'editing' })).onSelect();
    expect(noteDialogStore.getState().asked).toBeNull();
  });
});

describe('the Effort submenu (CVP-192)', () => {
  const setEffort = vi.fn();
  beforeEach(() => setEffort.mockClear());

  const effortItem = (job: Parameters<typeof effortMenuEntry>[0]) =>
    effortMenuEntry(job, setEffort);

  it('comes right after the note, before the line and the actions, when the row can set it', () => {
    const entries = rowMenuEntries(canvasJob('j2'), { run, busy: false, setEffort });
    expect(entries.map((entry) => entry.id)).toEqual([
      'note',
      'rename',
      'effort',
      'note-separator',
      'hold',
    ]);
    expect(entries[2]?.type).toBe('submenu');
  });

  it('is left out when the row cannot set it (the actions alone)', () => {
    expect(rowMenuEntries(canvasJob('j2'), idle).map((entry) => entry.id)).toEqual([
      'note',
      'rename',
      'note-separator',
      'hold',
    ]);
  });

  it('offers Default (which says Extra high), then Medium, High and Extra high, each with a hint', () => {
    expect(EFFORT_OPTIONS.map((option) => [option.id, option.label, option.hint])).toEqual([
      ['default', 'Default', 'Extra high'],
      ['medium', 'Medium', 'quickest'],
      ['high', 'High', 'slower'],
      ['xhigh', 'Extra high', 'slowest'],
    ]);
    // A line sits under Default only.
    expect(EFFORT_OPTIONS.filter((option) => option.separatorAfter).map((o) => o.id)).toEqual([
      'default',
    ]);
  });

  it('checks Default and shows nothing at its end for a job with no effort', () => {
    const entry = effortItem(makeJob({ state: 'queued', effort: null }));
    expect(entry.value).toBe('default');
    expect(entry.trailing).toBeNull();
    expect(entry.icon).toBe(gaugeIcon(null));
  });

  it.each([
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
  ] as const)('checks %s, says "%s" at its end and draws its gauge', (effort, label) => {
    const entry = effortItem(makeJob({ state: 'held', effort }));
    expect(entry.value).toBe(effort);
    expect(entry.trailing).toBe(label);
    expect(entry.icon).toBe(gaugeIcon(effort));
  });

  it.each(JOB_STATES)('is disabled in %s exactly when the server would answer 409', (state) => {
    const job = makeJob({ state, failedAt: 8, error: 'boom' });
    expect(effortItem(job).disabled, state).toBe(!canEditEffort(job));
  });

  it('is locked, and still says what the run uses, once the job is editing', () => {
    const entry = effortItem(makeJob({ state: 'editing', effort: 'xhigh' }));
    expect(entry.disabled).toBe(true);
    expect(entry.trailing).toBe('Extra high');
  });

  it('sets the level that was chosen, and null for Default', () => {
    const entry = effortItem(makeJob({ state: 'queued', effort: 'xhigh' }));
    entry.onValueChange('high');
    entry.onValueChange('medium');
    entry.onValueChange('default');
    expect(setEffort.mock.calls).toEqual([['high'], ['medium'], [null]]);
  });

  it('does not open the note dialog or run an action', () => {
    effortItem(makeJob({ id: 'j2', state: 'queued' })).onValueChange('medium');
    expect(noteDialogStore.getState().asked).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('gives a review job the item too, open: the fixes can be asked for at another level', () => {
    const review = REVIEW_ROW_JOBS[0];
    if (!review) throw new Error('no review job in the fixtures');
    const entries = rowMenuEntries(review, { run, busy: false, setEffort });
    const entry = entries.find((candidate) => candidate.id === 'effort');
    expect(entry).toMatchObject({ type: 'submenu', disabled: false });
    if (entry?.type === 'submenu') entry.onValueChange('medium');
    expect(setEffort).toHaveBeenCalledWith('medium');
  });
});

describe('rowMenuEntries: a review job', () => {
  const reviewJob = () => {
    const job = REVIEW_ROW_JOBS.find((candidate) => candidate.state === 'review');
    if (!job) throw new Error('no review job in the fixtures');
    return job;
  };

  it('leads with Review… and a separator, then the disabled note item and Rename…, and nothing after them', () => {
    const entries = rowMenuEntries(reviewJob(), idle);

    expect(entries.map((entry) => [entry.type, entry.id])).toEqual([
      ['item', 'review'],
      ['separator', 'review-separator'],
      ['item', 'note'],
      ['item', 'rename'],
    ]);
    const [review, , note, rename] = entries;
    expect(review?.type === 'item' && review.label).toBe('Review…');
    expect(review?.type === 'item' && review.icon).toBe(ROW_ACTION_ICONS.review);
    expect(review?.type === 'item' && review.disabled).toBeFalsy();
    expect(note?.type === 'item' && note.disabled).toBe(true);
    // A video in review can be renamed.
    expect(rename?.type === 'item' && rename.disabled).toBe(false);
  });

  it('opens the review dialog for the job when Review… is chosen, and sends nothing', () => {
    const [review] = rowMenuEntries(reviewJob(), idle);
    if (review?.type !== 'item') throw new Error('the first entry is the Review… item');
    review.onSelect();
    expect(reviewDialogStore.getState().jobId).toBe(reviewJob().id);
    expect(run).not.toHaveBeenCalled();
  });

  it('is not held back by a request in flight on the row: it sends none', () => {
    const [review] = rowMenuEntries(reviewJob(), { run, busy: true });
    expect(review?.type === 'item' && review.disabled).toBeFalsy();
  });

  it('is the only menu with Review…', () => {
    for (const job of CANVAS_JOBS) {
      expect(rowMenuEntries(job, idle).map((entry) => entry.id)).not.toContain('review');
    }
  });
});

describe('rowMenuEntries: Approve, in the right-click menu only (the owner, 31 Oct)', () => {
  const reviewJob = () => {
    const job = REVIEW_ROW_JOBS.find((candidate) => candidate.state === 'review');
    if (!job) throw new Error('no review job in the fixtures');
    return job;
  };
  /** The menu as the right-click menu and the phone's sheet ask for it: with Approve. */
  const withApprove = (job = reviewJob(), actions = idle) =>
    rowMenuEntries(job, actions, null, undefined, undefined, true, false, false, true);

  it('comes right after Review…, with a check, for a job in Review', () => {
    const entries = withApprove();
    expect(entries.map((entry) => entry.id).slice(0, 3)).toEqual([
      'review',
      'approve',
      'review-separator',
    ]);
    const approve = entries[1];
    expect(approve?.type === 'item' && approve.label).toBe('Approve');
    expect(approve?.type === 'item' && approve.icon).toBe(Check);
    expect(approve?.type === 'item' && approve.disabled).toBe(false);
  });

  it('sends Approve through the row’s actions when chosen', () => {
    const approve = withApprove().find((entry) => entry.id === 'approve');
    if (approve?.type !== 'item') throw new Error('no Approve item');
    approve.onSelect();
    expect(run).toHaveBeenCalledWith({ kind: 'approve', label: 'Approve' });
  });

  it('waits for a request in flight on the row, like the other server actions', () => {
    const approve = withApprove(reviewJob(), { run, busy: true }).find(
      (entry) => entry.id === 'approve',
    );
    expect(approve?.type === 'item' && approve.disabled).toBe(true);
  });

  it('is left out where it is not asked for: the job sheet’s ⋯ menu', () => {
    expect(rowMenuEntries(reviewJob(), idle).map((entry) => entry.id)).not.toContain('approve');
  });

  it('is in no other state’s menu', () => {
    for (const job of CANVAS_JOBS) {
      if (job.state === 'review') continue;
      expect(
        withApprove(job).map((entry) => entry.id),
        job.state,
      ).not.toContain('approve');
    }
  });
});

describe('lookMenuEntries: Use this look', () => {
  const lookItem = (
    job: Parameters<typeof lookMenuEntries>[0],
    currentLookJobId: string | null = null,
  ) => {
    const [item, ...rest] = lookMenuEntries(job, currentLookJobId);
    if (item?.type !== 'item') throw new Error('the entry is an item');
    expect(rest).toEqual([]);
    return item;
  };

  it('is on approved rows only, in every state', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({
        state,
        failedAt: 8,
        error: 'boom',
        preview: { durationSec: 28.4, width: 1080, height: 1920 },
      });
      expect(lookMenuEntries(job, null).length, state).toBe(state === 'ready' ? 1 : 0);
      expect(
        rowMenuEntries(job, idle).some((entry) => entry.id === 'use-look'),
        state,
      ).toBe(state === 'ready');
    }
  });

  it('is not on a delivered or paid row: the way back from its stage takes its place', () => {
    for (const delivery of [makeJobDelivery(), makeJobDelivery({ paidOn: '2026-10-23' })]) {
      const job = makeJob({ state: 'ready', delivery });
      expect(lookMenuEntries(job, null)).toEqual([]);
      expect(rowMenuEntries(job, idle).map((entry) => entry.id)).not.toContain('use-look');
    }
  });

  it('comes after Download MP4 and a line, as the last item of an approved row’s menu', () => {
    expect(rowMenuEntries(canvasJob('j6'), idle).map((entry) => entry.id)).toEqual([
      'note',
      'rename',
      'note-separator',
      'deliver',
      'download',
      'stage-separator',
      'use-look',
    ]);
  });

  it('is "Use this look for <client>…" with a palette, the client’s name in its own direction', () => {
    const item = lookItem(makeJob({ state: 'ready', client: 'מרפאת מירה' }));
    expect(item.label).toBe('Use this look for מרפאת מירה…');
    expect(item.bidi).toBe('מרפאת מירה');
    expect(item.icon).toBe(Palette);
    expect(item.disabled).toBeFalsy();
    expect(item.destructive).toBeFalsy();
    expect(item.href).toBeUndefined();
    expect(item.label).toContain(item.bidi);
  });

  it('stays enabled while the client’s style is not known, or its look comes from another job or from files', () => {
    const job = makeJob({ id: 'j6', state: 'ready' });
    expect(lookItem(job, null).disabled).toBeFalsy();
    expect(lookItem(job, 'another-job').disabled).toBeFalsy();
    expect(lookItem(job, 'another-job').label).toBe('Use this look for Northwind Bakery…');
  });

  it('is disabled, with a check, once the client’s look already comes from this job', () => {
    const item = lookItem(makeJob({ id: 'j6', state: 'ready', client: 'Arc Fitness' }), 'j6');
    expect(item.label).toBe('Arc Fitness’s look comes from this job');
    expect(item.bidi).toBe('Arc Fitness');
    expect(item.icon).toBe(Check);
    expect(item.disabled).toBe(true);
  });

  it('keeps the same key in both states, so the menu does not rebuild the item when the style arrives', () => {
    const job = makeJob({ id: 'j6', state: 'ready' });
    expect(lookItem(job, null).id).toBe(lookItem(job, 'j6').id);
  });

  it('passes the style on from rowMenuEntries: the disabled item replaces the enabled one', () => {
    const job = canvasJob('j6');
    const entries = (current: string | null) =>
      rowMenuEntries(job, idle, current).flatMap((entry) =>
        entry.type === 'item' && entry.id === 'use-look' ? [entry] : [],
      );
    expect(entries(null).map((entry) => entry.disabled)).toEqual([undefined]);
    expect(entries('j6').map((entry) => entry.disabled)).toEqual([true]);
  });

  it('asks the page for the dialog, with the job, and sends nothing to the server', () => {
    const job = makeJob({ id: 'j6', state: 'ready', name: 'Studio tour', client: 'Arc Fitness' });
    lookItem(job).onSelect();
    expect(lookDialogStore.getState()).toMatchObject({
      phase: 'asking',
      target: { jobId: 'j6', jobName: 'Studio tour', client: 'Arc Fitness' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('asks for nothing when it is the current look (the item is disabled, and chosen by no one)', () => {
    lookItem(makeJob({ id: 'j6', state: 'ready' }), 'j6').onSelect();
    expect(lookDialogStore.getState().phase).toBe('closed');
  });
});

describe('rowMenuEntries: the stages of a ready job (DPMenus)', () => {
  const stageJob = (id: string) => {
    const job = DELIVERY_ROW_JOBS.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`no job ${id}`);
    return job;
  };
  const approved = stageJob('d3');
  const delivered = stageJob('d6');
  const paid = stageJob('d9');

  const shape = (job: typeof approved) =>
    rowMenuEntries(job, idle).map((entry) =>
      entry.type === 'separator' ? '---' : `${entry.label}`,
    );

  it('Approved: the note, Mark delivered, Download MP4, a line, Use this look for <client>…', () => {
    expect(shape(approved)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Mark delivered',
      'Download MP4',
      '---',
      'Use this look for RGM…',
    ]);
  });

  it('Delivered: the note, Mark paid…, Download MP4, a line, Not delivered yet', () => {
    expect(shape(delivered)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Mark paid…',
      'Download MP4',
      '---',
      'Not delivered yet',
    ]);
  });

  it('Paid: the note, Download MP4, a line, Not paid yet', () => {
    expect(shape(paid)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Download MP4',
      '---',
      'Not paid yet',
    ]);
  });

  // Uploaded: delivered, unpaid, and a reel is linked to it.
  const REEL_URL = 'https://www.instagram.com/reel/C-rooftop/';
  const uploaded = {
    ...delivered,
    delivery: { ...delivered.delivery, uploadedAt: '2026-10-20T09:30:00.000Z', reelUrl: REEL_URL },
  } as typeof delivered;

  it('Uploaded: the note, Mark paid…, Open reel, Download MP4, and no way back: Not delivered yet is not offered', () => {
    expect(shape(uploaded)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Mark paid…',
      'Open reel',
      'Download MP4',
    ]);
  });

  it('Paid with a reel linked: Open reel, Download MP4, a line, Not paid yet', () => {
    const linked = {
      ...paid,
      delivery: { ...paid.delivery, uploadedAt: '2026-10-20T09:30:00.000Z', reelUrl: REEL_URL },
    } as typeof paid;
    expect(shape(linked)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Open reel',
      'Download MP4',
      '---',
      'Not paid yet',
    ]);
  });

  it('Open reel opens the reel in a new tab, with no way back to this page for it, and sends nothing', () => {
    // These tests run without a browser: the menu only needs `window.open`.
    const open = vi.fn<(url: string, target: string, features: string) => null>(() => null);
    vi.stubGlobal('window', { open });
    try {
      const entry = rowMenuEntries(uploaded, idle).find((candidate) => candidate.id === 'reel');
      if (entry?.type !== 'item') throw new Error('no Open reel item');
      expect(entry.icon).toBe(ROW_ACTION_ICONS.reel);
      expect(entry.href).toBeUndefined();
      entry.onSelect();
      expect(open).toHaveBeenCalledExactlyOnceWith(REEL_URL, '_blank', 'noopener,noreferrer');
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps Open reel for an editor, who has no money entries', () => {
    const ids = rowMenuEntries(uploaded, idle, null, undefined, undefined, false).map(
      (entry) => entry.id,
    );
    expect(ids).toContain('reel');
    expect(ids).not.toContain('pay');
    expect(ids).not.toContain('undeliver');
  });

  it('never holds Open reel back while a request of the row is in flight: it is a link, not a request', () => {
    const entry = rowMenuEntries(uploaded, { run, busy: true }).find(
      (candidate) => candidate.id === 'reel',
    );
    expect(entry?.type === 'item' && Boolean(entry.disabled)).toBe(false);
  });

  it('keeps the note item first and disabled at every stage, as it is for a ready job today', () => {
    for (const job of [approved, delivered, paid]) {
      const [note] = rowMenuEntries(job, idle);
      expect(note?.type === 'item' && [note.id, note.disabled]).toEqual(['note', true]);
    }
  });

  it('draws the icons of the board: Send, Banknote, and an Undo arrow for the way back', () => {
    const icon = (job: typeof approved, id: string) => {
      const entry = rowMenuEntries(job, idle).find((candidate) => candidate.id === id);
      return entry?.type === 'item' ? entry.icon : undefined;
    };
    expect(icon(approved, 'deliver')).toBe(ROW_ACTION_ICONS.deliver);
    expect(icon(delivered, 'pay')).toBe(ROW_ACTION_ICONS.pay);
    expect(icon(delivered, 'undeliver')).toBe(ROW_ACTION_ICONS.undeliver);
    expect(icon(paid, 'unpay')).toBe(ROW_ACTION_ICONS.unpay);
    expect(ROW_ACTION_ICONS.undeliver).toBe(ROW_ACTION_ICONS.unpay);
  });

  const select = (job: typeof approved, id: string) => {
    const entry = rowMenuEntries(job, idle).find((candidate) => candidate.id === id);
    if (entry?.type !== 'item') throw new Error(`no ${id} item`);
    entry.onSelect();
  };

  it('sends Mark delivered, Not delivered yet and Not paid yet through the row', () => {
    select(approved, 'deliver');
    select(delivered, 'undeliver');
    select(paid, 'unpay');
    expect(run.mock.calls.map(([action]) => action)).toEqual([
      { kind: 'deliver', label: 'Mark delivered' },
      { kind: 'undeliver', label: 'Not delivered yet' },
      { kind: 'unpay', label: 'Not paid yet' },
    ]);
  });

  it('asks the page for the Mark paid dialog, with the job, and sends nothing', () => {
    select(delivered, 'pay');
    expect(markPaidRequestStore.getState().request).toEqual({
      jobId: 'd6',
      clientId: delivered.clientId,
      client: 'RGM',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('waits for the answer while a request of the row is in flight, except the file and the dialog', () => {
    const busy = { run, busy: true };
    const disabled = (job: typeof approved) =>
      rowMenuEntries(job, busy).flatMap((entry) =>
        entry.type === 'item' && entry.id !== 'note' && entry.id !== 'rename'
          ? [[entry.id, Boolean(entry.disabled)]]
          : [],
      );
    expect(disabled(approved)).toEqual([
      ['deliver', true],
      ['download', false],
      ['use-look', false],
    ]);
    // Mark paid… only asks for a dialog, so it is never held back.
    expect(disabled(delivered)).toEqual([
      ['pay', false],
      ['download', false],
      ['undeliver', true],
    ]);
    expect(disabled(paid)).toEqual([
      ['download', false],
      ['unpay', true],
    ]);
  });

  it('keeps the Effort submenu after the note, off, and the stage entries after the line, for a ready job', () => {
    const setEffort = vi.fn();
    const ids = (job: typeof approved) =>
      rowMenuEntries(job, { run, busy: false, setEffort }).map((entry) => entry.id);
    expect(ids(approved)).toEqual([
      'note',
      'rename',
      'effort',
      'note-separator',
      'deliver',
      'download',
      'stage-separator',
      'use-look',
    ]);
    expect(ids(delivered)).toEqual([
      'note',
      'rename',
      'effort',
      'note-separator',
      'pay',
      'download',
      'stage-separator',
      'undeliver',
    ]);
    expect(ids(paid)).toEqual([
      'note',
      'rename',
      'effort',
      'note-separator',
      'download',
      'stage-separator',
      'unpay',
    ]);
    // A finished job's effort can no longer change.
    for (const job of [approved, delivered, paid]) {
      const effort = rowMenuEntries(job, { run, busy: false, setEffort }).find(
        (entry) => entry.id === 'effort',
      );
      expect(effort).toMatchObject({ type: 'submenu', disabled: true });
    }
  });

  it('draws none of the four stage items in the red (destructive) style', () => {
    for (const job of [approved, delivered, paid]) {
      for (const entry of rowMenuEntries(job, idle)) {
        if (entry.type === 'item') expect(Boolean(entry.destructive), entry.label).toBe(false);
      }
    }
  });
});

describe('rowMenuEntries: Unapprove, the way back from Approved', () => {
  const approvedInReview = makeJob({
    id: 'a9',
    state: 'ready',
    step: 8,
    placeInLine: null,
    runKind: 'render',
    round: 1,
    approvedAt: '2026-10-21T09:30:00.000Z',
    preview: { durationSec: 28.4, width: 1080, height: 1920 },
  });

  const unapprove = (job: typeof approvedInReview, actions = idle, admin = true) =>
    rowMenuEntries(job, actions, null, undefined, undefined, admin).find(
      (entry) => entry.id === 'unapprove',
    );

  it('ends the menu of an approved video, after "Use this look" and a line', () => {
    expect(rowMenuEntries(approvedInReview, idle).map((entry) => entry.id)).toEqual([
      'view-preview',
      'review-separator',
      'note',
      'rename',
      'note-separator',
      'deliver',
      'download',
      'stage-separator',
      'use-look',
      'unapprove',
    ]);
  });

  it('says Unapprove, with the Undo arrow, and is not red', () => {
    expect(unapprove(approvedInReview)).toMatchObject({
      type: 'item',
      label: 'Unapprove',
      icon: ROW_ACTION_ICONS.unapprove,
    });
    expect(
      unapprove(approvedInReview)?.type === 'item' && unapprove(approvedInReview),
    ).not.toMatchObject({
      destructive: true,
    });
  });

  it('goes through the row, like the other stage changes', () => {
    const entry = unapprove(approvedInReview);
    if (entry?.type !== 'item') throw new Error('no Unapprove item');
    entry.onSelect();
    expect(run).toHaveBeenCalledWith({ kind: 'unapprove', label: 'Unapprove' });
  });

  it('waits for the answer while a request of the row is in flight', () => {
    expect(unapprove(approvedInReview, { run, busy: true })).toMatchObject({ disabled: true });
  });

  it('stays below "the client’s look comes from this job", which is disabled', () => {
    const ids = rowMenuEntries(approvedInReview, idle, approvedInReview.id).map(
      (entry) => entry.id,
    );
    expect(ids.slice(-2)).toEqual(['use-look', 'unapprove']);
  });

  it('is there for an editor too: it is not money (Mark delivered is)', () => {
    const ids = rowMenuEntries(approvedInReview, idle, null, undefined, undefined, false).map(
      (entry) => entry.id,
    );
    expect(ids).not.toContain('deliver');
    expect(ids).toContain('unapprove');
  });

  it('is not on a ready video that was never approved, a delivered one, or any other state', () => {
    const delivered = { ...approvedInReview, delivery: makeJobDelivery() };
    const neverApproved = { ...approvedInReview, approvedAt: null, preview: null };
    for (const job of [delivered, neverApproved]) {
      expect(unapprove(job)).toBeUndefined();
    }
    for (const state of JOB_STATES.filter((state) => state !== 'ready')) {
      const job = makeJob({ ...approvedInReview, state, failedAt: 8, error: 'boom' });
      expect(unapprove(job), state).toBeUndefined();
    }
  });
});

describe('renameMenuEntry: Rename…', () => {
  it('is a pencil item named Rename…, right after the note', () => {
    const entry = renameMenuEntry(makeJob({ state: 'failed' }));

    expect(entry).toMatchObject({ type: 'item', id: 'rename', label: 'Rename…', icon: Pencil });
    expect(
      rowMenuEntries(makeJob({ state: 'failed' }), idle).map((candidate) => candidate.id),
    ).toEqual(expect.arrayContaining(['note', 'rename']));
  });

  it.each(['held', 'failed', 'cancelled', 'review', 'ready'] as const)(
    'is enabled for a %s job',
    (state) => {
      const entry = renameMenuEntry(makeJob({ state }));

      expect(entry.disabled).toBe(false);
      expect(entry.disabledReason).toBeUndefined();
    },
  );

  it.each(['arriving', 'queued', 'editing'] as const)(
    'is disabled for a %s job, with the reason as its tooltip',
    (state) => {
      const entry = renameMenuEntry(makeJob({ state }));

      expect(entry.disabled).toBe(true);
      expect(entry.disabledReason).toEqual(expect.stringContaining('Wait until'));
    },
  );

  it('asks the page for the rename dialog, with the job’s current name in the box', () => {
    const job = makeJob({ id: 'j9', client: 'Kova Coffee', name: 'Spring menu', state: 'held' });

    renameMenuEntry(job).onSelect();

    const dialog = renameDialogStore.getState();
    expect(dialog.job).toMatchObject({ id: 'j9', client: 'Kova Coffee', name: 'Spring menu' });
    expect(dialog.name).toBe('Spring menu');
    expect(run).not.toHaveBeenCalled();
  });
});
