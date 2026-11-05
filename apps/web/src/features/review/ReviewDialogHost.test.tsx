import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { renderReview } from './test-helpers';

// Same stand-ins as in ReviewDialog.test.tsx: a portal does not render on a server, and a lazy
// component shows its fallback.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogClose: ({ children }: Props) => children,
  };
});
vi.mock('./LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('./PreviewPlayer')).PreviewPlayer,
}));

const { ReviewDialogHost } = await import('./ReviewDialogHost');
const { createReviewDialogStore, reviewDialogStore } = await import('./review-dialog');

// A server render reads a store's initial state, so each test builds its store already in the state
// it wants to see.
const host = (store: ReturnType<typeof createReviewDialogStore>, jobs = REVIEW_ROW_JOBS) =>
  renderReview(<ReviewDialogHost jobs={jobs} store={store} />);

afterEach(() => reviewDialogStore.getState().reset());

describe('<ReviewDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host(createReviewDialogStore())).toBe('');
  });

  it('shows the dialog of the job that was asked for, with its name in the title', () => {
    const html = host(createReviewDialogStore({ jobId: 'r1', session: 1 }));
    expect(html).toContain('<h2>');
    expect(html).toContain('פרומו לסוף השבוע');
    expect(html).toContain('data-slot="preview-player"');
    expect(html).toContain('data-slot="review-notes"');
  });

  it('shows nothing for an id that is not in the list (there is no last job to fade out yet)', () => {
    expect(host(createReviewDialogStore({ jobId: 'not-here', session: 1 }))).toBe('');
  });

  it('shows nothing before the list has loaded', () => {
    const html = renderReview(
      <ReviewDialogHost
        jobs={undefined}
        store={createReviewDialogStore({ jobId: 'r1', session: 1 })}
      />,
    );
    expect(html).toBe('');
  });

  it('keeps the page-level store closed until a row asks', () => {
    expect(renderReview(<ReviewDialogHost jobs={REVIEW_ROW_JOBS} />)).toBe('');
  });
});
