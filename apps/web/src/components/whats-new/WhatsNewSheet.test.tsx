import type { Release } from '@studio/shared';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { WhatsNewDialog, WhatsNewPanel } from './WhatsNewDialog';

// The phone layout shows the same notes as a bottom sheet (boards MWhatsNew and MWhatsNewShot).
// The dialog's own tests are in WhatsNewDialog.test.tsx; this file is what the sheet changes.

// There is no DOM here, so the dialog is called as a plain function to read what it hands to
// Radix (see WhatsNewDialog.wiring.test.tsx): refs are plain objects and effects run at once.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void) => {
    effect();
  },
}));

const release = (version: string, extra: Partial<Release> = {}): Release => ({
  version,
  date: '2026-10-22',
  items: [`Change in ${version}.`],
  ...extra,
});
const releases = [
  release('0.13.1'),
  release('0.13.0', { screenshot: '0.13.0-whats-new.jpg' }),
  release('0.12.13'),
];

function render(variant: 'dialog' | 'sheet', list: readonly Release[] = releases): string {
  return renderToStaticMarkup(
    <Dialog open>
      <WhatsNewPanel releases={list} onClose={vi.fn()} variant={variant} />
    </Dialog>,
  );
}

describe('<WhatsNewPanel variant="sheet">', () => {
  const html = render('sheet');

  it('has the same content as the dialog: the title, every release newest first, one "Got it"', () => {
    // The sheet has the board's curly apostrophe; the Mac's dialog keeps the straight one.
    expect(html).toMatch(/<h2[^>]*data-slot="dialog-title"[^>]*>What’s new<\/h2>/);
    expect(render('dialog')).toMatch(/<h2[^>]*data-slot="dialog-title"[^>]*>What&#x27;s new<\/h2>/);
    const at = releases.map((r) => html.indexOf(`>v${r.version}<`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at[0]).toBeGreaterThan(-1);
    expect(html.match(/data-slot="whats-new-release"/g)).toHaveLength(3);
    expect(html.match(/Got it/g)).toHaveLength(1);
  });

  it('puts a hairline above each release but the first, instead of separators', () => {
    expect(html).not.toContain('data-slot="separator"');
    const sections = html.match(/<section[^>]*data-slot="whats-new-release"[^>]*>/g) ?? [];
    expect(sections).toHaveLength(3);
    for (const tag of sections) {
      expect(tag).toContain('border-t');
      expect(tag).toContain('first:border-t-0');
    }
  });

  it('scrolls the list between the title and a 48 px full-width "Got it" with a rule above it', () => {
    const scroller = html.match(/<section[^>]*data-slot="whats-new-scroll"[^>]*>/)?.[0] ?? '';
    expect(scroller).toContain('overflow-y-auto');
    expect(scroller).toContain('px-4');
    expect(scroller).not.toContain('max-h-[70vh]'); // the sheet itself is capped
    const footer = html.match(/<div[^>]*data-slot="dialog-footer"[^>]*>/)?.[0] ?? '';
    expect(footer).toContain('border-t');
    const button = html.match(/<button\b[^>]*data-slot="button"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('h-12');
    expect(button).toContain('w-full');
    expect(html.indexOf('whats-new-scroll')).toBeLessThan(html.indexOf('>Got it<'));
  });

  it('gives a release screenshot an expand mark, full width, that opens it full screen on a tap', () => {
    expect(html).toMatch(/<button[^>]*aria-label="What changed in version 0\.13\.0: enlarge"/);
    expect(html).toMatch(/<img[^>]*alt="What changed in version 0\.13\.0"[^>]*class="[^"]*w-full/);
    expect(html.match(/data-slot="whats-new-expand"/g)).toHaveLength(1);
    const button = html.match(/<button[^>]*aria-label="What changed in[^>]*>/)?.[0] ?? '';
    expect(button).toContain('relative');
    expect(button).toContain('w-full');
  });

  it('leaves the Mac dialog as it was: no expand mark, a separator, the 70% list', () => {
    const dialog = render('dialog');
    expect(dialog).not.toContain('whats-new-expand');
    expect(dialog.match(/data-slot="separator"/g)).toHaveLength(2);
    expect(dialog).toContain('max-h-[70vh]');
    expect(dialog).not.toContain('first:border-t-0');
  });
});

type Props = Record<string, unknown> & { children?: ReactNode };

function sheet(overrides: { open?: boolean; releases?: readonly Release[] } = {}) {
  const onClose = vi.fn();
  const root = (WhatsNewDialog as unknown as (props: Props) => ReactElement<Props>)({
    open: true,
    releases,
    onClose,
    variant: 'sheet',
    ...overrides,
  });
  const content = root.props.children as ReactElement<Props>;
  const [handle, panel] = content.props.children as [ReactElement<Props>, ReactElement<Props>];
  return { root, content, handle, panel, onClose };
}

class FakeElement {
  isConnected = true;
  focus = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', { activeElement: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<WhatsNewDialog variant="sheet"> wiring', () => {
  it('is a bottom sheet, with no corner close button', () => {
    const { content } = sheet();
    expect(content.props.side).toBe('bottom');
    expect(content.props.showCloseButton).toBe(false);
  });

  it('is open when asked to be and there is something to show', () => {
    expect(sheet().root.props.open).toBe(true);
    expect(sheet({ open: false }).root.props.open).toBe(false);
    expect(sheet({ releases: [] }).root.props.open).toBe(false);
  });

  it('closes on Esc, a click outside or a swipe away (Radix asks to close), and not when opening', () => {
    const { root, onClose } = sheet();
    (root.props.onOpenChange as (open: boolean) => void)(true);
    expect(onClose).not.toHaveBeenCalled();
    (root.props.onOpenChange as (open: boolean) => void)(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is at most 700 px tall (less on a short phone), rounded on top, with a grab handle', () => {
    const { content } = sheet();
    const className = String(content.props.className);
    expect(className).toContain('max-h-[min(700px,calc(100dvh-1rem))]');
    expect(className).toContain('rounded-t-2xl');
    expect(className).toContain('env(safe-area-inset-bottom)');
  });

  it('has a grab handle that closes the sheet on a swipe down', () => {
    const { handle, onClose } = sheet();
    expect(handle.type).toBe(SheetGrabber);
    expect(handle.props.onClose).toBe(onClose);
  });

  it('hands the sheet panel the releases and the same onClose, in the sheet look', () => {
    const { panel, onClose } = sheet();
    expect(panel.props.releases).toBe(releases);
    expect(panel.props.onClose).toBe(onClose);
    expect(panel.props.variant).toBe('sheet');
  });

  it('"Got it" is the one button and calls onClose', () => {
    const { panel, onClose } = sheet();
    const inner = (WhatsNewPanel as unknown as (props: Props) => ReactElement<Props>)(panel.props);
    const buttons: ReactElement<Props>[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object' || !('props' in node)) return;
      const element = node as ReactElement<Props>;
      if (element.type === Button) buttons.push(element);
      walk(element.props.children);
    };
    walk(inner.props.children);
    expect(buttons).toHaveLength(1);
    const [gotItButton] = buttons as [ReactElement<Props>];
    (gotItButton.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts focus on the sheet itself when it opens, not on "Got it" (no ring nobody asked for)', () => {
    const { content, panel } = sheet();
    expect(panel.props.gotItRef).toBeUndefined();
    const sheetBox = { focus: vi.fn() };
    const opening = { preventDefault: vi.fn(), target: sheetBox };
    (content.props.onOpenAutoFocus as (e: unknown) => void)(opening);
    expect(opening.preventDefault).toHaveBeenCalled();
    expect(sheetBox.focus).toHaveBeenCalledTimes(1);
    expect(String(content.props.className)).toContain('outline-none');
  });

  it('gives focus back to whatever had it when the sheet opened', () => {
    const opener = new FakeElement();
    vi.stubGlobal('document', { activeElement: opener });
    const { content } = sheet();
    const closing = { preventDefault: vi.fn() };
    (content.props.onCloseAutoFocus as (e: unknown) => void)(closing);
    expect(closing.preventDefault).toHaveBeenCalled();
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });
});
