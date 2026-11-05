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

const { DeleteLutDialog } = await import('./DeleteLutDialog');

const dialog = (
  props: { open?: boolean; pending?: boolean; name?: string; lutsInEdits?: boolean } = {},
) =>
  renderToStaticMarkup(
    <DeleteLutDialog
      open={props.open ?? true}
      name={props.name ?? 'Golden Hour Warm'}
      lutsInEdits={props.lutsInEdits ?? true}
      pending={props.pending}
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );

describe('<DeleteLutDialog>', () => {
  it('asks "Delete “Name”?" and says what happens, in the board’s words', () => {
    const html = dialog();
    expect(html).toContain('Delete “<bdi>Golden Hour Warm</bdi>”?');
    expect(html).toContain(
      '<p>Jobs already made keep their look. Notes that name it stop working. It goes to the Trash, so you can get it back from there.</p>',
    );
  });

  it('drops the sentence about notes while notes cannot name a LUT yet', () => {
    const html = dialog({ lutsInEdits: false });
    expect(html).toContain(
      '<p>Jobs already made keep their look. It goes to the Trash, so you can get it back from there.</p>',
    );
    expect(html).not.toContain('Notes that name it');
  });

  it('lets the title and the name read in their own direction (a Hebrew name)', () => {
    const html = dialog({ name: 'סרט ישן' });
    expect(html).toContain('<h2 dir="auto">');
    expect(html).toContain('<bdi>סרט ישן</bdi>');
  });

  it('has Cancel as the outline button and a red Delete after it', () => {
    const html = dialog();
    expect(html.indexOf('data-role="delete"')).toBeGreaterThan(html.indexOf('data-role="cancel"'));
    expect(html).toMatch(/data-role="cancel" data-variant="outline"[^>]*>Cancel</);
    expect(html).toMatch(/data-role="delete" data-variant="destructive"[^>]*>Delete</);
  });

  it('is not drawn while closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('disables both buttons and says "Deleting…" while the engine works', () => {
    const html = dialog({ pending: true });
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Deleting…');
  });
});
