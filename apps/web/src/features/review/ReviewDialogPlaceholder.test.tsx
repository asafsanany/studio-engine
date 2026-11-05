import { describe, expect, it, vi } from 'vitest';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { renderReview } from './test-helpers';

// Same stand-in for the Radix dialog as in ReviewDialog.test.tsx. The player is NOT swapped here:
// a server render shows a lazy component's fallback, which is what this file looks at.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', null, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogClose: ({ children }: Props) => children,
  };
});

const { ReviewDialog } = await import('./ReviewDialog');

describe('<ReviewDialog> while the player’s code loads', () => {
  it('holds the player’s place with a black box of the same size: video + the 76 px controls', () => {
    const r1 = REVIEW_ROW_JOBS.find((job) => job.id === 'r1');
    if (!r1) throw new Error('no r1 in the fixtures');
    const html = renderReview(<ReviewDialog job={r1} open onOpenChange={() => {}} />);

    const at = html.indexOf('data-slot="preview-player-placeholder"');
    expect(at).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
    // 1080×1920 in a 1440×900 window: a 375×666 video, and the controls under it.
    expect(tag).toContain('width:375px;height:742px');
    expect(tag).toContain('bg-black');
    expect(tag).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-slot="preview-player"');
    // The notes panel and the footer are already there, so nothing moves when the player arrives.
    expect(html).toContain('data-slot="review-notes"');
    expect(html).toContain('data-slot="review-footer"');
  });
});
