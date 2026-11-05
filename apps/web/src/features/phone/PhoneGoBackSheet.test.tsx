import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';

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
          'data-slot': 'phone-go-back-sheet',
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

const { PhoneGoBackSheet } = await import('./PhoneGoBackSheet');
const { GoBackDialog } = await import('@/features/job-sheet/GoBackDialog');

const QUESTION = {
  title: 'Go back to Cut 2?',
  description: 'Cut 4 stays in Versions, so you can return to it.',
};

const sheet = (props: { open?: boolean; pending?: boolean } = {}) =>
  renderToStaticMarkup(
    <PhoneGoBackSheet
      open={props.open ?? true}
      question={QUESTION}
      pending={props.pending ?? false}
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );

/** The button whose words are `label`. */
const button = (html: string, label: string) =>
  html.match(
    new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`),
  )?.[0] ?? '';

describe('<PhoneGoBackSheet>', () => {
  it('is a bottom sheet in the phone shell, with a grabber and no close button of its own', () => {
    const html = sheet();
    expect(html).toContain('data-side="bottom"');
    expect(html).toContain('data-close-button="false"');
    expect(html).toContain('data-slot="sheet-grabber"');
    expect(html).toContain('rounded-t-2xl');
    expect(html).toContain('pb-[max(34px,var(--safe-bottom))]');
  });

  it('asks "Go back to Cut 2?" and says the current cut stays in Versions', () => {
    const html = sheet();
    expect(html).toContain('Go back to Cut 2?</h2>');
    expect(html).toContain('>Cut 4 stays in Versions, so you can return to it.</p>');
  });

  it('has a 48 px Go back with the undo icon, and a 48 px outline Cancel under it', () => {
    const html = sheet();
    const goBack = button(html, 'Go back');
    expect(goBack).toContain('h-12 w-full');
    expect(goBack).toContain('lucide-undo-2');
    expect(goBack).not.toContain('disabled=""');
    const cancel = button(html, 'Cancel');
    expect(cancel).toContain('data-variant="outline"');
    expect(cancel).toContain('h-12 w-full');
    expect(html.indexOf('>Cancel<')).toBeGreaterThan(html.indexOf('Go back</button>'));
  });

  it('turns Go back into a spinner with "Going back…" while the request is on its way', () => {
    const html = sheet({ pending: true });
    const goBack = button(html, 'Going back…');
    expect(goBack).toContain('disabled=""');
    expect(goBack).toContain('aria-busy="true"');
    expect(goBack).toContain('animate-spin');
    expect(button(html, 'Cancel')).toContain('disabled=""');
  });

  it('draws nothing while it is closed', () => {
    expect(sheet({ open: false })).toBe('');
  });
});

describe('<GoBackDialog variant="phone">', () => {
  const dialog = (variant: 'mac' | 'phone') =>
    renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <GoBackDialog
          target={2}
          current={4}
          pending={false}
          variant={variant}
          onOpenChange={() => {}}
          onConfirm={() => {}}
        />
      </QueryClientProvider>,
    );

  it('asks the same question in the bottom sheet instead of the dialog', () => {
    const html = dialog('phone');
    expect(html).toContain('data-slot="phone-go-back-sheet"');
    expect(html).toContain('Go back to Cut 2?');
    expect(html).toContain('Cut 4 stays in Versions, so you can return to it.');
    expect(html).not.toContain('alertdialog');
  });
});
