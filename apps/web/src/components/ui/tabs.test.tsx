import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TabsList, TabsTrigger } from './tabs';

type Handlers = {
  className: string;
  onPointerDown: (event: unknown) => void;
  onKeyDown: (event: unknown) => void;
  onBlur: (event: unknown) => void;
};

/** The element a TabsTrigger renders, to read its class and call its handlers (no hooks inside). */
function trigger(props: Record<string, unknown> = {}): ReactElement<Handlers> {
  return TabsTrigger({ value: 'all', ...props } as never) as ReactElement<Handlers>;
}

const fakeEvent = () => ({ currentTarget: { dataset: {} as Record<string, string> } });

describe('<TabsTrigger> focus ring', () => {
  it('has a grey keyboard-only ring: no blue outline, off while a mouse press is the reason for focus', () => {
    const { className } = trigger().props;
    expect(className).toContain('not-data-pointer:focus-visible:ring-[3px]');
    expect(className).toContain('not-data-pointer:focus-visible:border-ring');
    expect(className).toContain('outline-none');
    expect(className).not.toContain('outline-ring');
    // The ring colour is the neutral `ring` token (see index.css), never a literal blue.
    expect(className).not.toMatch(/blue|3b82f6/);
  });

  it('marks the tab on a pointer press, and clears the mark on a key press or on blur', () => {
    const { onPointerDown, onKeyDown, onBlur } = trigger().props;
    const event = fakeEvent();

    onPointerDown(event);
    expect(event.currentTarget.dataset).toHaveProperty('pointer');

    onKeyDown(event);
    expect(event.currentTarget.dataset).not.toHaveProperty('pointer');

    onPointerDown(event);
    onBlur(event);
    expect(event.currentTarget.dataset).not.toHaveProperty('pointer');
  });

  it('still calls the handlers the caller passes', () => {
    const calls = { pointer: vi.fn(), key: vi.fn(), blur: vi.fn() };
    const { onPointerDown, onKeyDown, onBlur } = trigger({
      onPointerDown: calls.pointer,
      onKeyDown: calls.key,
      onBlur: calls.blur,
    }).props;
    const event = fakeEvent();
    onPointerDown(event);
    onKeyDown(event);
    onBlur(event);
    expect(calls.pointer).toHaveBeenCalledWith(event);
    expect(calls.key).toHaveBeenCalledWith(event);
    expect(calls.blur).toHaveBeenCalledWith(event);
  });
});

/** The element a TabsList renders, to read its class and attributes (no hooks inside). */
function list(props: Record<string, unknown> = {}): ReactElement<Record<string, string>> {
  return TabsList({ ...props } as never) as ReactElement<Record<string, string>>;
}

/** The count span of a trigger, if it renders one. */
function countOf(props: Record<string, unknown>): ReactElement<{ className: string }> | undefined {
  const { children } = trigger(props).props as unknown as { children: unknown[] };
  return children.find(
    (child): child is ReactElement<{ className: string }> =>
      isValidElement(child) &&
      (child.props as Record<string, unknown>)['data-slot'] === 'tabs-trigger-count',
  );
}

describe('<TabsList>: variants', () => {
  it('is the muted track with 3 px of padding and a 36 px row by default', () => {
    const { className, 'data-variant': variant } = list().props;
    expect(variant).toBe('default');
    expect(className).toContain('bg-muted');
    expect(className).toContain('p-[3px]');
    expect(className).toContain('group-data-[orientation=horizontal]/tabs:h-9');
  });

  it('keeps the line variant: transparent, with a 4 px gap', () => {
    const { className, 'data-variant': variant } = list({ variant: 'line' }).props;
    expect(variant).toBe('line');
    expect(className).toContain('gap-1');
    expect(className).toContain('bg-transparent');
  });

  it('ghost: no track, no padding, a 2 px gap, a 32 px row', () => {
    const { className, 'data-variant': variant } = list({ variant: 'ghost' }).props;
    expect(variant).toBe('ghost');
    expect(className).toContain('bg-transparent');
    expect(className).toContain('gap-0.5');
    expect(className).toContain('p-0');
    expect(className).toContain('group-data-[orientation=horizontal]/tabs:h-8');
    // The default variant's track, padding and height are replaced, not just added to.
    expect(className).not.toContain('bg-muted');
    expect(className).not.toContain('p-[3px]');
    expect(className).not.toContain('group-data-[orientation=horizontal]/tabs:h-9');
  });
});

describe('<TabsTrigger> in a ghost list', () => {
  const ghost = (name: string) => `group-data-[variant=ghost]/tabs-list:${name}`;

  it('is a 32 px rounded text button with no border and no shadow', () => {
    const { className } = trigger().props;
    for (const name of ['h-8', 'rounded-lg', 'border-0']) expect(className).toContain(ghost(name));
    expect(className).toContain(ghost('data-[state=active]:shadow-none'));
  });

  it('is muted, brightens on hover with a faint fill, and takes the muted fill when active', () => {
    const { className } = trigger().props;
    expect(className).toContain(ghost('text-muted-foreground'));
    expect(className).toContain(ghost('hover:text-foreground'));
    expect(className).toContain(ghost('hover:bg-muted/50'));
    expect(className).toContain(ghost('data-[state=active]:bg-muted'));
    expect(className).toContain(ghost('data-[state=active]:text-foreground'));
    // And at the strength of the default tab's own dark fill, which would otherwise win.
    expect(className).toContain(`dark:${ghost('data-[state=active]:bg-muted')}`);
  });

  it('keeps the grey keyboard-only ring', () => {
    const { className } = trigger().props;
    expect(className).toContain('not-data-pointer:focus-visible:ring-[3px]');
    expect(className).not.toMatch(/blue|3b82f6/);
  });

  it('draws its count as a pill, and as plain muted text in a ghost list', () => {
    const className = countOf({ count: 12 })?.props.className ?? '';
    // The pill of the default and line variants is still there ...
    expect(className).toContain('rounded-full');
    expect(className).toContain('bg-zinc-700');
    expect(className).toContain('tabular-nums');
    // ... and a ghost list turns it into text: no fill, no height, no padding, muted, label size.
    for (const name of ['h-auto', 'min-w-0', 'rounded-none', 'bg-transparent', 'px-0', 'text-sm']) {
      expect(className).toContain(ghost(name));
    }
    expect(className).toContain(ghost('text-muted-foreground'));
    expect(className).toContain(ghost('group-data-[state=active]/tabs-trigger:bg-transparent'));
  });

  it('has no count span without a count', () => {
    expect(countOf({})).toBeUndefined();
  });
});
