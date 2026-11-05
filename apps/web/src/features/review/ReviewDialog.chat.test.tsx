import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { jobFeedKey, jobVersionsKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { makeJobVersion, makeReviewNote } from '@/data/test-utils';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { clientWithNotes, renderReview, tagWith } from './test-helpers';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements that keep the props this test cares about (the size, the classes, the marker).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, className, style, tabIndex, ...rest }: Props) =>
      h(
        'div',
        {
          role: 'dialog',
          class: className,
          style,
          tabIndex,
          'data-review-dialog': rest['data-review-dialog'],
          'data-close-button': String(rest.showCloseButton),
        },
        children,
      ),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children, className }: Props) =>
      h('p', { class: className, 'data-role': 'description' }, children),
    DialogClose: ({ children }: Props) => children,
  };
});

// A server render shows a lazy component's fallback, so the lazy player is the real one here.
vi.mock('./LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('./PreviewPlayer')).PreviewPlayer,
}));

const { ReviewDialog } = await import('./ReviewDialog');

const r1 = REVIEW_ROW_JOBS.find((job) => job.id === 'r1');
if (!r1) throw new Error('no r1 in the fixtures');

// Draft & chat (DR7): with the switch on, the notes column is the job's chat and the dialog shows a
// running job too.

const HEALTH = {
  ok: true,
  version: '0.57.0',
  settleMs: 60_000,
  series: false,
  jobSheet: true,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

const FEED = {
  jobId: r1.id,
  rev: 9,
  items: [
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
    { id: 'L2-0', at: null, kind: 'text' as const, text: 'Still reviewing the clips.' },
    {
      id: 'L3-0-0',
      at: null,
      kind: 'images' as const,
      images: [
        { name: 'L3-0-0.png', label: 'Cut sheet', path: 'edit/verify/cuts_sheet.png', wide: true },
      ],
    },
  ],
};

function client(
  job: Job,
  draftChat: boolean,
  notes = [] as ReturnType<typeof makeReviewNote>[],
  versions = [] as ReturnType<typeof makeJobVersion>[],
) {
  const queryClient = clientWithNotes(job.id, notes);
  queryClient.setQueryData(HEALTH_KEY, { ...HEALTH, draftChat });
  queryClient.setQueryData(jobFeedKey(job.id), { ...FEED, jobId: job.id });
  queryClient.setQueryData(jobVersionsKey(job.id), { versions });
  return queryClient;
}

const dialog = (job: Job, queryClient = client(job, true)) =>
  renderReview(<ReviewDialog job={job} open onOpenChange={() => {}} />, queryClient);

const drafting: Job = { ...r1, state: 'editing', runKind: 'edit', step: 2, preview: null };

describe('<ReviewDialog> with Draft & chat on', () => {
  it('is the job’s chat while the Draft runs: where cut 1 will play, the progress, Stop, and nothing to send', () => {
    const html = dialog(drafting);
    expect(html).toContain('data-slot="review-chat"');
    expect(html).not.toContain('data-slot="review-notes"');
    // Before cut 1 the player's place says so; Claude's pictures are in the chat, not there.
    expect(tagWith(html, 'data-slot="chat-stage"')).toBeTruthy();
    expect(html).toContain('Cut 1 shows here when it’s ready.');
    expect(html.match(/feed\/img\/L3-0-0\.png/g)).toHaveLength(1);
    expect(html).toContain('Still reviewing the clips.');
    // The progress box with the Draft's stages, the badge, and the waiting composer and footer.
    expect(html).toContain('data-slot="draft-progress"');
    expect(html).toContain('data-stage="footage" data-state="running"');
    expect(html).toContain('data-slot="review-running"');
    expect(html).toContain('Drafting');
    expect(html).toContain('data-slot="chat-composer-waits"');
    expect(html).toContain('Send opens when cut 1 is ready.');
    expect(html).not.toContain('Approve</button>');
  });

  it('plays the cut a round changes while the round runs, not the newest picture', () => {
    const round: Job = { ...r1, state: 'editing', runKind: 'revise', round: 1, step: 4 };
    const versions = [makeJobVersion(2), makeJobVersion(1, { current: true })];
    const html = dialog(round, client(round, true, [], versions));
    expect(html).not.toContain('data-slot="chat-stage"');
    expect(html).toContain(`/api/jobs/${round.id}/versions/1/preview/index.html`);
    expect(html).toContain('data-slot="draft-progress"');
  });

  it('plays the live preview in a round of a job from before versions', () => {
    const round: Job = { ...r1, state: 'editing', runKind: 'revise', round: 1, step: 4 };
    const html = dialog(round, client(round, true, [], []));
    expect(html).not.toContain('data-slot="chat-stage"');
    expect(html).toContain(`/api/jobs/${round.id}/preview/index.html?r=1`);
  });

  it('is 80 px wider than the notes dialog, for the 440 px chat', () => {
    expect(tagWith(dialog(r1), 'data-review-dialog')).toContain('width:817px');
  });

  it('in Review: the player, the chat with the notes that wait for Send, the note box and Approve', () => {
    const note = makeReviewNote({ jobId: r1.id, atSec: 4, text: 'Shorter hook' });
    const html = dialog(r1, client(r1, true, [note]));
    expect(html).toContain('data-slot="review-chat"');
    expect(html).not.toContain('data-slot="chat-stage"');
    expect(html).not.toContain('data-slot="draft-progress"');
    expect(html).toContain('Not sent yet');
    expect(html).toContain('Shorter hook');
    expect(html).not.toContain('data-slot="chat-composer-waits"');
    expect(html).toContain('Send 1 note');
  });

  it('is the notes dialog as before with the switch off', () => {
    const html = dialog(r1, client(r1, false));
    expect(html).toContain('data-slot="review-notes"');
    expect(html).not.toContain('data-slot="review-chat"');
    expect(tagWith(html, 'data-review-dialog')).toContain('width:737px;height:868px');
  });
});
