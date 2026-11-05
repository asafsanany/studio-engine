import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { PhoneReviewFooter } from './PhoneReviewFooter';
import type { PhoneFooterView } from './phone-review';

const noop = () => {};

function footer(
  view: PhoneFooterView,
  props: Partial<React.ComponentProps<typeof PhoneReviewFooter>> = {},
): string {
  return render(
    <PhoneReviewFooter
      view={view}
      effort={null}
      error={null}
      ruled={false}
      onSend={noop}
      onOpenEffort={noop}
      onClose={noop}
      {...props}
    />,
  );
}

/** The opening tag of the first element in `html` that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

const LINE =
  'Happy with it? Press and hold the job in the list and choose Approve to render the final video.';
const approve: PhoneFooterView = { kind: 'approve', text: LINE };
const send: PhoneFooterView = {
  kind: 'send',
  label: 'Send 2 notes',
  disabled: false,
  busy: false,
  disabledReason: null,
  effortLabel: 'Effort: High',
};

describe('<PhoneReviewFooter>', () => {
  it('with no notes: no button, only the line that says where Approve is, as tall as a button', () => {
    const html = footer(approve);
    const line = tagWith(html, 'data-slot="phone-review-approve"');
    expect(line).toContain('min-h-12');
    expect(line).toContain('text-muted-foreground');
    expect(line).toContain('role="status"');
    expect(html).toContain(`${LINE}</p>`);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-slot="review-effort"');
    expect(html).not.toContain('data-action=');
  });

  it('with notes: the outlined Effort button before Send N notes, both 48 px, and no Approve', () => {
    const html = footer(send, { effort: 'high' });
    const effort = tagWith(html, 'data-slot="review-effort"');
    expect(effort).toContain('data-variant="outline"');
    expect(effort).toContain('h-12');
    expect(html).toContain('Effort: High');
    const sendButton = tagWith(html, 'data-action="send_notes"');
    expect(sendButton).toContain('h-12');
    expect(html).toContain('Send 2 notes');
    expect(html.indexOf('data-slot="review-effort"')).toBeLessThan(
      html.indexOf('data-action="send_notes"'),
    );
    expect(html).not.toContain('data-slot="phone-review-approve"');
  });

  it('has the Effort gauge of the job’s level', () => {
    const html = footer(send, { effort: 'high' });
    // High's needle points up (board MReviewEffort).
    expect(html).toContain('M12 14V8.3');
  });

  it('disables Send while it waits, and shows a spinner while it runs', () => {
    expect(tagWith(footer({ ...send, disabled: true }), 'data-action="send_notes"')).toContain(
      'disabled',
    );
    const busy = footer({ ...send, disabled: true, busy: true });
    expect(tagWith(busy, 'data-action="send_notes"')).toContain('aria-busy="true"');
    expect(busy).toContain('animate-spin');
    expect(tagWith(busy, 'data-slot="review-effort"')).toContain('disabled');
  });

  it('says a refusal above the buttons', () => {
    const html = footer(send, { error: 'Cannot send the notes of a job that is queued.' });
    expect(tagWith(html, 'role="alert"')).toContain('text-destructive');
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('data-action="send_notes"'));
    expect(html).toContain('Cannot send the notes of a job that is queued.');
  });

  it('after it went through: the done line and Close, and no action', () => {
    const html = footer({ kind: 'done', text: 'Approved. The final video is rendering.' });
    expect(tagWith(html, 'role="status"')).toContain('flex');
    expect(html).toContain('Approved. The final video is rendering.');
    expect(html).toContain('Close');
    expect(html).not.toContain('data-action=');
    expect(html).not.toContain('data-slot="review-effort"');
    expect(tagWith(html, 'data-slot="phone-review-footer"')).toContain('data-kind="done"');
  });

  it('leaves room for the home indicator, and a rule above it when the notes are open', () => {
    const shut = tagWith(footer(approve), 'data-slot="phone-review-footer"');
    expect(shut).toContain('var(--safe-bottom)');
    // The board's footer always has its 1 px top border (60 px = 1 + 6 + 48 + 5); it is only
    // drawn while the notes list is open above it.
    expect(shut).toContain('border-t');
    expect(shut).toContain('border-transparent');
    expect(shut).not.toContain('border-white/10');
    const ruled = tagWith(footer(approve, { ruled: true }), 'data-slot="phone-review-footer"');
    expect(ruled).toContain('border-white/10');
    expect(ruled).not.toContain('border-transparent');
  });

  it("the done line sits in the board's 124 px box, with Close at the foot", () => {
    const done = tagWith(
      footer({ kind: 'done', text: 'Approved.' }),
      'data-slot="phone-review-footer"',
    );
    expect(done).toContain('min-h-[calc(124px+var(--safe-bottom))]');
    expect(done).toContain('justify-between');
    expect(done).toContain('border-white/10');
  });

  it('says in muted text above the line what Approve renders (two formats)', () => {
    const hint = 'Approve renders both formats, 9:16 and 1:1.';
    const html = footer(approve, { hint });
    expect(tagWith(html, 'data-slot="phone-review-hint"')).toContain('text-muted-foreground');
    expect(html).toContain(`${hint}</p>`);
    expect(html.indexOf(hint)).toBeLessThan(html.indexOf('data-slot="phone-review-approve"'));
  });

  it('has no hint line by default, and a refusal from the server replaces it', () => {
    expect(footer(approve)).not.toContain('data-slot="phone-review-hint"');
    const refused = footer(approve, { hint: 'Approve renders both formats.', error: 'No.' });
    expect(refused).not.toContain('data-slot="phone-review-hint"');
    expect(refused).toContain('No.');
  });
});

describe('<PhoneReviewFooter> with Quick fixes on', () => {
  const sendAuto: PhoneFooterView = { ...send, effortLabel: 'Effort: Auto' };

  it('wears sparkles on the Effort button for Auto, and says "Effort: Auto"', () => {
    const html = footer(sendAuto, { effort: null, auto: true });
    expect(tagWith(html, 'data-slot="review-effort"')).toContain('h-12');
    expect(html).toContain('Effort: Auto');
    expect(html).toContain('lucide-sparkles');
    expect(html).not.toContain('lucide-gauge');
  });

  it('wears the gauge of a chosen level', () => {
    const html = footer(send, { effort: 'high', auto: true });
    expect(html).toContain('M12 14V8.3');
    expect(html).not.toContain('lucide-sparkles');
  });

  it('keeps the gauge for Default with the switch off', () => {
    const html = footer(send, { effort: null });
    expect(html).toContain('lucide-gauge');
    expect(html).not.toContain('lucide-sparkles');
  });
});

describe('<PhoneReviewFooter> with Quick fixes on', () => {
  it('says the footer’s line in muted text above the buttons, as a live region', () => {
    const html = footer({
      ...send,
      disabled: true,
      effortDisabled: true,
      note: 'Fixing it here. Send waits for it.',
    });
    const hint = tagWith(html, 'data-slot="phone-review-hint"');
    expect(hint).toContain('text-muted-foreground');
    expect(hint).toContain('role="status"');
    expect(html).toContain('Fixing it here. Send waits for it.</p>');
    expect(html.indexOf('Fixing it here.')).toBeLessThan(html.indexOf('data-slot="review-effort"'));
  });

  it('holds Send and the Effort button while a fix is under way', () => {
    const html = footer({
      ...send,
      disabled: true,
      effortDisabled: true,
      note: 'Fixing it here. Send waits for it.',
    });
    expect(tagWith(html, 'data-action="send_notes"')).toContain('disabled=""');
    expect(tagWith(html, 'data-slot="review-effort"')).toContain('disabled=""');
  });

  it('leaves the Effort button on when only Send waits for something else', () => {
    const html = footer({ ...send, disabled: true, disabledReason: 'Waiting for the voice notes' });
    expect(tagWith(html, 'data-slot="review-effort"')).not.toContain('disabled=""');
  });

  it('with no notes says what the notes are doing in its one line, with no button to hold', () => {
    const html = footer({ kind: 'approve', text: 'Reading the note. Approve waits for it.' });
    expect(html).toContain('Reading the note. Approve waits for it.</p>');
    expect(tagWith(html, 'data-slot="phone-review-approve"')).toContain('role="status"');
    expect(html).not.toContain('<button');
  });

  it('has no live region of its own when the line above is only the formats’ hint', () => {
    const html = footer(approve, { hint: 'Approve renders both formats, 9:16 and 1:1.' });
    expect(tagWith(html, 'data-slot="phone-review-hint"')).not.toContain('role=');
  });
});
