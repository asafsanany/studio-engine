import { JOB_STATES, type Job } from '@studio/shared';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { canvasJob, renderCell, textOf } from './cells/test-helpers';
import { FailedDetail, JobDetail, WRITING_NOTE_DETAIL } from './JobDetail';
import { noteDialogStore } from './note-dialog';
import { NOW, REVIEW_ROW_JOBS } from './test-jobs';

// Which clock each row asks for. The real hook stays in place; the calls are written down.
const intervals = vi.hoisted(() => [] as (number | undefined)[]);
vi.mock('@/components/jobs/use-now', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/jobs/use-now')>();
  return {
    ...actual,
    useNow: (intervalMs?: number) => {
      intervals.push(intervalMs);
      return actual.useNow(intervalMs);
    },
  };
});

// The arriving countdown reads the clock; hold it at the canvas's "now" (13:42:00).
beforeAll(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  intervals.length = 0;
});

const detail = (job: Job) => renderCell(<JobDetail job={job} />);
const text = (job: Job) => textOf(detail(job));
const reviewJob = (id: string) => {
  const job = REVIEW_ROW_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no review-board job ${id}`);
  return job;
};

describe('<JobDetail>: one line for each state, with the canvas data', () => {
  it('arriving: "Arriving · settles in 0:42"', () => {
    expect(text(canvasJob('j1'))).toBe('Arriving · settles in 0:42');
  });

  it('queued: "Queued · #1 in line" and "#2 in line"', () => {
    expect(text(canvasJob('j4'))).toBe('Queued · #1 in line');
    expect(text(canvasJob('j2'))).toBe('Queued · #2 in line');
  });

  it('held: "Held"', () => {
    expect(text(canvasJob('j3'))).toBe('Held');
  });

  it('editing: the step with its count, then the time left', () => {
    expect(text(canvasJob('j5'))).toBe('Cut · graphics 2/5 · ~4 min left');
  });

  it('editing: says how long the run has been going, and ticks every second', () => {
    const job = { ...canvasJob('j5'), runningSince: '2026-10-20T13:38:18.000Z' };
    expect(text(job)).toBe('Cut · graphics 2/5 · ~4 min left · running 3:42');
    expect(intervals).toContain(1000);
  });

  it('editing a revise run or the render run: the round, or "approved", before the time left', () => {
    expect(text(reviewJob('r2'))).toBe('Cut · graphics 2/5 · round 2 · ~4 min left');
    expect(text(reviewJob('r3'))).toBe('Render · approved · ~3 min left');
  });

  it('review: "Ready to review · 0:28", and the round once notes were sent', () => {
    expect(text(reviewJob('r1'))).toBe('Ready to review · 0:28');
    // Job.round counts the rounds of notes sent: the cut made from round 1's notes is round 2.
    expect(text({ ...reviewJob('r1'), round: 1 })).toBe('Ready to review · 0:28 · round 2');
  });

  it('ready: the length and the size of the export, with no frame size', () => {
    expect(text(canvasJob('j6'))).toBe('0:45 · 62 MB');
  });

  it('ready without an export record: "Approved"', () => {
    expect(text(canvasJob('j9'))).toBe('Approved');
  });

  it('failed: "Failed at Render"', () => {
    expect(text(canvasJob('j7'))).toBe('Failed at Render');
  });

  it('cancelled: "Cancelled at Plan"', () => {
    expect(text(canvasJob('j8'))).toBe('Cancelled at Plan');
  });

  it('never says a frame size', () => {
    for (const job of [
      ...REVIEW_ROW_JOBS,
      ...[1, 2, 3, 5, 6, 7, 8, 9].map((n) => canvasJob(`j${n}`)),
    ]) {
      expect(text(job), job.id).not.toMatch(/1080|1920|×/);
    }
  });

  it('is 13 px muted text, right aligned, one line, with digits that do not jitter', () => {
    const markup = detail(canvasJob('j6'));
    expect(markup).toMatch(
      /<span data-slot="job-detail" class="text-right text-\[13px\] whitespace-nowrap text-muted-foreground tabular-nums">/,
    );
  });
});

describe('<JobDetail>: a delivered, uploaded or paid job (C99)', () => {
  const REEL = { uploadedAt: '2026-10-20T09:30:00.000Z', reelUrl: 'https://x.test/reel/rooftop/' };
  const readyJob = (delivery: ReturnType<typeof makeJobDelivery>) =>
    makeJob({ state: 'ready', placeInLine: null, delivery });

  it('uploaded: "Posted Tue 20 Oct · 27.5K plays", with the money left to the tooltip', () => {
    const job = readyJob(makeJobDelivery({ ...REEL, reelPlays: 27_500 }));
    const markup = detail(job);
    expect(textOf(markup)).toMatch(/^Posted [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · 27\.5K plays$/);
    expect(textOf(markup)).not.toContain('not paid');
    // The text is the tooltip's trigger (closed until the pointer is on it), in the same muted look.
    expect(markup).toMatch(
      /<span data-slot="job-detail"[^>]*class="text-right text-\[13px\] whitespace-nowrap text-muted-foreground tabular-nums"/,
    );
    expect(markup).toContain('data-state="closed"');
  });

  it('uploaded, with no plays known: the day alone, still with the tooltip', () => {
    const markup = detail(readyJob(makeJobDelivery(REEL)));
    expect(textOf(markup)).toMatch(/^Posted [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
    expect(markup).toContain('data-state="closed"');
  });

  it('delivered and paid keep their money in the text, with no tooltip', () => {
    const delivered = detail(readyJob(makeJobDelivery()));
    expect(textOf(delivered)).toMatch(/^Delivered \d{1,2} [A-Z][a-z]{2} · ₪40 not paid$/);
    expect(delivered).not.toContain('data-state');
    const paid = detail(
      readyJob(makeJobDelivery({ ...REEL, reelPlays: 27_500, paidOn: '2026-10-23' })),
    );
    expect(textOf(paid)).toBe('Paid 23 Oct · ₪40');
    expect(paid).not.toContain('data-state');
  });

  it('an editor’s uploaded row has the plays and no tooltip (it has no money to say)', () => {
    const markup = detail(
      makeJob({
        state: 'ready',
        placeInLine: null,
        delivery: { deliveredAt: '2026-10-21T09:00:00.000Z', ...REEL, reelPlays: 9_800 },
      }),
    );
    expect(textOf(markup)).toMatch(/· 9\.8K plays$/);
    expect(markup).not.toContain('data-state');
  });
});

describe('<JobDetail>: a job in Review while its notes are fixed (C57)', () => {
  const review = makeJob({
    id: 'q1',
    state: 'review',
    step: 7,
    placeInLine: null,
    preview: { durationSec: 39, width: 1080, height: 1920 },
  });

  it('keeps "Ready to review · 0:39" when no fix is running and none was fixed', () => {
    expect(text(review)).toBe('Ready to review · 0:39');
  });

  it('says a note is being fixed, with its time', () => {
    expect(text({ ...review, fixing: { atSec: 12 } })).toBe('Review · fixing a note at 0:12…');
  });

  it('says how many notes were fixed here, with the cut they are in', () => {
    expect(text({ ...review, round: 1, fixedCount: 1 })).toBe('Review · cut 2 · 1 fixed here');
    expect(text({ ...review, round: 1, fixedCount: 3 })).toBe('Review · cut 2 · 3 fixed here');
  });

  it('draws it as the usual muted detail, with no span of its own', () => {
    const html = detail({ ...review, fixing: { atSec: 12 } });
    expect(html).toContain('data-slot="job-detail"');
    expect(html).not.toContain('data-step-label');
  });
});

describe('<JobDetail>: the step of an editing job', () => {
  it('wraps the step with its count in a data-step-label span, so tests can read it', () => {
    expect(detail(canvasJob('j5'))).toContain(
      '<span data-step-label="">Cut · graphics 2/5</span> · ~4 min left',
    );
    expect(detail(reviewJob('r3'))).toContain('<span data-step-label="">Render</span>');
  });

  it('keeps the text on the page the same line as listDetail with or without the span', () => {
    expect(text(canvasJob('j5'))).toBe('Cut · graphics 2/5 · ~4 min left');
    // A step with nothing after it: the span is the whole line.
    const bare = { ...canvasJob('j5'), subProgress: null, etaSec: null };
    expect(detail(bare)).toContain('<span data-step-label="">Cut</span></span>');
    expect(text(bare)).toBe('Cut');
  });

  it('is just "Editing", with no span, when the job has no step', () => {
    const noStep = makeJob({ id: 'e1', state: 'editing', step: null, placeInLine: null });
    expect(text(noStep)).toBe('Editing');
    expect(detail(noStep)).not.toContain('data-step-label');
  });

  it('has the span for no other state', () => {
    for (const state of JOB_STATES.filter((s) => s !== 'editing')) {
      const job = makeJob({ id: `s-${state}`, state, step: 5, placeInLine: null });
      expect(detail(job), state).not.toContain('data-step-label');
    }
  });
});

describe('<JobDetail>: the arriving countdown', () => {
  it('counts down with the clock', () => {
    // 42 s on the settle timer at 13:42:00; ten seconds later 32 s are left.
    vi.setSystemTime(new Date('2026-10-20T13:42:10.000Z'));
    expect(text(canvasJob('j1'))).toBe('Arriving · settles in 0:32');
    vi.setSystemTime(new Date('2026-10-20T13:42:41.000Z'));
    expect(text(canvasJob('j1'))).toBe('Arriving · settles in 0:01');
    vi.setSystemTime(new Date(NOW));
  });

  it('stops at 0:00 instead of going negative while it waits for the server to move on', () => {
    vi.setSystemTime(new Date('2026-10-20T13:50:00.000Z'));
    expect(text(canvasJob('j1'))).toBe('Arriving · settles in 0:00');
    vi.setSystemTime(new Date(NOW));
  });

  it('is just "Arriving" when the job has no settle time', () => {
    expect(text({ ...canvasJob('j1'), settlesAt: null })).toBe('Arriving');
  });

  it('runs the one-second clock for an arriving job, and no other state does', () => {
    detail(canvasJob('j1'));
    expect(intervals).toEqual([1000]);

    for (const id of ['j2', 'j3', 'j5', 'j6', 'j7', 'j8', 'j9']) {
      intervals.length = 0;
      detail(canvasJob(id));
      expect(intervals, id).toEqual([undefined]);
    }
    intervals.length = 0;
    detail(reviewJob('r1'));
    expect(intervals).toEqual([undefined]);
  });
});

describe('<JobDetail>: a job the note dialog is holding', () => {
  // A server render reads a store's initial state, so point it at the current one for these tests.
  const initialState = noteDialogStore.getInitialState;
  noteDialogStore.getInitialState = () => noteDialogStore.getState();
  afterAll(() => {
    noteDialogStore.getInitialState = initialState;
  });
  afterEach(() => noteDialogStore.getState().reset());

  const held = makeJob({ id: 'h1', state: 'held', placeInLine: null });
  const dialogFor = (id: string, extra: { held: boolean; phase?: 'writing' | 'saving' }) =>
    noteDialogStore.setState({
      phase: extra.phase ?? 'writing',
      job: { id, name: 'x', client: 'y' },
      held: extra.held,
    });

  it('says "Held · while you write a note" while the dialog is open (and saving)', () => {
    expect(WRITING_NOTE_DETAIL).toBe('Held · while you write a note');
    dialogFor('h1', { held: true });
    expect(text(held)).toBe('Held · while you write a note');
    dialogFor('h1', { held: true, phase: 'saving' });
    expect(text(held)).toBe('Held · while you write a note');
  });

  it('says it only for that job', () => {
    dialogFor('h1', { held: true });
    const other = makeJob({ id: 'h2', state: 'held', placeInLine: null });
    expect(text(other)).toBe('Held');
  });

  it('says nothing for a held job the dialog did not hold (the person held it)', () => {
    dialogFor('h1', { held: false });
    expect(text(held)).toBe('Held');
  });

  it('says nothing before the Hold is answered or after the dialog closed', () => {
    dialogFor('h1', { held: true });
    noteDialogStore.setState({ phase: 'holding' });
    expect(text(held)).toBe('Held');
    noteDialogStore.setState({ phase: 'closed' });
    expect(text(held)).toBe('Held');
  });

  it('leaves the other states as they are (the job is back in line when it is not held)', () => {
    dialogFor('j2', { held: true });
    expect(text(canvasJob('j2'))).toBe('Queued · #2 in line');
  });
});

describe('<JobDetail>: a failed job', () => {
  const failed = canvasJob('j7');

  it('is red text in a button, so the keyboard reaches the error behind it', () => {
    const markup = detail(failed);
    expect(markup).toMatch(/<button type="button" data-slot="job-detail" class="[^"]*"/);
    const className = markup.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(className).toContain('text-status-failed-foreground');
    expect(className).not.toContain('text-muted-foreground');
    expect(className).toContain('cursor-help');
    expect(className).toContain('text-[13px]');
    expect(className).toContain('tabular-nums');
    expect(textOf(markup)).toBe('Failed at Render');
  });

  it('has no badge: no box, no fill, no border', () => {
    const className = detail(failed).match(/<button[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(className).not.toMatch(/\bborder|\bbg-|\bpx-|\bpy-/);
    expect(detail(failed)).not.toContain('data-slot="badge"');
  });

  it('has no neon focus ring: a quiet neutral one for the keyboard only', () => {
    const className = detail(failed).match(/<button[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(className).toContain('outline-none');
    expect(className).toContain('focus-visible:ring-ring/35');
    expect(className).not.toMatch(/blue|outline-ring/);
  });

  it('keeps the error out of the page until the tooltip opens', () => {
    expect(detail(failed)).not.toContain('not enough disk space');
  });

  it('is plain red text, not a button, when there is no error text to show', () => {
    const noError = { ...failed, error: null };
    const markup = detail(noError);
    expect(markup).not.toContain('<button');
    expect(markup).toMatch(
      /<span data-slot="job-detail" class="[^"]*text-status-failed-foreground/,
    );
    expect(textOf(markup)).toBe('Failed at Render');
  });

  it('is just "Failed" when the step is unknown', () => {
    expect(text({ ...failed, failedAt: null })).toBe('Failed');
  });
});

describe('<FailedDetail>: the tooltip', () => {
  /** The tooltip content element in the tree the component returns (it has no hooks). */
  function contentOf(error: string | null) {
    const tree = FailedDetail({ job: { error }, text: 'Failed at Render' }) as ReactElement<{
      children: ReactNode;
    }>;
    const children = tree.props.children as ReactNode[];
    return children.find(
      (child): child is ReactElement<Record<string, unknown>> =>
        isValidElement(child) && 'side' in (child.props as object),
    );
  }

  it('shows the error wide, below the text, starting at its left edge, in its own direction', () => {
    const content = contentOf('Render stopped: not enough disk space.');
    expect(content?.props).toMatchObject({
      wide: true,
      side: 'bottom',
      align: 'start',
      sideOffset: 6,
      dir: 'auto',
      children: 'Render stopped: not enough disk space.',
    });
  });

  it('has no tooltip without an error', () => {
    const tree = FailedDetail({ job: { error: null }, text: 'Failed' });
    expect(isValidElement(tree) && tree.type).toBe('span');
  });
});
