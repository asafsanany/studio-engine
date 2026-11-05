import type { Release } from '@studio/shared';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { WhatsNewDialog, WhatsNewPanel } from './WhatsNewDialog';

// There is no DOM in these tests, so the dialog is called as a plain function to read what it hands
// to Radix: its props and handlers. That needs hooks that work outside a render: a ref is a plain
// object and an effect runs at once.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void) => {
    effect();
  },
}));

const release = (version: string): Release => ({
  version,
  date: '2026-10-22',
  items: [`Change in ${version}.`],
});
const releases = [release('0.1.2'), release('0.1.1')];

type Props = Record<string, unknown> & { children?: ReactNode };

/** The element a function component returns when it is called directly. */
function call(component: (props: never) => unknown, props: Props): ReactElement<Props> {
  return component(props as never) as ReactElement<Props>;
}

/** Every element in a tree of already-created elements (function components are not run). */
function elementsIn(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (node === null || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elementsIn(element.props.children)];
}

function dialog(overrides: { open?: boolean; releases?: readonly Release[] } = {}) {
  const onClose = vi.fn();
  const root = call(WhatsNewDialog as never, {
    open: true,
    releases,
    onClose,
    ...overrides,
  });
  const content = root.props.children as ReactElement<Props>;
  const panel = content.props.children as ReactElement<Props>;
  return { root, content, panel, onClose };
}

const event = () => ({ preventDefault: vi.fn() });

/** Something that can hold focus, standing in for an HTML element. */
class FakeElement {
  isConnected = true;
  focus = vi.fn();
}

// The effect that remembers the opener reads the page's focused element.
beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', { activeElement: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<WhatsNewDialog> wiring', () => {
  it('is open when asked to be and there is something to show', () => {
    expect(dialog().root.props.open).toBe(true);
    expect(dialog({ open: false }).root.props.open).toBe(false);
    expect(dialog({ releases: [] }).root.props.open).toBe(false);
  });

  it('Esc and a click outside (Radix asks to close) call onClose', () => {
    const { root, onClose } = dialog();
    (root.props.onOpenChange as (open: boolean) => void)(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when Radix says it is opening', () => {
    const { root, onClose } = dialog();
    (root.props.onOpenChange as (open: boolean) => void)(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has no corner close button: "Got it" is the one way to dismiss, besides Esc and a click outside', () => {
    expect(dialog().content.props.showCloseButton).toBe(false);
  });

  it('hands the panel the releases and the same onClose', () => {
    const { panel, onClose } = dialog();
    expect(panel.props.releases).toBe(releases);
    expect(panel.props.onClose).toBe(onClose);
  });

  it('"Got it" calls onClose', () => {
    const { panel, onClose } = dialog();
    const buttons = elementsIn(call(WhatsNewPanel as never, panel.props).props.children).filter(
      (element) => element.type === Button,
    );
    expect(buttons).toHaveLength(1);
    const gotIt = buttons[0] as ReactElement<Props>;
    expect(gotIt.props.children).toBe('Got it');
    (gotIt.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus to "Got it" when the dialog opens, instead of the first control Radix finds', () => {
    const { content, panel } = dialog();
    const gotIt = { focus: vi.fn() };
    (panel.props.gotItRef as { current: unknown }).current = gotIt;

    const opening = event();
    (content.props.onOpenAutoFocus as (e: unknown) => void)(opening);
    expect(opening.preventDefault).toHaveBeenCalled();
    expect(gotIt.focus).toHaveBeenCalledTimes(1);
  });

  it('gives focus back to whatever had it when the dialog opened', () => {
    const opener = new FakeElement();
    vi.stubGlobal('document', { activeElement: opener });

    const { content } = dialog();
    const closing = event();
    (content.props.onCloseAutoFocus as (e: unknown) => void)(closing);
    expect(closing.preventDefault).toHaveBeenCalled();
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it('does not focus an opener that has left the page', () => {
    const opener = new FakeElement();
    opener.isConnected = false;
    vi.stubGlobal('document', { activeElement: opener });

    const { content } = dialog();
    (content.props.onCloseAutoFocus as (e: unknown) => void)(event());
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it('eases in and out and keeps the box inside a short window', () => {
    const className = String(dialog().content.props.className);
    expect(className).toContain('ease-in-out');
    expect(className).toContain('flex-col');
    expect(className).toContain('max-h-[calc(100dvh-2rem)]');
  });
});
