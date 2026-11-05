import { describe, expect, it, vi } from 'vitest';
import { renderCell } from '@/features/jobs/cells/test-helpers';
import type { UseAsFormatTarget } from './use-as-format-dialog';

// Same stand-in for the Radix alert dialog as in the Use this look test: a portal does not render
// on a server.
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    AlertDialog: ({ open, children }: Props) =>
      open ? h('div', { 'data-open': '' }, children) : null,
    AlertDialogContent: ({ children, className }: Props) =>
      h('div', { role: 'alertdialog', className }, children),
    AlertDialogHeader: ({ children }: Props) => h('header', null, children),
    AlertDialogTitle: ({ children }: Props) => h('h2', null, children),
    AlertDialogDescription: ({ children }: Props) => h('p', null, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ variant, disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', 'data-variant': variant, disabled }, children),
    AlertDialogAction: ({ disabled, children, ...rest }: Props) =>
      h('button', { 'data-role': 'confirm', disabled, 'aria-busy': rest['aria-busy'] }, children),
  };
});

const { USE_AS_FORMAT_DIALOG_TEXT, UseAsFormatDialog } = await import('./UseAsFormatDialog');

const TARGET: UseAsFormatTarget = {
  jobId: 'episode-6',
  jobName: 'מיתוס או אמת 6',
  clientId: 'client-1',
  seriesId: 'series-1',
  seriesName: 'מיתוס או אמת',
  formatJobId: 'episode-5',
  formatJobName: 'מיתוס או אמת 5',
};

const dialog = (props: Partial<React.ComponentProps<typeof UseAsFormatDialog>> = {}) =>
  renderCell(
    <UseAsFormatDialog
      open
      target={TARGET}
      saving={false}
      onConfirm={() => {}}
      onOpenChange={() => {}}
      skeletonDelayMs={250}
      {...props}
    />,
  );

/** The `src` of every picture in the markup, in order. */
const pictures = (markup: string) =>
  [...markup.matchAll(/<img [^>]*src="([^"]*)"/g)].map((m) => m[1]);

const sentences = (markup: string) => markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');

describe('<UseAsFormatDialog>', () => {
  it('asks the question in words of its own, laid out like Use this look', () => {
    expect(USE_AS_FORMAT_DIALOG_TEXT).toEqual({
      cancel: 'Cancel',
      confirm: 'Use as format',
      now: 'Now',
      new: 'New',
    });
    const text = sentences(dialog());
    expect(text).toContain('Use מיתוס או אמת 6 as the format?');
    expect(text).toContain(
      'Later episodes of מיתוס או אמת are rebuilt from the composition of מיתוס או אמת 6 instead of מיתוס או אמת 5. The current series.md is kept in history, and finished episodes don’t change.',
    );
  });

  it('shows nothing while closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('is the 520 px wide dialog of Use this look, spaced by 20 px', () => {
    const markup = dialog();
    expect(markup).toContain('data-[size=default]:sm:max-w-[520px]');
    expect(markup).toContain('gap-5');
  });

  it('shows the format now (the job it comes from) and the one it would get, ringed', () => {
    const markup = dialog();
    expect(pictures(markup)).toEqual(['/api/jobs/episode-5/still', '/api/jobs/episode-6/still']);
    expect(markup).toContain('aria-label="Now format, from מיתוס או אמת 5"');
    expect(markup).toContain('aria-label="New format, from מיתוס או אמת 6"');
    expect(markup.match(/ring-2/g)).toHaveLength(1);
    expect(markup).toMatch(/>Now<\/span><span[^>]*>from <bdi>מיתוס או אמת 5<\/bdi>/);
    expect(markup).toMatch(/>New<\/span><span[^>]*>from <bdi>מיתוס או אמת 6<\/bdi>/);
  });

  it('puts every name in its own <bdi>, so a Hebrew name keeps its direction in the English sentence', () => {
    const markup = dialog();
    expect(markup).toContain('<bdi>מיתוס או אמת 6</bdi>');
    expect(markup).toContain('<bdi>מיתוס או אמת 5</bdi>');
    expect(markup).toContain('<bdi>מיתוס או אמת</bdi>');
  });

  it('has Cancel (outline) and Use as format, both on', () => {
    const markup = dialog();
    expect(markup).toMatch(/data-role="cancel" data-variant="outline">Cancel<\/button>/);
    expect(markup).toMatch(/data-role="confirm"[^>]*>Use as format<\/button>/);
    expect(markup).not.toContain('disabled');
  });

  it('shows a spinner and locks both buttons while the request is in flight', () => {
    const markup = dialog({ saving: true });
    expect(markup).toMatch(/data-role="confirm"[^>]*aria-busy="true"/);
    expect(markup.match(/ disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('animate-spin');
  });
});
