import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements that keep the props these tests care about (variant, disabled, busy).
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    AlertDialog: ({ open, children }: Props) =>
      open ? h('div', { 'data-open': '' }, children) : null,
    AlertDialogContent: ({ children }: Props) => h('div', { role: 'alertdialog' }, children),
    AlertDialogHeader: ({ children }: Props) => h('header', null, children),
    AlertDialogTitle: ({ children, dir }: Props) => h('h2', { dir: dir as string }, children),
    AlertDialogDescription: ({ children }: Props) => h('p', null, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ variant, disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', 'data-variant': variant, disabled }, children),
    AlertDialogAction: ({ variant, disabled, children, ...rest }: Props) =>
      h(
        'button',
        {
          'data-role': 'delete',
          'data-variant': variant,
          disabled,
          'aria-busy': rest['aria-busy'],
        },
        children,
      ),
  };
});

const { DeleteGraphicDialog } = await import('./DeleteGraphicDialog');

const dialog = (props: { open?: boolean; pending?: boolean; name?: string } = {}) =>
  renderToStaticMarkup(
    <DeleteGraphicDialog
      open={props.open ?? true}
      name={props.name ?? 'Name on a white pill'}
      pending={props.pending}
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );

describe('<DeleteGraphicDialog>', () => {
  it('asks "Delete “Name”?" and says what happens, in the board’s words', () => {
    const html = dialog();
    expect(html).toContain('Delete “<bdi>Name on a white pill</bdi>”?');
    expect(html).toContain(
      '<p>Edits stop using it. Videos already made keep it. It goes to the Trash, so you can get it back from there.</p>',
    );
  });

  it('lets the title and the name read in their own direction (a Hebrew name)', () => {
    const html = dialog({ name: 'מיתוס או אמת – פתיחה' });
    expect(html).toContain('<h2 dir="auto">');
    expect(html).toContain('<bdi>מיתוס או אמת – פתיחה</bdi>');
  });

  it('has Cancel as the outline button and Delete as the destructive one, in that order', () => {
    const html = dialog();
    const cancel = html.indexOf('data-role="cancel"');
    const del = html.indexOf('data-role="delete"');
    expect(cancel).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(cancel);
    expect(html).toMatch(/data-role="cancel" data-variant="outline"[^>]*>Cancel</);
    expect(html).toMatch(/data-role="delete" data-variant="destructive"[^>]*>Delete</);
  });

  it('is not drawn while closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('has both buttons enabled before the request', () => {
    const html = dialog();
    expect(html).not.toContain(' disabled=""');
    expect(html).not.toContain('aria-busy="true"');
  });

  it('shows a spinner and "Deleting…" on disabled buttons while the engine works', () => {
    const html = dialog({ pending: true });
    expect(html).toMatch(/data-role="cancel"[^>]*disabled=""/);
    expect(html).toMatch(/data-role="delete"[^>]*disabled=""[^>]*aria-busy="true"/);
    expect(html).toContain('animate-spin');
    expect(html).toContain('Deleting…');
    expect(html).not.toMatch(/>Delete</);
  });
});
