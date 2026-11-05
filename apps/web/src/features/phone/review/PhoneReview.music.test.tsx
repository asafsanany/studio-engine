import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import { makeMusicVersion, makeMusicView } from '@/data/test-utils';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { clientWithNotes, renderReview, tagWith } from '@/features/review/test-helpers';

// The phone's Review with Soundtrack on: the Music button in the top bar before Close, the player
// that follows the music's rev, and Approve that waits while a version is being made.

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements that keep what this test reads.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, className, style, tabIndex, ...rest }: Props) =>
      h(
        'div',
        { role: 'dialog', class: className, style, tabIndex, 'data-slot': rest['data-slot'] },
        children,
      ),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children, className }: Props) =>
      h('p', { class: className, 'data-role': 'description' }, children),
    DialogClose: ({ children }: Props) => children,
  };
});

// A server render shows a lazy component's fallback, so the lazy player is the real one here.
vi.mock('@/features/review/LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('@/features/review/PreviewPlayer')).PreviewPlayer,
}));

const { PhoneReview } = await import('./PhoneReview');
const { createReviewDialogStore } = await import('@/features/review/review-dialog');

const r1 = REVIEW_ROW_JOBS.find((job) => job.id === 'r1') as Job;

const v2 = makeMusicView({
  picked: 'v2',
  versions: [makeMusicVersion(1), makeMusicVersion(2)],
  rev: 1_792_700_000_456,
});

function phoneReview(music: typeof v2 | null | undefined, { on = true, round = 0 } = {}) {
  const queryClient = clientWithNotes('r1', []);
  queryClient.setQueryData(HEALTH_KEY, {
    ok: true,
    version: '0.0.0',
    settleMs: 60_000,
    series: false,
    jobSheet: true,
    analytics: false,
    phone: true,
    graphics: false,
    graphicsInEdits: false,
    music: on,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
  });
  if (music !== undefined) queryClient.setQueryData(musicKey('r1'), music);
  return renderReview(
    <PhoneReview
      job={{ ...r1, round }}
      open
      onOpenChange={() => {}}
      store={createReviewDialogStore()}
      done={null}
      onSubmitted={() => {}}
    />,
    queryClient,
  );
}

describe('<PhoneReview> with music', () => {
  it('has the Music button in the top bar, before Close', () => {
    const html = phoneReview(v2);
    const header = html.slice(
      html.indexOf('data-slot="phone-review-header"'),
      html.indexOf('</header>'),
    );
    expect(tagWith(header, 'data-slot="phone-music-button"')).toContain('aria-label="Music, v2"');
    expect(header.indexOf('data-slot="phone-music-button"')).toBeLessThan(
      header.indexOf('aria-label="Close"'),
    );
  });

  it('has no Music button for a job without music, or while Soundtrack is off', () => {
    expect(phoneReview(null)).not.toContain('data-slot="phone-music-button"');
    expect(phoneReview(v2, { on: false })).not.toContain('data-slot="phone-music-button"');
  });

  it('waits for the small preview video when it opens, as without music', () => {
    // A server render is the first moment of an opening: the MP4 is asked for and not ready yet.
    for (const html of [phoneReview(v2), phoneReview(null), phoneReview(v2, { on: false })]) {
      expect(html).toContain('data-slot="preview-video-making"');
    }
  });

  it('has no Approve button: its line says where Approve is, with the music, and no hint', () => {
    const html = phoneReview(v2);
    expect(html).not.toContain('data-action="approve"');
    expect(tagWith(html, 'data-slot="phone-review-approve"')).toContain('role="status"');
    expect(html).toContain(
      'Happy with it? Press and hold the job in the list and choose Approve to render the final video, with music v2.</p>',
    );
    expect(html).not.toContain('data-slot="phone-review-hint"');
  });

  it('says Approve waits while a version is being made', () => {
    const html = phoneReview({
      ...v2,
      making: { id: 'v3', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
    });
    expect(html).not.toContain('data-action="approve"');
    expect(html).toContain('Music v3 is still being made. Approve when it is ready.</p>');
  });
});
