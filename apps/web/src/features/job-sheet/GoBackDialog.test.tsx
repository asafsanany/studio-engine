import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces
// for plain elements that keep the props this test cares about (variant, disabled, busy).
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    AlertDialog: ({ open, children }: Props) =>
      open ? h('div', { 'data-open': '' }, children) : null,
    AlertDialogContent: ({ children }: Props) => h('div', { role: 'alertdialog' }, children),
    AlertDialogHeader: ({ children }: Props) => h('header', null, children),
    AlertDialogTitle: ({ children }: Props) => h('h2', null, children),
    AlertDialogDescription: ({ children }: Props) => h('p', null, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ variant, disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', 'data-variant': variant, disabled }, children),
    AlertDialogAction: ({ variant, disabled, children, ...rest }: Props) =>
      h(
        'button',
        {
          'data-role': 'go-back',
          'data-variant': variant,
          disabled,
          'aria-busy': rest['aria-busy'],
        },
        children,
      ),
  };
});

const { GoBackDialog } = await import('./GoBackDialog');

const dialog = (props: { target?: number | null; pending?: boolean } = {}) =>
  renderToStaticMarkup(
    <GoBackDialog
      target={props.target === undefined ? 2 : props.target}
      current={4}
      pending={props.pending ?? false}
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );

describe('<GoBackDialog>', () => {
  it('asks "Go back to Cut 2?" and says the current cut stays in Versions', () => {
    const html = dialog();
    expect(html).toContain('<h2>Go back to Cut 2?</h2>');
    expect(html).toContain('<p>Cut 4 stays in Versions, so you can return to it.</p>');
  });

  it('has a Cancel outline button and a default Go back button', () => {
    const html = dialog();
    expect(html).toMatch(/<button[^>]*data-role="cancel"[^>]*data-variant="outline"[^>]*>Cancel</);
    const goBack = html.match(/<button[^>]*data-role="go-back"[^>]*>.*?<\/button>/)?.[0] ?? '';
    expect(goBack).toContain('>Go back<');
    expect(goBack).not.toContain('data-variant="destructive"');
    expect(goBack).not.toContain('disabled');
  });

  it('turns Go back into a spinner and "Going back…" while the request is on its way', () => {
    const html = dialog({ pending: true });
    const goBack = html.match(/<button[^>]*data-role="go-back"[^>]*>.*?<\/button>/)?.[0] ?? '';
    expect(goBack).toContain('disabled');
    expect(goBack).toContain('aria-busy="true"');
    expect(goBack).toContain('animate-spin');
    expect(goBack).toContain('Going back…');
    expect(html).toMatch(/<button[^>]*data-role="cancel"[^>]*disabled/);
  });

  it('draws nothing while it is closed', () => {
    expect(dialog({ target: null })).toBe('');
  });
});
