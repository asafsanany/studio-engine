import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, makeJob, makeJobDelivery } from '@/data/test-utils';
import type { PayRow } from '@/features/jobs/mark-paid/pay-list';
import { renderCell, textOf } from '../jobs/cells/test-helpers';

// Radix renders a sheet in a portal, which does not exist on a server. Swap the sheet pieces for
// plain elements that keep the props this test cares about (the side, the close button, the
// shell's classes).
vi.mock('@/components/ui/sheet', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    SheetContent: ({ children, side, showCloseButton, className }: Props) =>
      h(
        'div',
        {
          role: 'dialog',
          'data-slot': 'phone-mark-paid-sheet',
          'data-side': String(side),
          'data-close-button': String(showCloseButton),
          className,
        },
        children,
      ),
    SheetTitle: ({ children, className }: Props) => h('h2', { className }, children),
    SheetDescription: ({ children }: Props) => h('p', { 'data-role': 'description' }, children),
  };
});

const { PhoneMarkPaidSheet } = await import('./PhoneMarkPaidSheet');
const { MarkPaidDialogHost } = await import('@/features/jobs/mark-paid/MarkPaidDialogHost');
const { createMarkPaidRequestStore } = await import('@/features/jobs/mark-paid/request');

const row = (
  id: string,
  name: string,
  delivered: string,
  checked: boolean,
  folderDeleted = false,
): PayRow => ({
  id,
  name,
  delivered,
  price: '₪40',
  sign: '₪',
  amount: '40',
  amountValid: true,
  checked,
  folderDeleted,
});

/** Board MMarkPaid: three of Levi's videos, newest delivery first; the middle one's folder is gone. */
const ROWS = [
  row('j5', 'מיתוס או אמת 5', '21 Oct', false),
  row('j4', 'מיתוס או אמת 4', '16 Oct', false, true),
  row('j3', 'שאלות נפוצות 5', '12 Oct', false),
];
const ticked = (...ids: string[]) =>
  ROWS.map((candidate) => ({ ...candidate, checked: ids.includes(candidate.id) }));

const sheet = (props: Partial<React.ComponentProps<typeof PhoneMarkPaidSheet>> = {}) =>
  renderCell(
    <PhoneMarkPaidSheet
      open
      client="עו״ד דוד לוי"
      rows={ticked('j5')}
      allTicked={false}
      paidOn="2026-10-22"
      today="2026-10-22"
      paidOnValid
      total="1 video · ₪40"
      confirm="Mark paid"
      canConfirm
      saving={false}
      error={null}
      onToggle={() => {}}
      onToggleAll={() => {}}
      onAmountChange={() => {}}
      onPaidOnChange={() => {}}
      onConfirm={() => {}}
      onOpenChange={() => {}}
      {...props}
    />,
  );

/** The opening tag of every element of `tag` in the markup, as written. */
const tags = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((match) => match[0]);

/** The markup from the primary button's opening tag on: the button and the total under it. */
const fromConfirm = (markup: string) =>
  markup.slice(markup.search(/<button[^>]*phone-mark-paid-confirm/));

/** Whether an opening tag has the `disabled` attribute (class names such as `disabled:opacity-50` do not count). */
const isDisabled = (tag: string | undefined) => / disabled=""/.test(tag ?? '');

/** The checkboxes of the markup as [checked] in row order. */
const checks = (markup: string) =>
  [...markup.matchAll(/role="checkbox"[^>]*aria-checked="(true|false)"/g)].map(
    (match) => match[1] === 'true',
  );

