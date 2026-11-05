import { describe, expect, it, vi } from 'vitest';
import { renderCell } from './test-helpers';

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
      h('button', { 'data-role': 'keep', 'data-variant': variant, disabled }, children),
    AlertDialogAction: ({ variant, disabled, children, ...rest }: Props) =>
      h(
        'button',
        { 'data-role': 'stop', 'data-variant': variant, disabled, 'aria-busy': rest['aria-busy'] },
        children,
      ),
  };
});

const { CANCEL_DIALOG_TEXT, CancelDialog } = await import('./CancelDialog');

const dialog = (
  props: { open?: boolean; pending?: boolean; note?: { title: string; description: string } } = {},
) =>
  renderCell(
    <CancelDialog
      open={props.open ?? true}
      pending={props.pending ?? false}
      note={props.note}
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  );

describe('<CancelDialog>', () => {
  it('uses the words of the design canvas', () => {
    expect(CANCEL_DIALOG_TEXT).toMatchObject({
      title: 'Stop this edit?',
      description: 'Finished steps are kept, so you can resume later.',
      keep: 'Keep editing',
      stop: 'Stop edit',
    });
    const markup = dialog();
    expect(markup).toContain('<h2>Stop this edit?</h2>');
    expect(markup).toContain('<p>Finished steps are kept, so you can resume later.</p>');
  });

  it('has "Keep editing" as the outline button and "Stop edit" as the destructive one, in that order', () => {
    const markup = dialog();
    const keep = markup.indexOf('data-role="keep"');
    const stop = markup.indexOf('data-role="stop"');
    expect(keep).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(keep);
    expect(markup).toMatch(/data-role="keep" data-variant="outline"[^>]*>Keep editing</);
    expect(markup).toMatch(/data-role="stop" data-variant="destructive"[^>]*>Stop edit</);
  });

  it('is not rendered while closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('has both buttons enabled before the request', () => {
    expect(dialog()).not.toContain(' disabled=""');
    expect(dialog()).not.toContain('aria-busy="true"');
  });

  it('shows a spinner and "Stopping…" on a disabled Stop button while the request runs', () => {
    const markup = dialog({ pending: true });
    expect(markup).toMatch(/data-role="stop"[^>]*disabled=""[^>]*aria-busy="true"/);
    expect(markup).toContain('lucide-loader-circle');
    expect(markup).toContain('animate-spin');
    expect(markup).toContain('Stopping…');
    expect(markup).not.toContain('>Stop edit<');
    // "Keep editing" is disabled too: the stop is already under way.
    expect(markup).toMatch(/data-role="keep"[^>]*disabled=""/);
  });

  describe('with a note', () => {
    const note = { title: 'Nothing to stop', description: 'This edit is no longer running.' };

    it('replaces the question with the note and a single OK button', () => {
      const markup = dialog({ note });
      expect(markup).toContain('<h2>Nothing to stop</h2>');
      expect(markup).toContain('<p>This edit is no longer running.</p>');
      expect(markup).toContain('>OK<');
      expect(markup).not.toContain('Stop this edit?');
      expect(markup).not.toContain('Keep editing');
      expect(markup).not.toContain('Stop edit');
      expect(markup.match(/<button/g)).toHaveLength(1);
    });

    it('is the question again without one', () => {
      expect(dialog({ note: undefined })).toContain('Stop this edit?');
    });
  });
});
