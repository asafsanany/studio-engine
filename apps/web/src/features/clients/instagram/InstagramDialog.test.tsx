import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Radix needs a dialog around its title and description, and puts the dialog in a portal, which a
// server render does not have. Swap the pieces for plain elements, as the New client tests do.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ children }: Props) => children,
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', { 'data-role': 'description' }, children),
    DialogFooter: ({ children, className }: Props) => h('footer', { class: className }, children),
  };
});

const { InstagramDialogContent } = await import('./InstagramDialog');
type InstagramDialogContentProps = import('./InstagramDialog').InstagramDialogContentProps;

// The dialog's content as the board S1 draws it. Radix puts the dialog itself in a portal, which a
// server render does not have, so the content is drawn on its own, as the New client tests do.

const OPTIONS = { timeZone: 'Asia/Jerusalem', now: Date.parse('2026-10-30T10:00:00.000Z') };

function props(overrides: Partial<InstagramDialogContentProps> = {}): InstagramDialogContentProps {
  return {
    clientName: 'Falcon FPV',
    hasAccount: false,
    loading: false,
    accountHandle: '',
    handle: '',
    since: '',
    handleProblem: null,
    sinceProblem: null,
    firstDelivery: '2026-10-12',
    today: '2026-10-30',
    step: 'edit',
    pending: false,
    error: null,
    onHandleChange: () => undefined,
    onHandleBlur: () => undefined,
    onSinceChange: () => undefined,
    onSinceBlur: () => undefined,
    onSubmit: () => undefined,
    onCancel: () => undefined,
    onAskRemove: () => undefined,
    onKeep: () => undefined,
    onRemove: () => undefined,
    textOptions: OPTIONS,
    ...overrides,
  };
}

const render = (overrides?: Partial<InstagramDialogContentProps>) =>
  renderToStaticMarkup(<InstagramDialogContent {...props(overrides)} />);

/** The opening tag of the first element of that tag name whose tag has `needle`. */
const tag = (markup: string, name: string, needle: string) =>
  markup.match(new RegExp(`<${name}\\b[^>]*${needle}[^>]*>`))?.[0] ?? '';

describe('<InstagramDialogContent> for a client with no account (S1)', () => {
  const markup = render();

  it('is titled with the client and says what a scan costs', () => {
    expect(markup).toMatch(/<h2[^>]*>Instagram · Falcon FPV<\/h2>/);
    expect(markup).toContain('Scanned now, then every Monday. About $0.05 a week.');
  });

  it('has the account field, labelled, with its hint and an @name placeholder', () => {
    expect(markup).toMatch(/<label[^>]*>Instagram account<\/label>/);
    const input = tag(markup, 'input', 'type="text"');
    expect(input).toContain('placeholder="@name or instagram.com/name"');
    expect(input).toContain('dir="ltr"');
    expect(input).toContain('autoComplete="off"');
    const id = input.match(/ id="([^"]+)"/)?.[1];
    expect(markup).toContain(`for="${id}"`);
    expect(markup).toContain(
      'A name or a link. It must be public (a business or creator account is best).',
    );
  });

  it('has the day field, a text field like the account one, with the first delivery named', () => {
    expect(markup).toMatch(/<label[^>]*>Working together since<\/label>/);
    const field = tag(markup, 'input', 'placeholder="1 Aug 2026"');
    expect(field).toContain('type="text"');
    expect(field).toContain('autoComplete="off"');
    const id = field.match(/ id="([^"]+)"/)?.[1];
    expect(markup).toContain(`for="${id}"`);
    expect(markup).toContain(
      'The first delivery is 12 Oct. Set an earlier date for work from before Studio Engine.',
    );
  });

  it('says what an empty day means when the client has had no delivery', () => {
    expect(render({ firstDelivery: null })).toContain(
      'leave it empty to start from the first delivery',
    );
  });

  it('is a form with Cancel and Save and scan, the second one submits', () => {
    expect(markup).toMatch(/<form[^>]*>/);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Cancel<\/button>/);
    expect(tag(markup, 'button', 'type="submit"')).toContain('disabled=""');
    expect(markup.indexOf('>Cancel<')).toBeLessThan(markup.indexOf('Save and scan'));
  });

  it('has no Remove Instagram, and nothing said in red', () => {
    expect(markup).not.toContain('Remove Instagram');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it('can be saved once something is typed', () => {
    const typed = render({ handle: '@falcon.fpv', since: '1 Aug 2026' });
    expect(tag(typed, 'button', 'type="submit"')).not.toContain('disabled=""');
    expect(typed).toContain('value="@falcon.fpv"');
    expect(typed).toContain('value="1 Aug 2026"');
  });

  it('keeps the calendar behind a button at the end of the day field', () => {
    const button = tag(markup, 'button', 'aria-label="Pick a day"');
    expect(button).toContain('type="button"');
    // The browser's calendar is the date input behind it: no later than today, not in the tab order.
    const native = tag(markup, 'input', 'type="date"');
    expect(native).toContain('max="2026-10-30"');
    expect(native).toContain('tabindex="-1"');
    expect(native).toContain('aria-hidden="true"');
    expect(native).not.toMatch(/ id="/);
    expect(markup.indexOf('placeholder="1 Aug 2026"')).toBeLessThan(markup.indexOf('Pick a day'));
  });

  it('opens the calendar on the typed day, and on none when the text is no day', () => {
    const native = (since: string) => tag(render({ since }), 'input', 'type="date"');
    expect(native('1 Aug 2026')).toContain('value="2026-08-01"');
    expect(native('2026-08-01')).toContain('value="2026-08-01"');
    expect(native('last summer')).toContain('value=""');
    expect(native('')).toContain('value=""');
  });
});

describe('<InstagramDialogContent> saying what is wrong', () => {
  it('puts the engine’s sentence under the account in place of the hint', () => {
    const markup = render({
      handle: 'falcon fpv',
      handleProblem: 'An Instagram handle has no spaces.',
    });
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>An Instagram handle has no spaces\.<\/p>/);
    expect(markup).not.toContain('It must be public');
    expect(tag(markup, 'input', 'type="text"')).toContain('aria-invalid="true"');
  });

  it('puts a refused day under the day', () => {
    const markup = render({ since: '1 Dec 2026', sinceProblem: 'That day has not come yet.' });
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>That day has not come yet\.<\/p>/);
    expect(tag(markup, 'input', 'placeholder="1 Aug 2026"')).toContain('aria-invalid="true"');
    expect(markup).not.toContain('The first delivery is');
  });

  it('says what the server said above the buttons', () => {
    const markup = render({
      handle: 'falcon.fpv',
      error: 'Cannot reach the Studio Engine server.',
    });
    expect(markup).toMatch(/role="alert"[^>]*>Cannot reach the Studio Engine server\.<\/p>/);
    expect(markup.indexOf('Cannot reach')).toBeLessThan(markup.indexOf('Save and scan'));
  });
});

