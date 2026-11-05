import { describe, expect, it, vi } from 'vitest';
import { renderCell, textOf } from '../cells/test-helpers';
import type { NowLook } from './now-look';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces
// for plain elements that keep the props this test cares about (width, disabled, busy).
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
    AlertDialogDescription: ({ children }: Props) =>
      h('p', { 'data-role': 'description' }, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ variant, disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', 'data-variant': variant, disabled }, children),
    AlertDialogAction: ({ disabled, children, ...rest }: Props) =>
      h('button', { 'data-role': 'confirm', disabled, 'aria-busy': rest['aria-busy'] }, children),
  };
});

const { USE_LOOK_DIALOG_TEXT, UseLookDialog } = await import('./UseLookDialog');

const NOW_JOB: NowLook = { kind: 'job', jobId: 'job-now', name: 'Coach intro reel' };

const dialog = (props: Partial<React.ComponentProps<typeof UseLookDialog>> = {}) =>
  renderCell(
    <UseLookDialog
      open
      client="Arc Fitness"
      jobId="job-new"
      jobName="Studio tour"
      now={NOW_JOB}
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

describe('<UseLookDialog>', () => {
  it('uses the words of the design canvas', () => {
    expect(USE_LOOK_DIALOG_TEXT).toMatchObject({
      cancel: 'Cancel',
      confirm: 'Use this look',
      now: 'Now',
      new: 'New',
      fromFiles: 'From your files',
    });
    // Names sit in their own <bdi>; the sentences read straight through them.
    const sentences = dialog().replace(/<[^>]*>/g, '');
    expect(sentences).toContain('Use this look for Arc Fitness?');
    expect(sentences).toContain(
      'The style for Arc Fitness is rewritten from the fonts, colours, titles, captions and graphics of Studio tour. The current style.md is kept in history, and finished jobs don’t change.',
    );
  });

  it('shows nothing while closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('is the board’s 520 px wide, spaced by 20 px', () => {
    const markup = dialog();
    expect(markup).toContain('data-[size=default]:sm:max-w-[520px]');
    expect(markup).toContain('gap-5');
    expect(markup).toContain('role="alertdialog"');
  });

  it('puts the client and the job in <bdi>, so a Hebrew name keeps its own direction in the English sentence', () => {
    const markup = dialog({ client: 'מרפאת מירה', jobName: 'טיפים להלבנת שיניים' });
    expect(markup).toContain('<h2>Use this look for <bdi>מרפאת מירה</bdi>?</h2>');
    expect(markup).toContain('<bdi>טיפים להלבנת שיניים</bdi>');
    expect(markup).toContain('from <bdi>טיפים להלבנת שיניים</bdi>');
  });

  describe('the stills', () => {
    it('shows the still of the job the look comes from (Now) and the still of this job (New), in that order', () => {
      expect(pictures(dialog())).toEqual(['/api/jobs/job-now/still', '/api/jobs/job-new/still']);
    });

    it('captions them "Now / from <source job>" and "New / from <this job>"', () => {
      const text = textOf(dialog());
      expect(text).toContain('Now from Coach intro reel New from Studio tour');
    });

    it('names each still for screen readers', () => {
      const markup = dialog();
      expect(markup).toContain('aria-label="Now look, from Coach intro reel"');
      expect(markup).toContain('aria-label="New look, from Studio tour"');
    });

    it('rings the New look, and only that one', () => {
      expect(dialog().match(/ring-2/g)).toHaveLength(1);
    });

    it('joins them with an arrow', () => {
      expect(dialog()).toContain('lucide-arrow-right');
    });

    it('loads them lazily, 112 × 199 and cropped to fill', () => {
      const markup = dialog();
      expect(markup.match(/loading="lazy"/g)).toHaveLength(2);
      expect(markup.match(/h-\[199px\] w-28/g)).toHaveLength(2);
      expect(markup.match(/object-cover/g)).toHaveLength(2);
    });

    it('shows a dashed "From your files" placeholder, not a picture, when the look has no source job', () => {
      const markup = dialog({ now: { kind: 'files' } });
      expect(pictures(markup)).toEqual(['/api/jobs/job-new/still']);
      expect(markup).toContain('border-dashed');
      expect(textOf(markup)).toContain('From your files');
      // Only "Now": there is no job to say it is from.
      expect(textOf(markup)).toContain('Now New from Studio tour');
    });

    it('waits for the client’s style before it knows what to show as Now: an empty frame, no picture', () => {
      const markup = dialog({ now: { kind: 'loading' } });
      expect(pictures(markup)).toEqual(['/api/jobs/job-new/still']);
      expect(markup).not.toContain('border-dashed');
      expect(markup).toContain('aria-label="Now look"');
    });

    it('shows no source when the style could not be read', () => {
      const markup = dialog({ now: { kind: 'unknown' } });
      expect(pictures(markup)).toEqual(['/api/jobs/job-new/still']);
      expect(markup).not.toContain('border-dashed');
    });

    it('asks for the still of a source job that has left the list, and just leaves its name out', () => {
      const markup = dialog({ now: { kind: 'job', jobId: 'job-gone', name: null } });
      expect(pictures(markup)).toEqual(['/api/jobs/job-gone/still', '/api/jobs/job-new/still']);
      expect(textOf(markup)).toContain('Now New from Studio tour');
    });

    it('covers a slow still with a skeleton only after the wait is noticeable', () => {
      expect(dialog({ skeletonDelayMs: 250 })).not.toContain('data-slot="skeleton"');
      expect(dialog({ skeletonDelayMs: 0 }).match(/data-slot="skeleton"/g)).toHaveLength(2);
    });

    it('covers the Now frame with a skeleton while the style is on its way, too', () => {
      const markup = dialog({ now: { kind: 'loading' }, skeletonDelayMs: 0 });
      expect(markup.match(/data-slot="skeleton"/g)).toHaveLength(2);
    });
  });

  describe('the buttons', () => {
    it('are Cancel (the outline button) and Use this look', () => {
      const markup = dialog();
      expect(markup).toMatch(/<button data-role="cancel" data-variant="outline">Cancel<\/button>/);
      expect(markup).toMatch(/<button data-role="confirm"[^>]*>Use this look<\/button>/);
      expect(markup).not.toContain('lucide-loader-circle');
    });

    it('turn off, and Use this look gets a spinner, while the request is on its way', () => {
      const markup = dialog({ saving: true });
      expect(markup.match(/disabled=""/g)).toHaveLength(2);
      expect(markup).toContain('aria-busy="true"');
      expect(markup).toContain('lucide-loader-circle');
      expect(textOf(markup)).toContain('Use this look');
    });
  });
});
