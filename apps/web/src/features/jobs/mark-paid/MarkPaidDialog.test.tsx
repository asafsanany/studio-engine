import { describe, expect, it, vi } from 'vitest';
import { renderCell, textOf } from '../cells/test-helpers';
import type { PayRow } from './pay-list';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces
// for plain elements that keep the props this test cares about (the close button, the width).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, showCloseButton, className }: Props) =>
      h(
        'div',
        { role: 'dialog', 'data-close-button': String(showCloseButton), className },
        children,
      ),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', { 'data-role': 'description' }, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { MARK_PAID_DIALOG_TEXT, MarkPaidDialog } = await import('./MarkPaidDialog');

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

/** The design canvas's "Mark paid" dialog: three of Levi's videos, newest delivery first. */
const ROWS = [
  row('j5', 'מיתוס או אמת 5', '21 Oct', false),
  row('j4', 'מיתוס או אמת 4', '16 Oct', false),
  row('j3', 'מיתוס או אמת 3', '12 Oct', false),
];
const ticked = (...ids: string[]) =>
  ROWS.map((candidate) => ({ ...candidate, checked: ids.includes(candidate.id) }));

const dialog = (props: Partial<React.ComponentProps<typeof MarkPaidDialog>> = {}) =>
  renderCell(
    <MarkPaidDialog
      open
      client="עו״ד דוד לוי"
      rows={ticked('j4')}
      allTicked={false}
      paidOn="2026-10-21"
      today="2026-10-21"
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

/** Whether an opening tag has the `disabled` attribute (class names such as `disabled:opacity-50` do not count). */
const isDisabled = (tag: string | undefined) => / disabled=""/.test(tag ?? '');

/** The checkboxes of the markup as [checked] in row order. */
const checks = (markup: string) =>
  [...markup.matchAll(/role="checkbox"[^>]*aria-checked="(true|false)"/g)].map(
    (match) => match[1] === 'true',
  );

describe('<MarkPaidDialog>: opened from a row (one ticked)', () => {
  const markup = dialog();

  it('uses the words of the design canvas', () => {
    expect(MARK_PAID_DIALOG_TEXT).toMatchObject({
      question: 'Which videos does this payment cover, and what was paid for each?',
      notPaidYet: 'Not paid yet',
      selectAll: 'Select all',
      clear: 'Clear',
      paidOn: 'Paid on',
      cancel: 'Cancel',
    });
    expect(markup).toContain('<h2>Mark paid · <bdi>עו״ד דוד לוי</bdi></h2>');
    expect(markup).toContain('Which videos does this payment cover, and what was paid for each?');
  });

  it('shows nothing while it is closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('has no close button (Cancel is the way out) and the board’s 460 px width', () => {
    expect(markup).toContain('data-close-button="false"');
    expect(markup).toContain('sm:max-w-[460px]');
  });

  it('has a header with the count and "Select all", over one row per video', () => {
    const text = textOf(markup);
    expect(text).toContain('Not paid yet · 3 Select all');
    // One label per video: the day has its own.
    expect(markup.match(/<label [^>]*for="mark-paid-j\d"/g)).toHaveLength(3);
  });

  it('ticks the row it was opened from, and only that one', () => {
    expect(checks(markup)).toEqual([false, true, false]);
  });

  it('shows each video as its name, "Delivered 16 Oct" and the amount paid, newest delivery first', () => {
    const text = textOf(markup);
    const order = ['אמת 5', 'אמת 4', 'אמת 3'].map((name) => text.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain('מיתוס או אמת 5 Delivered 21 Oct ₪');
    expect(text).toContain('מיתוס או אמת 4 Delivered 16 Oct ₪');
    expect(text).toContain('מיתוס או אמת 3 Delivered 12 Oct ₪');
  });

  it('makes the checkbox, the name and the day the label of the checkbox, 44 px high, the name in its own direction', () => {
    expect(markup).toContain('for="mark-paid-j4"');
    expect(markup).toContain('id="mark-paid-j4"');
    expect(markup).toContain('h-11');
    expect(markup).toMatch(/dir="auto"[^>]*class="bidi[^"]*"[^>]*>מיתוס או אמת 5/);
    // The amount field is outside the label: a label holds no field but its own.
    const label = markup.slice(markup.indexOf('for="mark-paid-j4"'));
    expect(label.slice(0, label.indexOf('</label>'))).not.toContain('inputMode');
  });

  it('gives each video an amount field that starts at its price, named for the video', () => {
    const fields = tags(markup, 'input').filter((tag) => tag.includes('inputMode="decimal"'));
    expect(fields).toHaveLength(3);
    for (const field of fields) {
      expect(field).toContain('value="40"');
      expect(field).toContain('aria-invalid="false"');
    }
    expect(fields[0]).toContain('aria-label="Paid for מיתוס או אמת 5"');
    expect(MARK_PAID_DIALOG_TEXT.paidFor).toBe('Paid for');
  });

  it('writes the amount of an unticked video quietly, and a ticked one plainly', () => {
    const fields = tags(markup, 'input').filter((tag) => tag.includes('inputMode="decimal"'));
    expect(fields.map((field) => /\stext-muted-foreground"/.test(field))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('has a "Paid on" date input of today, that cannot go past today, drawn for a dark page', () => {
    expect(markup).toContain('for="mark-paid-on"');
    expect(markup).toMatch(/<input[^>]*id="mark-paid-on"/);
    expect(markup).toContain('type="date"');
    expect(markup).toContain('value="2026-10-21"');
    expect(markup).toContain('max="2026-10-21"');
    expect(markup).toContain('[color-scheme:dark]');
    expect(markup).toContain('aria-invalid="false"');
  });

  it('has the total on the left of the footer, then Cancel and the primary "Mark paid"', () => {
    const footer = markup.slice(markup.indexOf('<footer'));
    expect(textOf(footer)).toBe('1 video · ₪40 Cancel Mark paid');
    expect(footer).toContain('aria-live="polite"');
    expect(tags(footer, 'button').map(isDisabled)).toEqual([false, false]);
  });

  it('shows no error and no spinner', () => {
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('animate-spin');
  });
});

describe('<MarkPaidDialog>: after Select all (every video ticked)', () => {
  const markup = dialog({
    rows: ticked('j5', 'j4', 'j3'),
    allTicked: true,
    total: '3 videos · ₪120',
    confirm: 'Mark 3 paid',
  });

  it('ticks every row, and the list’s button reads "Clear"', () => {
    expect(checks(markup)).toEqual([true, true, true]);
    const text = textOf(markup);
    expect(text).toContain('Not paid yet · 3 Clear');
    expect(text).not.toContain('Select all');
  });

  it('adds the videos up in the footer, and the primary button says how many', () => {
    const footer = markup.slice(markup.indexOf('<footer'));
    expect(textOf(footer)).toBe('3 videos · ₪120 Cancel Mark 3 paid');
  });
});

describe('<MarkPaidDialog>: nothing ticked', () => {
  const markup = dialog({
    rows: ticked(),
    total: 'Nothing ticked',
    canConfirm: false,
  });

  it('says "Nothing ticked" and turns the primary button off, but not Cancel', () => {
    const footer = markup.slice(markup.indexOf('<footer'));
    expect(textOf(footer)).toBe('Nothing ticked Cancel Mark paid');
    // Cancel is on; the primary button is off.
    expect(tags(footer, 'button').map(isDisabled)).toEqual([false, true]);
  });
});

describe('<MarkPaidDialog>: an amount typed for a video', () => {
  it('shows what was typed, ₪0 included', () => {
    const rows = ticked('j4').map((candidate) =>
      candidate.id === 'j4' ? { ...candidate, amount: '0' } : candidate,
    );
    const markup = dialog({ rows, total: '1 video · ₪0' });
    expect(markup).toMatch(/<input[^>]*aria-label="Paid for מיתוס או אמת 4"[^>]*value="0"/);
    expect(textOf(markup.slice(markup.indexOf('<footer')))).toBe('1 video · ₪0 Cancel Mark paid');
  });

  it('marks a field that holds no amount invalid', () => {
    const rows = ticked('j4').map((candidate) =>
      candidate.id === 'j4' ? { ...candidate, amount: 'abc', amountValid: false } : candidate,
    );
    const markup = dialog({ rows, canConfirm: false });
    expect(markup).toMatch(/<input[^>]*aria-invalid="true"[^>]*value="abc"/);
    const footer = markup.slice(markup.indexOf('<footer'));
    expect(tags(footer, 'button').map(isDisabled)).toEqual([false, true]);
  });
});

describe('<MarkPaidDialog>: a day that cannot be sent', () => {
  it('marks the date input invalid and turns the primary button off', () => {
    const markup = dialog({ paidOn: '', paidOnValid: false, canConfirm: false });
    expect(markup).toContain('aria-invalid="true"');
    const footer = markup.slice(markup.indexOf('<footer'));
    expect(tags(footer, 'button').map(isDisabled)).toEqual([false, true]);
  });
});

describe('<MarkPaidDialog>: while the payment is on its way', () => {
  const markup = dialog({ saving: true });

  it('turns everything off and shows a spinner on the primary button', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('animate-spin');
    // Select all, the three checkboxes, Cancel and the primary button, and the day.
    const buttons = tags(markup, 'button');
    expect(buttons).toHaveLength(6);
    expect(buttons.every(isDisabled)).toBe(true);
    expect(isDisabled(tags(markup, 'input').find((tag) => tag.includes('type="date"')))).toBe(true);
    const amounts = tags(markup, 'input').filter((tag) => tag.includes('inputMode="decimal"'));
    expect(amounts.every(isDisabled)).toBe(true);
  });
});

describe('<MarkPaidDialog>: a refused payment', () => {
  const markup = dialog({ error: 'Something changed meanwhile. Check the list and try again.' });

  it('shows the short line under the date, in red, and ties it to the date input', () => {
    expect(markup).toMatch(
      /<p id="mark-paid-error" role="alert" class="[^"]*text-destructive[^"]*">Something changed meanwhile\. Check the list and try again\.<\/p>/,
    );
    expect(markup).toContain('aria-describedby="mark-paid-error"');
    expect(markup.indexOf('mark-paid-on')).toBeLessThan(markup.indexOf('role="alert"'));
    expect(markup.indexOf('role="alert"')).toBeLessThan(markup.indexOf('<footer'));
  });
});

describe('<MarkPaidDialog>: a video whose folder was deleted (CVP-204)', () => {
  const rows = [
    row('j5', 'מיתוס או אמת 5', '21 Oct', false),
    row('gone', 'History check', '19 Oct', true, true),
  ];
  const markup = dialog({ rows, total: '1 video · ₪40' });

  it('says "folder deleted" after its name, and only after its name', () => {
    const text = textOf(markup);
    expect(text).toContain('History check folder deleted Delivered 19 Oct ₪');
    expect(text.match(/folder deleted/g)).toHaveLength(1);
    expect(MARK_PAID_DIALOG_TEXT.folderDeleted).toBe('folder deleted');
  });

  it('writes it small and muted, and lets the name shrink before it does', () => {
    expect(markup).toMatch(
      /<span class="shrink-0 text-\[13px\] text-muted-foreground">folder deleted<\/span>/,
    );
    expect(markup).toMatch(/class="[^"]*min-w-0 truncate[^"]*"[^>]*>History check</);
  });

  it('leaves the other rows as they were', () => {
    expect(textOf(markup)).toContain('מיתוס או אמת 5 Delivered 21 Oct ₪');
  });

  it('lists it like any other video: a checkbox, ticked here, counted in the header', () => {
    expect(checks(markup)).toEqual([false, true]);
    expect(textOf(markup)).toContain('Not paid yet · 2');
    expect(markup).toContain('for="mark-paid-gone"');
  });
});
