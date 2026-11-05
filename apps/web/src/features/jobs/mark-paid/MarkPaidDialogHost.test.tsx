import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, makeJob, makeJobDelivery } from '@/data/test-utils';
import { textOf } from '../cells/test-helpers';

// Same stand-in for the Radix dialog as in MarkPaidDialog.test.tsx: a portal does not render on a
// server.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { MarkPaidDialogHost } = await import('./MarkPaidDialogHost');
const { createMarkPaidRequestStore } = await import('./request');
const { todayLocal } = await import('./pay-list');

const TAVO = { clientId: 'client-tavo', client: 'עו״ד דוד לוי' };

/** A ready job of Levi's (or `overrides`), delivered at 09:00 UTC on `day` and not paid. */
function delivered(id: string, day: string, overrides: Partial<Job> = {}): Job {
  return makeJob({
    id,
    name: `מיתוס או אמת ${id}`,
    ...TAVO,
    state: 'ready',
    placeInLine: null,
    delivery: makeJobDelivery({ deliveredAt: `${day}T09:00:00.000Z` }),
    ...overrides,
  });
}

const J5 = delivered('5', '2026-10-21');
const J4 = delivered('4', '2026-10-16');
const J3 = delivered('3', '2026-10-12');
// Not owed: paid, approved, another client's, and a job from another run that left ready.
const PAID = delivered('2', '2026-10-05', {
  delivery: makeJobDelivery({ deliveredAt: '2026-10-05T09:00:00.000Z', paidOn: '2026-10-12' }),
});
const APPROVED = delivered('6', '2026-10-21', { delivery: null });
const RGM = delivered('rgm', '2026-10-20', { clientId: 'client-rgm', client: 'RGM' });
const RETRIED = delivered('retried', '2026-10-20', { state: 'editing' });
const JOBS = [PAID, J3, RGM, J5, APPROVED, RETRIED, J4];

/**
 * A server render reads a store's initial state, so each test builds its store already holding the
 * request it wants to see (the row that was clicked: `jobId`).
 */
function host(jobId: string | null, jobs: readonly Job[] | null = JOBS) {
  const store = createMarkPaidRequestStore(jobId === null ? null : { jobId, ...TAVO });
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <MarkPaidDialogHost jobs={jobs ?? undefined} store={store} />
    </QueryClientProvider>,
  );
}

const checks = (markup: string) =>
  [...markup.matchAll(/role="checkbox"[^>]*aria-checked="(true|false)"/g)].map(
    (match) => match[1] === 'true',
  );
const footer = (markup: string) => textOf(markup.slice(markup.indexOf('<footer')));

describe('<MarkPaidDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host(null)).toBe('');
  });

  it('shows the dialog for the client of the row that asked, with the title and the question', () => {
    const markup = host('4');
    expect(markup).toContain('<h2>Mark paid · <bdi>עו״ד דוד לוי</bdi></h2>');
    expect(markup).toContain('Which videos does this payment cover, and what was paid for each?');
  });

  it('lists only that client’s delivered, unpaid videos, newest delivery first', () => {
    const text = textOf(host('4'));
    expect(text).toContain('Not paid yet · 3');
    const names = ['אמת 5', 'אמת 4', 'אמת 3'].map((name) => text.indexOf(name));
    expect(names.every((at) => at > -1)).toBe(true);
    expect(names).toEqual([...names].sort((a, b) => a - b));
    // Not paid, not delivered, not Levi's, or not ready.
    for (const left of ['אמת 2', 'אמת 6', 'rgm', 'retried']) expect(text).not.toContain(left);
    expect(text).toContain('Delivered 21 Oct');
    expect(text).toContain('Delivered 16 Oct');
    expect(text).toContain('Delivered 12 Oct');
  });

  it('starts with the row it was asked from ticked, and nothing else', () => {
    const middle = host('4');
    expect(checks(middle)).toEqual([false, true, false]);
    expect(footer(middle)).toBe('1 video · ₪40 Cancel Mark paid');
    expect(checks(host('5'))).toEqual([true, false, false]);
    expect(checks(host('3'))).toEqual([false, false, true]);
  });

  it('starts the day at today, on the browser’s clock', () => {
    const today = todayLocal();
    const markup = host('4');
    expect(markup).toContain(`value="${today}"`);
    expect(markup).toContain(`max="${today}"`);
  });

  it('opens anyway, with nothing ticked, when the row it was asked from is no longer delivered', () => {
    // The video was paid (or put back to Approved) between the click and the dialog: the rest is still owed.
    const markup = host('2');
    expect(textOf(markup)).toContain('Not paid yet · 3');
    expect(checks(markup)).toEqual([false, false, false]);
    expect(footer(markup)).toBe('Nothing ticked Cancel Mark paid');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Mark paid<\/button>/);
  });

  it('does not open when the client owes nothing (the request closes itself)', () => {
    const none = JOBS.filter((job) => job.clientId !== TAVO.clientId || job === PAID);
    expect(host('4', none)).toBe('');
  });

  it('waits for the job list rather than showing an empty one', () => {
    expect(host('4', null)).toBe('');
  });
});
