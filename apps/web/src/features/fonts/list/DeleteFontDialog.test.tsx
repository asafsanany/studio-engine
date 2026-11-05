import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { deleteBodyText } from './font-list';

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
    // asChild: the description is its only child, unchanged.
    AlertDialogDescription: ({ children }: Props) => children,
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

const { DeleteFontDialog } = await import('./DeleteFontDialog');

const AFTER =
  '<p>Videos already made keep it. A retry or a new round on those jobs would use another font, and notes that name it stop working. It goes to the Trash, so you can get it back from there.</p>';
const AFTER_PLAIN =
  '<p>Videos already made keep it. A retry or a new round on those jobs would use another font. It goes to the Trash, so you can get it back from there.</p>';

const dialog = (
  props: {
    open?: boolean;
    pending?: boolean;
    name?: string;
    used?: number;
    weights?: number[];
    inNotes?: boolean;
  } = {},
) => {
  const inNotes = props.inNotes ?? true;
  return renderToStaticMarkup(
    <DeleteFontDialog
      open={props.open ?? true}
      name={props.name ?? 'Heebo'}
      body={deleteBodyText(
        {
          used: props.used ?? 14,
          weights: props.weights ?? [100, 200, 300, 400, 500, 600, 700, 800, 900],
        },
        { inNotes },
      )}
      inNotes={inNotes}
      pending={props.pending}
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );
};

describe('<DeleteFontDialog>', () => {
  it('asks "Delete “Heebo”?" and says what happens, in the board’s words (14 jobs)', () => {
    const html = dialog();
    expect(html).toContain('Delete “<bdi>Heebo</bdi>”?');
    expect(html).toContain('<p>14 jobs use it. All 9 weights go.</p>');
    expect(html).toContain(AFTER);
  });

  it('says "1 job uses it." for one job', () => {
    const html = dialog({ used: 1 });
    expect(html).toContain('<p>1 job uses it. All 9 weights go.</p>');
    expect(html).toContain(AFTER);
  });

  it('says "Not used by any job yet." for none', () => {
    const html = dialog({ used: 0 });
    expect(html).toContain('<p>Not used by any job yet. All 9 weights go.</p>');
    expect(html).toContain(AFTER);
  });

  it('counts the weights the family has', () => {
    expect(dialog({ used: 2, weights: [400, 700] })).toContain(
      '<p>2 jobs use it. All 2 weights go.</p>',
    );
  });

  it('says only what goes, and nothing about notes, while notes cannot name a font yet', () => {
    const html = dialog({ inNotes: false });
    expect(html).toContain('<p>All 9 weights go.</p>');
    expect(html).toContain(AFTER_PLAIN);
    expect(html).not.toContain('use it.');
    expect(html).not.toContain('notes that name it');
  });

  it('lets the title and the name read in their own direction (a Hebrew name)', () => {
    const html = dialog({ name: 'דוד' });
    expect(html).toContain('<h2 dir="auto">');
    expect(html).toContain('<bdi>דוד</bdi>');
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
