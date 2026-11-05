import { groupOf, type Job, jobStage, orphanAsJob } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeJob, makeJobDelivery, makeOrphanDelivery } from '@/data/test-utils';
import { STATUS_TABS } from '@/stores/jobs-ui';
import { nextStepAction, stageUndoAction } from './cells/row-actions';
import type { RunnableRowAction } from './cells/use-row-actions';
import { deliveryDetail, FOLDER_DELETED_TEXT } from './delivery-text';
import { filterJobs, matchesTab, tabCounts } from './filtering';
import { MENU_WIDTH, menuWidth, READY_MENU_WIDTH } from './JobRow';
import { owedJobs, payRows, totalLabel } from './mark-paid/pay-list';
import { rowMenuEntries } from './row-menu';
import { lastUpdatedOrder } from './sorting';

// A delivered video whose folder was deleted (CVP-204) is a ready, delivered job marked
// `folderDeleted`. These are the rules of the Jobs page for it, as plain functions.

const GONE = orphanAsJob(makeOrphanDelivery());
const GONE_PAID = orphanAsJob(
  makeOrphanDelivery({
    id: 'paid1',
    name: 'Paid',
    delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
  }),
);
const DELIVERED = makeJob({
  id: 'delivered1',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery(),
});
const APPROVED = makeJob({ id: 'approved1', state: 'ready', placeInLine: null });
const QUEUED = makeJob({ id: 'queued1' });

describe('where a folder-deleted video stands', () => {
  it('is Delivered while unpaid, like any delivered video', () => {
    expect(jobStage(GONE)).toBe('delivered');
    expect(groupOf(GONE)).toBe('delivered');
    expect(matchesTab(GONE, 'delivered')).toBe(true);
    expect(matchesTab(GONE, 'all')).toBe(true);
    expect(matchesTab(GONE, 'approved')).toBe(false);
    expect(matchesTab(GONE, 'paid')).toBe(false);
  });

  it('counts in All and Delivered on the tabs', () => {
    const counts = tabCounts([QUEUED, APPROVED, DELIVERED, GONE], false);

    expect(counts).toMatchObject({ all: 4, progress: 1, approved: 1, delivered: 2, paid: 0 });
    expect(Object.keys(counts)).toEqual([...STATUS_TABS]);
  });

  it('is found by the search on its name and its client', () => {
    const search = (text: string) =>
      filterJobs([QUEUED, DELIVERED, GONE], { tab: 'all', search: text, showArchived: false }).map(
        (job) => job.id,
      );

    expect(search('history')).toEqual([GONE.id]);
    expect(search('northwind history')).toEqual([GONE.id]);
  });

  it('shows under the Delivered tab with the delivered videos that have a folder', () => {
    const shown = filterJobs([QUEUED, APPROVED, DELIVERED, GONE], {
      tab: 'delivered',
      search: '',
      showArchived: false,
    });

    expect(shown.map((job) => job.id)).toEqual([DELIVERED.id, GONE.id]);
  });

  it('is sorted by the day it was delivered', () => {
    const newest = makeJob({
      id: 'newest',
      updatedAt: '2026-10-22T09:00:00.000Z',
      addedAt: '2026-10-22T09:00:00.000Z',
    });
    const oldest = makeJob({
      id: 'oldest',
      updatedAt: '2026-10-01T09:00:00.000Z',
      addedAt: '2026-10-01T09:00:00.000Z',
    });

    // GONE was delivered on 21 October.
    expect(lastUpdatedOrder([oldest, GONE, newest]).map((job) => job.id)).toEqual([
      'newest',
      GONE.id,
      'oldest',
    ]);
  });
});

describe('deliveryDetail: "Folder deleted · Delivered 21 Oct · ₪40 not paid"', () => {
  it('says the folder is deleted first, then what any delivered video says', () => {
    expect(deliveryDetail(GONE, 'UTC')).toBe('Folder deleted · Delivered 21 Oct · ₪40 not paid');
    expect(FOLDER_DELETED_TEXT).toBe('Folder deleted');
  });

  it('keeps the price and the day of the delivery row', () => {
    const dear = orphanAsJob(
      makeOrphanDelivery({
        delivery: makeJobDelivery({ price: 200, deliveredAt: '2026-10-16T09:00:00.000Z' }),
      }),
    );
    expect(deliveryDetail(dear, 'UTC')).toBe('Folder deleted · Delivered 16 Oct · ₪200 not paid');
  });

  it('is the ordinary line for a delivered video that has its folder', () => {
    expect(deliveryDetail(DELIVERED, 'UTC')).toBe('Delivered 21 Oct · ₪40 not paid');
  });
});