describe('<PhoneMarkPaidSheet>: opened from a row (one ticked)', () => {
  const markup = sheet();

  it('is a bottom sheet with no close button of its own (the grabber and the dimmed page close it)', () => {
    expect(markup).toContain('data-side="bottom"');
    expect(markup).toContain('data-close-button="false"');
    expect(markup).toContain('data-slot="sheet-grabber"');
    // The phone sheets' shell: a 16 px top radius, the card colour, room for the home indicator.
    expect(markup).toContain('rounded-t-2xl');
    expect(markup).toContain('pb-[max(34px,var(--safe-bottom))]');
  });

  it('has the title with the client in its own direction, and the question under it', () => {
    expect(markup).toContain('Mark paid · <bdi>עו״ד דוד לוי</bdi>');
    expect(markup).toContain('Which videos does this payment cover, and what was paid for each?');
  });

  it('has a header "Not paid yet · 3" with Select all, over one 56 px row per video', () => {
    expect(textOf(markup)).toContain('Not paid yet · 3 Select all');
    expect(markup).toContain('h-11');
    expect(markup.match(/<label [^>]*for="phone-mark-paid-j\d"/g)).toHaveLength(3);
    expect(markup.match(/min-h-14/g)).toHaveLength(3);
  });

  it('ticks the row it was opened from, and only that one; each checkbox is 20 px', () => {
    expect(checks(markup)).toEqual([true, false, false]);
    expect(markup).toContain('id="phone-mark-paid-j5"');
    expect(tags(markup, 'button').filter((tag) => tag.includes('role="checkbox"'))).toSatisfy(
      (boxes: string[]) => boxes.length === 3 && boxes.every((box) => box.includes('size-5')),
    );
  });

  it('shows each video as its name, "Delivered 16 Oct" (and "· folder deleted") and the amount paid', () => {
    const text = textOf(markup);
    const order = ['אמת 5', 'אמת 4', 'נפוצות 5'].map((name) => text.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain('מיתוס או אמת 5 Delivered 21 Oct ₪');
    expect(text).toContain('מיתוס או אמת 4 Delivered 16 Oct · folder deleted ₪');
    expect(text).toContain('שאלות נפוצות 5 Delivered 12 Oct ₪');
    expect(markup).toMatch(/dir="auto"[^>]*class="bidi[^"]*"[^>]*>מיתוס או אמת 5/);
  });

  it('gives each video a 16 px amount field with a number pad, starting at its price', () => {
    const fields = tags(markup, 'input').filter((tag) => tag.includes('inputMode="decimal"'));
    expect(fields).toHaveLength(3);
    for (const field of fields) {
      expect(field).toContain('value="40"');
      // iOS zooms into text smaller than 16 px.
      expect(field).toContain('text-base');
    }
    expect(fields[0]).toContain('aria-label="Paid for מיתוס או אמת 5"');
    // Outside the label: a label holds no field but its own.
    const label = markup.slice(markup.indexOf('for="phone-mark-paid-j5"'));
    expect(label.slice(0, label.indexOf('</label>'))).not.toContain('inputMode');
  });

  it('has "Paid on" with a 16 px date field of today that cannot go past today', () => {
    expect(markup).toContain('for="phone-mark-paid-on"');
    expect(markup).toMatch(/<input[^>]*id="phone-mark-paid-on"/);
    expect(markup).toContain('type="date"');
    expect(markup).toContain('value="2026-10-22"');
    expect(markup).toContain('max="2026-10-22"');
    // iOS zooms into text smaller than 16 px; the Input's `md:text-sm` only starts at 768 px.
    expect(tags(markup, 'input').find((tag) => tag.includes('type="date"'))).toContain('text-base');
    expect(markup).toContain('[color-scheme:dark]');
    expect(markup).toContain('aria-invalid="false"');
  });

  it('has a full-width 48 px primary "Mark paid", and the total under it', () => {
    const confirm = tags(markup, 'button').find((tag) => tag.includes('phone-mark-paid-confirm'));
    expect(confirm).toContain('h-12');
    expect(confirm).toContain('w-full');
    expect(isDisabled(confirm)).toBe(false);
    expect(textOf(fromConfirm(markup))).toBe('Mark paid 1 video · ₪40');
    expect(fromConfirm(markup)).toContain('aria-live="polite"');
  });

  it('has no Cancel button and shows no error and no spinner', () => {
    expect(textOf(markup)).not.toContain('Cancel');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('animate-spin');
  });

  it('shows nothing while it is closed', () => {
    expect(sheet({ open: false })).toBe('');
  });
});

describe('<PhoneMarkPaidSheet>: after Select all (every video ticked)', () => {
  const markup = sheet({
    rows: ticked('j5', 'j4', 'j3'),
    allTicked: true,
    total: '3 videos · ₪120',
    confirm: 'Mark 3 paid',
  });

  it('ticks every row, and the list’s button reads "Clear"', () => {
    expect(checks(markup)).toEqual([true, true, true]);
    expect(textOf(markup)).toContain('Not paid yet · 3 Clear');
    expect(textOf(markup)).not.toContain('Select all');
  });

  it('says how many, and what they add up to', () => {
    expect(textOf(fromConfirm(markup))).toBe('Mark 3 paid 3 videos · ₪120');
  });
});

describe('<PhoneMarkPaidSheet>: nothing ticked', () => {
  it('says "Nothing ticked" and turns the primary button off', () => {
    const markup = sheet({ rows: ticked(), total: 'Nothing ticked', canConfirm: false });
    const confirm = tags(markup, 'button').find((tag) => tag.includes('phone-mark-paid-confirm'));
    expect(isDisabled(confirm)).toBe(true);
    expect(textOf(fromConfirm(markup))).toBe('Mark paid Nothing ticked');
  });
});

describe('<PhoneMarkPaidSheet>: a day that cannot be sent, or a refusal', () => {
  it('marks the date field invalid and turns the primary button off', () => {
    const markup = sheet({ paidOn: '', paidOnValid: false, canConfirm: false });
    expect(markup).toContain('aria-invalid="true"');
    const confirm = tags(markup, 'button').find((tag) => tag.includes('phone-mark-paid-confirm'));
    expect(isDisabled(confirm)).toBe(true);
  });

  it('says what went wrong in a line over the button, tied to the date field', () => {
    const markup = sheet({ error: 'A video changed meanwhile.' });
    expect(markup).toContain('role="alert"');
    expect(textOf(markup)).toContain('A video changed meanwhile.');
    expect(markup).toContain('aria-describedby="phone-mark-paid-error"');
    expect(markup).toContain('id="phone-mark-paid-error"');
  });
});

describe('<PhoneMarkPaidSheet>: while the payment is on its way', () => {
  const markup = sheet({ saving: true });

  it('turns everything off and shows a spinner on the primary button', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('animate-spin');
    // Select all, the three checkboxes and the primary button, and the day.
    const buttons = tags(markup, 'button');
    expect(buttons).toHaveLength(5);
    expect(buttons.every(isDisabled)).toBe(true);
    expect(isDisabled(tags(markup, 'input').find((tag) => tag.includes('type="date"')))).toBe(true);
  });
});

