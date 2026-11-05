import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { jobFeedKey, jobVersionsKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { makeJobVersion, type makeReviewNote } from '@/data/test-utils';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { clientWithNotes, renderReview } from '@/features/review/test-helpers';

// Draft & chat on the phone (DR8): a running job's chat full screen, and the chat in the notes panel
// of the phone Review.

vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, className, style, ...rest }: Props) =>
      h(
        'div',
        { role: 'dialog', class: className, style, 'data-slot': rest['data-slot'] },
        children,
      ),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children, className }: Props) =>
      h('p', { class: className, 'data-role': 'description' }, children),
    DialogClose: ({ children }: Props) => children,
  };
});

vi.mock('@/features/review/LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('@/features/review/PreviewPlayer')).PreviewPlayer,
}));

const { PhoneChatReview } = await import('./PhoneChatReview');
const { PhoneReviewHost } = await import('./PhoneReviewHost');
const { createReviewDialogStore } = await import('@/features/review/review-dialog');

const r1 = REVIEW_ROW_JOBS.find((job) => job.id === 'r1') as Job;

const FEED_ITEMS = [
  {
    id: 'L1',
    at: null,
    kind: 'run' as const,
    run: 'draft' as const,
    round: null,
    mode: 'start',
    endedAt: null,
    outcome: null,
    error: null,
    durationMs: null,
    notes: [],
  },
  { id: 'L2-0', at: null, kind: 'text' as const, text: 'Looking at the clips now.' },
  {
    id: 'L3-0-0',
    at: null,
    kind: 'images' as const,
    images: [{ name: 'L3-0-0.png', label: 'Strip A', path: null, wide: true }],
  },
];

function client(
  job: Job,
  notes = [] as ReturnType<typeof makeReviewNote>[],
  versions = [] as ReturnType<typeof makeJobVersion>[],
) {
  const queryClient = clientWithNotes(job.id, notes);
  queryClient.setQueryData(HEALTH_KEY, {
    ok: true,
    version: '0.57.0',
    settleMs: 60_000,
    series: false,
    jobSheet: true,
    analytics: false,
    phone: true,
    graphics: false,
    graphicsInEdits: false,
    music: false,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes: false,
    draftChat: true,
  });
  queryClient.setQueryData(jobFeedKey(job.id), { jobId: job.id, rev: 3, items: FEED_ITEMS });
  queryClient.setQueryData(jobVersionsKey(job.id), { versions });
  return queryClient;
}

describe('<PhoneChatReview>', () => {
  it('shows where cut 1 will play, the progress and Stop, the chat and why nothing can be sent', () => {
    const job: Job = { ...r1, state: 'editing', runKind: 'edit', step: 4, preview: null };
    const html = renderReview(
      <PhoneChatReview job={job} open onOpenChange={() => {}} />,
      client(job),
    );
    expect(html).toContain('data-slot="phone-chat"');
    expect(html).toContain('Drafting');
    expect(html).toContain('Cut 1 shows here when it’s ready.');
    // Claude's picture is in the chat only.
    expect(html.match(/feed\/img\/L3-0-0\.png/g)).toHaveLength(1);
    expect(html).toContain('data-stage="plan" data-state="running"');
    expect(html).toContain('Looking at the clips now.');
    expect(html).toContain('Send opens when cut 1 is ready.');
  });

  it('plays the cut a round changes while the round runs', () => {
    const job: Job = { ...r1, state: 'editing', runKind: 'revise', round: 1, step: 4 };
    const html = renderReview(
      <PhoneChatReview job={job} open onOpenChange={() => {}} />,
      client(job, [], [makeJobVersion(1, { current: true })]),
    );
    expect(html).not.toContain('data-slot="chat-stage"');
    expect(html).toContain(`/api/jobs/${job.id}/versions/1/preview/index.html`);
  });
});

describe('<PhoneReviewHost> with Draft & chat on', () => {
  it('shows the chat full screen while the job runs, and the phone Review once it is in Review', () => {
    const running: Job = { ...r1, state: 'editing', runKind: 'revise', round: 1, step: 4 };
    const store = createReviewDialogStore({ jobId: r1.id, session: 1 });
    const chatHtml = renderReview(
      <PhoneReviewHost jobs={[running]} store={store} />,
      client(running),
    );
    expect(chatHtml).toContain('data-slot="phone-chat"');
    expect(chatHtml).toContain('Round 1');
    // A review round has no Draft stages.
    expect(chatHtml).not.toContain('data-stage=');

    const reviewHtml = renderReview(<PhoneReviewHost jobs={[r1]} store={store} />, client(r1));
    expect(reviewHtml).toContain('data-slot="phone-review"');
    expect(reviewHtml).not.toContain('data-slot="phone-chat"');
  });
});
