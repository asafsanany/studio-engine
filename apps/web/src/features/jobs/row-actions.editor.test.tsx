import { orphanAsJob } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { createEditorQueryClient, makeJob, makeOrphanDelivery } from '@/data/test-utils';
import { sheetButtons } from '@/features/job-sheet/sheet-now';
import { phoneNextStep } from '@/features/phone/phone-sheet';
import { ActionCell } from './cells/ActionCell';
import { menuActions, nextStepAction } from './cells/row-actions';
import { renderCell, textOf } from './cells/test-helpers';
import type { RunnableRowAction } from './cells/use-row-actions';
import { archiveMenuEntries, type JobMenuEntry, NO_ARCHIVE_MENU, rowMenuEntries } from './row-menu';
import { DELIVERY_ROW_JOBS } from './test-jobs';

// Team plan, TM4: Mark delivered / Mark paid (and their ways back), Archive all paid, Delete and
// Show in Finder are the admin's. The server refuses them to an editor; the web does not offer them.

const job = (id: string) => {
  const found = DELIVERY_ROW_JOBS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};
const approved = job('d3');
const delivered = job('d6');
const paid = job('d9');

const idle = { run: vi.fn<(action: RunnableRowAction) => void>(), busy: false };
const labels = (entries: readonly JobMenuEntry[]) =>
  entries.map((entry) => (entry.type === 'separator' ? '---' : entry.label));
const menu = (j: typeof approved, admin: boolean) =>
  labels(rowMenuEntries(j, idle, null, undefined, NO_ARCHIVE_MENU, admin));

describe('nextStepAction and menuActions for an editor', () => {
  it('give the admin Mark delivered and Mark paid…, and an editor neither', () => {
    expect(nextStepAction(approved)?.label).toBe('Mark delivered');
    expect(nextStepAction(delivered)?.label).toBe('Mark paid…');
    expect(nextStepAction(approved, false)).toBeNull();
    expect(nextStepAction(delivered, false)).toBeNull();
    expect(nextStepAction(paid, false)).toBeNull();
    expect(menuActions(approved, false).map((a) => a.label)).toEqual(['Download MP4']);
    expect(menuActions(delivered, false).map((a) => a.label)).toEqual(['Download MP4']);
  });

  it('leave every other state’s step to the editor', () => {
    const held = makeJob({ state: 'held', placeInLine: null });
    expect(nextStepAction(held, false)?.label).toBe('Release');
    expect(menuActions(held, false).map((a) => a.label)).toEqual(['Release']);
  });
});

describe('the row menu for an editor', () => {
  it('has no Mark delivered, Mark paid…, Not delivered yet or Not paid yet', () => {
    expect(menu(approved, true)).toContain('Mark delivered');
    expect(menu(delivered, true)).toEqual(
      expect.arrayContaining(['Mark paid…', 'Not delivered yet']),
    );
    expect(menu(paid, true)).toContain('Not paid yet');

    expect(menu(approved, false)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Download MP4',
      '---',
      'Use this look for RGM…',
    ]);
    expect(menu(delivered, false)).toEqual(['Add note…', 'Rename…', '---', 'Download MP4']);
    expect(menu(paid, false)).toEqual(['Add note…', 'Rename…', '---', 'Download MP4']);
  });

  it('has no line left dangling, and Archive stays', () => {
    const archived = rowMenuEntries(
      paid,
      { ...idle, archive: () => {}, unarchive: () => {}, archiveAllPaid: () => {} },
      null,
      undefined,
      { paidIds: ['a', 'b'] },
      false,
    );
    expect(labels(archived)).toEqual([
      'Add note…',
      'Rename…',
      '---',
      'Download MP4',
      '---',
      'Archive',
    ]);
  });

  it('drops Archive all paid · N for an editor, and keeps it for the admin', () => {
    const actions = { ...idle, archive: () => {}, archiveAllPaid: () => {} };
    const context = { paidIds: ['a', 'b', 'c'] };
    const forAdmin = archiveMenuEntries(paid, actions, context);
    expect(labels(forAdmin)).toContain('Archive all paid · 3');
    const forEditor = rowMenuEntries(paid, actions, null, undefined, context, false);
    expect(labels(forEditor).join('|')).not.toContain('Archive all paid');
    expect(labels(forEditor)).toContain('Archive');
  });

  it('has no menu at all for a delivered video whose folder was deleted', () => {
    const gone = orphanAsJob(makeOrphanDelivery());
    expect(labels(rowMenuEntries(gone, idle))).toEqual(['Mark paid…', '---', 'Not delivered yet']);
    expect(rowMenuEntries(gone, idle, null, undefined, NO_ARCHIVE_MENU, false)).toEqual([]);
  });
});

describe('the Action cell, the job sheet and the phone for an editor', () => {
  it('draws Mark delivered and Mark paid… for the admin and nothing for an editor', () => {
    const editor = createEditorQueryClient();
    expect(textOf(renderCell(<ActionCell job={approved} />))).toBe('');
    expect(renderCell(<ActionCell job={approved} />)).toContain('aria-label="Mark delivered"');
    expect(renderCell(<ActionCell job={delivered} />)).toContain('aria-label="Mark paid…"');
    for (const j of [approved, delivered, paid]) {
      const markup = renderCell(<ActionCell job={j} />, editor);
      expect(markup).not.toContain('Mark delivered');
      expect(markup).not.toContain('Mark paid');
      expect(markup).not.toContain('<button');
    }
  });

  it('gives an editor’s sheet no primary button on an approved or delivered job', () => {
    expect(sheetButtons(approved).primary?.label).toBe('Mark delivered');
    expect(sheetButtons(approved, false).primary).toBeNull();
    expect(sheetButtons(delivered, false).primary).toBeNull();
    // The MP4 download stays.
    expect(sheetButtons(approved, false).download).not.toBeNull();
  });

  it('keeps Share video on the phone for an approved job, and drops Mark paid… for an editor', () => {
    expect(phoneNextStep(approved, false)?.label).toBe('Share video');
    expect(phoneNextStep(delivered)?.label).toBe('Mark paid…');
    expect(phoneNextStep(delivered, false)).toBeNull();
  });
});