describe('<InstagramDialogContent> for a client that has an account', () => {
  const markup = render({
    hasAccount: true,
    accountHandle: 'falcon.fpv',
    handle: 'falcon.fpv',
    since: '1 Aug 2026',
  });

  it('starts from the account and offers Remove Instagram, in red, before Cancel and Save and scan', () => {
    expect(markup).toContain('value="falcon.fpv"');
    const remove = tag(markup, 'button', 'text-destructive');
    expect(remove).toContain('type="button"');
    expect(markup).toContain('>Remove Instagram</button>');
    expect(markup.indexOf('Remove Instagram')).toBeLessThan(markup.indexOf('>Cancel<'));
    expect(markup.indexOf('>Cancel<')).toBeLessThan(markup.indexOf('Save and scan'));
  });

  it('still saves with Save and scan', () => {
    expect(tag(markup, 'button', 'type="submit"')).not.toContain('disabled=""');
    expect(markup).toContain('Save and scan');
  });
});

describe('<InstagramDialogContent> while it works', () => {
  it('waits for the account: the fields cannot be typed in yet', () => {
    const markup = render({ loading: true });
    expect(markup).toContain('aria-busy="true"');
    expect(tag(markup, 'input', 'type="text"')).toContain('disabled=""');
    expect(tag(markup, 'input', 'placeholder="1 Aug 2026"')).toContain('disabled=""');
    expect(tag(markup, 'button', 'aria-label="Pick a day"')).toContain('disabled=""');
    expect(tag(markup, 'input', 'type="date"')).toContain('disabled=""');
  });

  it('says Saving… and locks everything while the request is on its way', () => {
    const markup = render({ hasAccount: true, handle: 'falcon.fpv', pending: true });
    expect(markup).toContain('Saving…');
    expect(markup).not.toContain('Save and scan');
    expect(tag(markup, 'input', 'type="text"')).toContain('disabled=""');
    expect(tag(markup, 'button', 'type="submit"')).toContain('aria-busy="true"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
  });
});

describe('<InstagramDialogContent> asking before it removes', () => {
  const markup = render({
    hasAccount: true,
    accountHandle: 'falcon.fpv',
    handle: 'falcon.fpv',
    step: 'remove',
  });

  it('is a question that names the account and says the history stays', () => {
    expect(markup).toMatch(/<h2[^>]*>Remove Instagram\?<\/h2>/);
    expect(markup).toContain(
      'Studio Engine stops reading @falcon.fpv for Falcon FPV. The scans and reels it has read so far are kept.',
    );
  });

  it('has the fields gone, Cancel, and a red Remove Instagram', () => {
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<form');
    expect(markup).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(tag(markup, 'button', 'data-variant="destructive"')).toContain('type="button"');
    expect(markup).toContain('Remove Instagram</button>');
  });

  it('says Removing… while it works, and what the server said when it refused', () => {
    expect(render({ hasAccount: true, step: 'remove', pending: true })).toContain('Removing…');
    expect(
      render({ hasAccount: true, step: 'remove', error: 'Cannot reach the Studio Engine server.' }),
    ).toMatch(/role="alert"[^>]*>Cannot reach/);
  });
});