describe('the next step of a folder-deleted row', () => {
  it('is Mark paid…, as for any delivered video', () => {
    expect(nextStepAction(GONE)).toEqual({ kind: 'pay', label: 'Mark paid…' });
  });

  it('has Not delivered yet as the way back', () => {
    expect(stageUndoAction(GONE)).toEqual({ kind: 'undeliver', label: 'Not delivered yet' });
  });
});

describe('the right-click menu of a folder-deleted row: Mark paid… and Not delivered yet only', () => {
  const run = vi.fn<(action: RunnableRowAction) => void>();
  const entries = (job: Job, busy = false) =>
    rowMenuEntries(job, { run, busy, archive: vi.fn(), unarchive: vi.fn(), setEffort: vi.fn() });

  it('holds exactly those two items, with a line between them', () => {
    const menu = entries(GONE);

    expect(menu.map((entry) => (entry.type === 'item' ? entry.label : '—'))).toEqual([
      'Mark paid…',
      '—',
      'Not delivered yet',
    ]);
  });

  it('has no note, effort, download, look, series or archive', () => {
    const labels = entries(GONE).flatMap((entry) => (entry.type === 'item' ? [entry.label] : []));

    expect(labels.join('|')).not.toMatch(/note|Download|look|Archive|series/i);
    expect(entries(GONE).some((entry) => entry.type === 'submenu')).toBe(false);
  });

  it('is not the menu of a delivered video that has its folder', () => {
    const labels = entries(DELIVERED).flatMap((entry) =>
      entry.type === 'item' ? [entry.label] : [],
    );

    expect(labels).toEqual(
      expect.arrayContaining(['Add note…', 'Mark paid…', 'Download MP4', 'Archive']),
    );
  });

  it('sends Not delivered yet through the row’s actions, and waits for a request in flight', () => {
    run.mockClear();
    const item = entries(GONE).find((entry) => entry.id === 'undeliver');
    if (item?.type !== 'item') throw new Error('no Not delivered yet item');
    expect(item.disabled).toBe(false);

    item.onSelect();

    expect(run).toHaveBeenCalledWith({ kind: 'undeliver', label: 'Not delivered yet' });
    const busy = entries(GONE, true).find((entry) => entry.id === 'undeliver');
    expect(busy?.type === 'item' && busy.disabled).toBe(true);
  });

  it('is a narrow menu: it has no long item like Use this look', () => {
    expect(menuWidth(GONE)).toBe(MENU_WIDTH);
    expect(menuWidth(APPROVED)).toBe(READY_MENU_WIDTH);
    expect(menuWidth(DELIVERED)).toBe(READY_MENU_WIDTH);
  });
});

describe('the Mark paid dialog’s list', () => {
  const CLIENT = GONE.clientId;

  it('lists a folder-deleted video with the client’s other unpaid ones, newest delivery first', () => {
    const newer = makeJob({
      id: 'newer',
      name: 'Newer',
      clientId: CLIENT,
      state: 'ready',
      placeInLine: null,
      delivery: makeJobDelivery({ deliveredAt: '2026-10-22T09:00:00.000Z' }),
    });
    const older = makeJob({
      id: 'older',
      name: 'Older',
      clientId: CLIENT,
      state: 'ready',
      placeInLine: null,
      delivery: makeJobDelivery({ deliveredAt: '2026-10-10T09:00:00.000Z' }),
    });

    const owed = owedJobs([older, GONE, newer], CLIENT);

    expect(owed.map((job) => job.id)).toEqual(['newer', GONE.id, 'older']);
  });

  it('does not list one of another client, or a paid one', () => {
    const other = orphanAsJob(makeOrphanDelivery({ id: 'other', clientId: 'someone-else' }));

    expect(owedJobs([GONE, GONE_PAID, other], GONE.clientId).map((job) => job.id)).toEqual([
      GONE.id,
    ]);
  });

  it('has a row for it that says its folder is deleted, with its own name, day and price', () => {
    const owed = owedJobs([GONE], GONE.clientId);

    expect(payRows(owed, new Set([GONE.id]), 'UTC')).toEqual([
      {
        id: GONE.id,
        name: 'History check',
        delivered: '21 Oct',
        price: '₪40',
        sign: '₪',
        amount: '40',
        amountValid: true,
        checked: true,
        folderDeleted: true,
      },
    ]);
  });

  it('marks only the folder-deleted rows', () => {
    const here = makeJob({
      id: 'here',
      clientId: GONE.clientId,
      state: 'ready',
      placeInLine: null,
      delivery: makeJobDelivery(),
    });

    const rows = payRows(owedJobs([here, GONE], GONE.clientId), new Set(), 'UTC');

    expect(rows.map((row) => [row.id, row.folderDeleted])).toEqual([
      ['here', false],
      [GONE.id, true],
    ]);
  });

  it('adds its price into the total like any other', () => {
    const owed = owedJobs([GONE], GONE.clientId);
    expect(totalLabel(owed)).toBe('1 video · ₪40');
  });
});