describe('<MarkPaidDialogHost view={PhoneMarkPaidSheet}>: the Mac’s rules on the phone', () => {
  const TAVO = { clientId: 'client-tavo', client: 'עו״ד דוד לוי' };
  const owed = (id: string, day: string, overrides: Partial<Job> = {}): Job =>
    makeJob({
      id,
      name: `מיתוס או אמת ${id}`,
      ...TAVO,
      state: 'ready',
      placeInLine: null,
      delivery: makeJobDelivery({ deliveredAt: `${day}T09:00:00.000Z` }),
      ...overrides,
    });
  const JOBS = [
    owed('3', '2026-10-12'),
    owed('5', '2026-10-21'),
    // Not offered: archived (paid already or not needed), another client's, not delivered.
    owed('9', '2026-10-20', { archivedAt: '2026-10-21T09:00:00.000Z' }),
    owed('rgm', '2026-10-20', { clientId: 'client-rgm', client: 'RGM' }),
    owed('8', '2026-10-20', { delivery: null }),
    owed('4', '2026-10-16'),
  ];

  const hosted = (jobId: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <MarkPaidDialogHost
          jobs={JOBS}
          store={createMarkPaidRequestStore({ jobId, ...TAVO })}
          view={PhoneMarkPaidSheet}
        />
      </QueryClientProvider>,
    );

  it('opens the bottom sheet, not the dialog, for the client of the row that asked', () => {
    const markup = hosted('4');
    expect(markup).toContain('data-slot="phone-mark-paid-sheet"');
    expect(markup).toContain('Mark paid · <bdi>עו״ד דוד לוי</bdi>');
  });

  it('lists the client’s delivered, unpaid videos newest first, archived ones left out', () => {
    const text = textOf(hosted('4'));
    expect(text).toContain('Not paid yet · 3');
    const at = ['אמת 5', 'אמת 4', 'אמת 3'].map((name) => text.indexOf(name));
    expect(at.every((index) => index > -1)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const left of ['אמת 9', 'אמת 8', 'rgm']) expect(text).not.toContain(left);
  });

  it('starts with only the video it was opened from ticked, and says so in the button and total', () => {
    const markup = hosted('4');
    expect(checks(markup)).toEqual([false, true, false]);
    expect(textOf(fromConfirm(markup))).toBe('Mark paid 1 video · ₪40');
  });
});
