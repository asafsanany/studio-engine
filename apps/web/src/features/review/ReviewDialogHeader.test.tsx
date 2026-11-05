import { type JobFormat, jobFormatsOf } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import { createTestQueryClient, makeMusicView } from '@/data/test-utils';
import { renderReview } from './test-helpers';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements (a close button is the child it is given).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    DialogTitle: ({ children, className }: Props) => h('h2', { class: className }, children),
    DialogClose: ({ children }: Props) => children,
  };
});

const { ReviewDialogHeader } = await import('./ReviewDialogHeader');
const { REVIEW_DIALOG_TEXT } = await import('./review-text');

const JOB = { id: 'a1b2c3d4e5f6', name: 'Spring promo', client: 'Kova Coffee', round: 1 };

// The header holds the Music button (Soundtrack), which reads the job's music: it needs a query client.
const header = (job = JOB) => renderReview(<ReviewDialogHeader job={job} />);

describe('<ReviewDialogHeader>', () => {
  it('offers Export MP4 before Approve, as an enabled button', () => {
    const markup = header();
    expect(markup).toContain(REVIEW_DIALOG_TEXT.exportMp4);
    expect(markup).toMatch(/<button data-slot="review-export"(?![^>]*disabled="")[^>]*>/);
  });

  // Formats (C65): on a job with two formats the button exports the format on show, and says which.
  it('says Export MP4 with no size on a job with one format', () => {
    const markup = header();
    expect(markup).toContain('>Export MP4</span>');
    expect(markup).not.toContain('Export MP4 ·');
  });

  it('says the size of the format on show on a job with two formats', () => {
    const [main, square] = jobFormatsOf(['1080x1920', '1080x1080']) as [JobFormat, JobFormat];
    const onMain = renderReview(
      <ReviewDialogHeader job={JOB} exportFormat={{ id: null, label: main.label }} />,
    );
    expect(onMain).toContain('>Export MP4 · 9:16</span>');
    expect(onMain).toMatch(/<button data-slot="review-export"(?![^>]*disabled="")[^>]*>/);
    const onSquare = renderReview(
      <ReviewDialogHeader job={JOB} exportFormat={{ id: square.id, label: square.label }} />,
    );
    expect(onSquare).toContain('>Export MP4 · 1:1</span>');
    expect(onSquare).not.toContain('9:16');
  });

  it('is a 60 px bar with a bottom border and the board’s padding', () => {
    expect(header()).toMatch(
      /<div data-slot="review-header" class="@container flex h-\[60px\] shrink-0 items-center gap-3 border-b pr-3 pl-5">/,
    );
  });

  it('puts the job in the title and the client after a dot, each in its own direction', () => {
    const markup = header();
    expect(markup).toMatch(
      /<h2 class="[^"]*font-semibold"><span dir="auto" class="[^"]*\bbidi\b[^"]*">Spring promo<\/span><\/h2>/,
    );
    expect(markup).toMatch(/<span aria-hidden="true" class="text-muted-foreground">·<\/span>/);
    expect(markup).toMatch(
      /<span dir="auto" class="[^"]*\bbidi\b[^"]*text-muted-foreground">Kova Coffee<\/span>/,
    );
    expect(markup.indexOf('Spring promo')).toBeLessThan(markup.indexOf('Kova Coffee'));
  });

  it('shows a Hebrew name as it is', () => {
    const markup = header({
      id: 'a1b2c3d4e5f6',
      name: 'פרומו לסוף השבוע',
      client: 'מאפיית הצפון',
      round: 1,
    });
    expect(markup).toContain('>פרומו לסוף השבוע</span>');
    expect(markup).toContain('>מאפיית הצפון</span>');
  });

  it('has the “Live preview” badge with the green dot, as a button that carries the tooltip', () => {
    const markup = header();
    const at = markup.indexOf('Live preview');
    const button = markup.slice(
      markup.lastIndexOf('<button', at),
      at + 'Live preview</button>'.length,
    );
    expect(button).toMatch(/^<button type="button"/);
    expect(button).toContain('data-variant="outline"');
    expect(button).toContain('cursor-help');
    // Only the grey ring shows on a keyboard focus, not the browser's own outline as well.
    expect(button).toContain('outline-none');
    expect(button).toMatch(/<span[^>]*bg-status-ready[^>]*><\/span>Live preview<\/button>$/);
  });

  it('lets “Manual edit” give up its words in a narrow dialog, so the name and the client keep the room', () => {
    const markup = header();
    // The header is a container; below 800 px the label is for screen readers only and the tag is gone.
    expect(markup).toContain('class="@container flex');
    expect(markup).toContain('<span class="@max-[800px]:sr-only">Manual edit</span>');
    expect(markup).toMatch(/@max-\[800px\]:hidden">Soon<\/span>/);
  });

  it('has the disabled “Manual edit” button with the “Soon” tag', () => {
    const markup = header();
    const button = markup.slice(markup.lastIndexOf('<button', markup.indexOf('Manual edit')));
    expect(button).toMatch(/^<button[^>]*disabled=""/);
    expect(button).toContain('lucide-square-pen');
    expect(button).toMatch(/Manual edit<\/span><span[^>]*>Soon<\/span>/);
  });

  it('wraps the disabled button in a focusable span, because a disabled button has no tooltip', () => {
    const markup = header();
    const button = markup.indexOf('<button data-slot="button" data-variant="outline"');
    expect(button).toBeGreaterThan(-1);
    const wrapper = markup.slice(markup.lastIndexOf('<span', button), button);
    expect(wrapper).toMatch(/^<span tabindex="0"[^>]*cursor-default/);
  });

  it('has a Close button named Close, with the X icon', () => {
    const markup = header();
    expect(markup).toMatch(/<button[^>]*aria-label="Close"[^>]*><svg[^>]*lucide-x/);
    expect(markup).toContain('data-size="icon-sm"');
    expect(markup).toContain('data-variant="ghost"');
  });

  it('has no Music button while Soundtrack is off', () => {
    expect(header()).not.toContain('data-slot="music-button"');
  });

  it('has the Music button between the badge and “Manual edit” while the job has music', () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, {
      ok: true,
      version: '0.0.0',
      settleMs: 60_000,
      series: false,
      jobSheet: true,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
      music: true,
      luts: false,
      lutsInEdits: false,
      fonts: false,
      fontsInNotes: false,
    });
    queryClient.setQueryData(musicKey(JOB.id), makeMusicView({ picked: 'v1' }));
    const markup = renderReview(<ReviewDialogHeader job={JOB} />, queryClient);
    expect(markup.indexOf('Live preview')).toBeLessThan(markup.indexOf('data-slot="music-button"'));
    expect(markup.indexOf('data-slot="music-button"')).toBeLessThan(markup.indexOf('Manual edit'));
    expect(markup).toContain('>v1</span>');
  });

  it('uses tooltips and not title attributes', () => {
    expect(header()).not.toContain('title=');
  });

  it('says its words from one place', () => {
    expect(REVIEW_DIALOG_TEXT).toMatchObject({
      livePreview: 'Live preview',
      livePreviewTip: 'This plays the live edit. The final video renders after you approve.',
      manualEdit: 'Manual edit',
      soon: 'Soon',
      manualEditTip: 'The manual editing page comes later',
      close: 'Close',
      closeTip: 'Close (Esc)',
      notes: 'Notes',
      left: 'This job is no longer in Review.',
    });
  });
});
