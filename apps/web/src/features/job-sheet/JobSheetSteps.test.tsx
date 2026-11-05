import type { Job, JobStepsResponse, ReviewNote } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobSheetSteps, StepsPanel, type StepsPanelProps } from './JobSheetSteps';
import { buildSteps, STEPS_TEXT } from './sheet-steps';
import {
  type JobSheetState,
  jobSheetJobs,
  jobSheetNotes,
  jobSheetNow,
  jobSheetRuns,
  jobSheetStepsResponse,
} from './test-fixtures';

// The section reads its steps through `useJobSteps` and the notes it counts through `useSentNotes`;
// these tests hand it the queries' states.
const mocks = vi.hoisted(() => ({ useJobSteps: vi.fn(), useSentNotes: vi.fn() }));
vi.mock('@/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data')>()),
  useJobSteps: mocks.useJobSteps,
  useSentNotes: mocks.useSentNotes,
}));

/** The Steps section of a board's job, as the panel gets it. */
function panel(
  state: JobSheetState,
  props: Partial<StepsPanelProps> = {},
  notes?: readonly ReviewNote[],
): string {
  const view = buildSteps(jobSheetJobs[state], jobSheetRuns[state], {
    now: Date.parse(jobSheetNow[state]),
    timeZone: 'UTC',
    notes,
  });
  return renderToStaticMarkup(
    <StepsPanel
      view={view}
      failed={false}
      showSkeleton={false}
      open={false}
      onToggle={() => {}}
      {...props}
    />,
  );
}

/** The rows of some markup: `[step, kind]` in order. */
function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<li data-step="([^"]+)" data-kind="([^"]+)"/g)].map((m) => [
    m[1] ?? '',
    m[2] ?? '',
  ]);
}

/** The opening tag of the row of a step. */
function rowTag(html: string, step: string): string {
  const start = html.indexOf(`<li data-step="${step}"`);
  return html.slice(start, html.indexOf('</li>', start));
}

describe('<StepsPanel>: the section', () => {
  it('is named Steps, with the heading and its muted label on one line', () => {
    const html = panel('review');
    expect(html).toContain('<section aria-label="Steps"');
    expect(html).toMatch(/<h3[^>]*text-\[13px\][^>]*text-muted-foreground[^>]*>Steps<\/h3>/);
    expect(html).toMatch(/<span class="text-xs text-zinc-500">33 min of work<\/span>/);
    expect(html).toContain('justify-between');
  });

  it('lists a job’s rows in order, one list item each', () => {
    expect(rowsOf(panel('editing'))).toEqual([
      ['1', 'done'],
      ['2', 'done'],
      ['3', 'done'],
      ['4', 'done'],
      ['5', 'running'],
      ['6', 'pending'],
      ['7', 'pending'],
      ['8', 'pending'],
    ]);
    expect(rowsOf(panel('review')).map(([step, kind]) => `${step}:${kind}`)).toEqual([
      '1:done',
      '2:done',
      '3:done',
      '4:done',
      '5:done',
      '6:done',
      '7:done',
      'review:waiting',
      '8:pending',
    ]);
  });

  it('shows no rows and no label for a round it has nothing to say about yet', () => {
    const html = renderToStaticMarkup(
      <StepsPanel
        view={null}
        failed={false}
        showSkeleton={false}
        open={false}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('>Steps</h3>');
    expect(html).not.toContain('<li');
    expect(html).not.toContain('data-slot="skeleton"');
  });
});

describe('<StepsPanel>: the icons and colours of a row', () => {
  it('draws each kind of row with the app’s own status icons, named', () => {
    const editing = panel('editing');
    expect(rowTag(editing, '1')).toContain('aria-label="Done"');
    // The running icon is the blue editing one, with the pie of the step it is on.
    expect(rowTag(editing, '5')).toContain('aria-label="Running now"');
    expect(rowTag(editing, '5')).toContain('text-status-editing');
    expect(rowTag(editing, '6')).toContain('aria-label="Not started"');

    expect(rowTag(panel('failed'), '8')).toContain('aria-label="Failed"');
    expect(rowTag(panel('failed'), '8')).toContain('text-status-failed');
    expect(rowTag(panel('cancelled'), '5')).toContain('aria-label="Stopped"');
    expect(rowTag(panel('review'), 'review')).toContain('aria-label="Waiting for you"');
    expect(rowTag(panel('review'), 'review')).toContain('text-status-review');
  });

  it('colours the right-hand text: light blue running, red failed, violet waiting, muted otherwise', () => {
    expect(rowTag(panel('editing'), '5')).toMatch(/text-blue-300[^>]*>now · 2 of 5</);
    expect(rowTag(panel('failed'), '8')).toMatch(
      /text-status-failed-foreground[^>]*>failed 12:52</,
    );
    expect(rowTag(panel('review'), 'review')).toMatch(/text-violet-300[^>]*>waiting 9 min</);
    expect(rowTag(panel('editing'), '1')).toMatch(/text-muted-foreground[^>]*>14:30 · 1 min</);
  });

  it('mutes the name of a step that has not started, and the violet one of the review', () => {
    expect(rowTag(panel('editing'), '6')).toMatch(/text-zinc-500[^>]*>Preview</);
    expect(rowTag(panel('editing'), '1')).not.toMatch(/text-zinc-500[^>]*>Brief</);
    expect(rowTag(panel('review'), 'review')).toMatch(/text-violet-300[^>]*>Your review</);
  });

  it('lays a row out as icon, name, text, with tabular numbers that never wrap', () => {
    const html = panel('editing');
    expect(html).toContain('grid-cols-[16px_minmax(0,1fr)_auto]');
    expect(html).toContain('min-h-7');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('whitespace-nowrap');
  });

  it('writes "after you approve" next to Render while the edit is still going', () => {
    expect(rowTag(panel('editing'), '8')).toContain('>after you approve<');
    expect(rowTag(panel('review'), '8')).not.toContain('after you approve');
  });
});

describe('<StepsPanel>: a finished job', () => {
  it('folds into one line with a closed chevron, and no rows', () => {
    const html = panel('approved');
    expect(html).toContain('All 8 steps done · 29 min of work');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('<ol');
    expect(rowsOf(html)).toEqual([]);
    // Nothing on the right of the heading: the line says it.
    expect(html).toContain('<span class="text-xs text-zinc-500"></span>');
  });

  it('turns the chevron half a turn, ease-in-out, and shows the rows once opened', () => {
    const closed = panel('approved');
    const open = panel('approved', { open: true });
    expect(closed).toMatch(/lucide-chevron-down[^"]*duration-150[^"]*ease-in-out/);
    expect(closed).not.toContain('rotate-180');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('rotate-180');
    expect(rowsOf(open)).toHaveLength(9);
    expect(rowTag(open, 'review')).toContain('>approved 13:55<');
    // The button points at the list it opens.
    const controls = open.match(/aria-controls="([^"]+)"/)?.[1];
    expect(open).toContain(`<ol id="${controls}"`);
  });

  it('names each later round with a small muted sub-heading once the rows are open', () => {
    expect(panel('paid')).toContain('All 8 steps done · 1 review round · 48 min of work');
    expect(panel('paid')).not.toContain('Round 2 · from Plan');
    const open = panel('paid', { open: true }, jobSheetNotes.paid);
    expect(open).toMatch(
      /<li data-slot="job-sheet-steps-round" class="[^"]*text-xs text-zinc-500[^"]*">Round 2 · from Plan<\/li>/,
    );
    // Nothing on the right of the heading: the sub-heading says it.
    expect(open).toContain('<span class="text-xs text-zinc-500"></span>');
  });

  it('lists all 8 steps, then each round, in time order, with Render last', () => {
    const open = panel('paid', { open: true }, jobSheetNotes.paid);
    expect(rowsOf(open).map(([step]) => step)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      'review',
      '4',
      '5',
      '6',
      '7',
      'review',
      '8',
    ]);
    // The sub-heading sits between the first round's review and the second cut's Plan.
    const order = ['>Check<', '>2 notes sent 17:10<', '>Round 2 · from Plan<', '>Plan<'];
    let from = open.indexOf('>Check<');
    for (const marker of order) {
      const at = open.indexOf(marker, from);
      expect(at, marker).toBeGreaterThanOrEqual(from);
      from = at;
    }
    expect(open).toContain('>approved 17:38<');
    expect(open.lastIndexOf('>Render<')).toBeGreaterThan(open.lastIndexOf('>approved 17:38<'));
  });

  it('draws the sub-heading of every later round, and none for a job without rounds', () => {
    const archived = panel('archived', { open: true }, jobSheetNotes.archived);
    expect(archived.match(/data-slot="job-sheet-steps-round"/g)).toHaveLength(2);
    expect(archived).toContain('>Round 3 · from Plan<');
    expect(panel('approved', { open: true })).not.toContain('job-sheet-steps-round');
  });

  it('is a plain button: ghost, keyboard-reachable, with no tooltip needed', () => {
    const html = panel('delivered');
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*type="button"/);
    expect(html).toContain('min-h-8');
    // A long line wraps rather than hiding "of work" behind an ellipsis.
    expect(html).toContain('whitespace-normal');
  });

  it('does not fold a job that is still going', () => {
    expect(panel('rendering')).not.toContain('aria-expanded');
    expect(rowsOf(panel('rendering'))).toHaveLength(9);
  });
});

describe('<StepsPanel>: loading and failing', () => {
  it('draws eight skeleton rows once they are due, with a status for screen readers', () => {
    const html = renderToStaticMarkup(
      <StepsPanel view={null} failed={false} showSkeleton open={false} onToggle={() => {}} />,
    );
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(8);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
  });

  it('says in one muted line that the steps could not be loaded', () => {
    const html = renderToStaticMarkup(
      <StepsPanel view={null} failed showSkeleton={false} open={false} onToggle={() => {}} />,
    );
    expect(html).toContain(`<p class="text-muted-foreground">${STEPS_TEXT.loadFailed}</p>`);
    expect(STEPS_TEXT.loadFailed).toBe('Couldn’t load the steps.');
    expect(html).not.toContain('<li');
  });
});

describe('<JobSheetSteps>: reading the steps', () => {
  /** What `useJobSteps` answers: the data, or the loading or failed state. */
  function answer(data: JobStepsResponse | undefined, isError = false, failureCount = 0) {
    mocks.useJobSteps.mockReturnValue({ data, isError, failureCount });
  }

  function section(job: Job, skeletonDelayMs?: number) {
    return renderToStaticMarkup(<JobSheetSteps job={job} skeletonDelayMs={skeletonDelayMs} />);
  }

  beforeEach(() => {
    mocks.useJobSteps.mockReset();
    mocks.useSentNotes.mockReset();
    mocks.useSentNotes.mockReturnValue({ data: undefined });
  });

  it('asks for the steps of its job, and only that job’s', () => {
    answer(jobSheetStepsResponse('editing'));
    section(jobSheetJobs.editing);
    expect(mocks.useJobSteps).toHaveBeenCalledWith(jobSheetJobs.editing.id, { enabled: true });
  });

  it('asks for the sent notes of a job that has sent a round, and of no other', () => {
    answer(jobSheetStepsResponse('paid'));
    section(jobSheetJobs.paid);
    expect(mocks.useSentNotes).toHaveBeenLastCalledWith(jobSheetJobs.paid.id, { enabled: true });
    answer(jobSheetStepsResponse('approved'));
    section(jobSheetJobs.approved);
    expect(mocks.useSentNotes).toHaveBeenLastCalledWith(jobSheetJobs.approved.id, {
      enabled: false,
    });
  });

  it('counts the notes of a round in the rows of a finished job once they are loaded', () => {
    answer(jobSheetStepsResponse('paid'));
    mocks.useSentNotes.mockReturnValue({
      data: { jobId: jobSheetJobs.paid.id, notes: jobSheetNotes.paid },
    });
    const html = renderToStaticMarkup(<JobSheetSteps job={jobSheetJobs.paid} initiallyOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(rowTag(html, 'review')).toContain('>2 notes sent ');
    expect(html).toContain('>Round 2 · from Plan<');
    expect(rowsOf(html)).toHaveLength(14);
  });

  it('says "notes sent" without a count while the notes are not known', () => {
    answer(jobSheetStepsResponse('paid'));
    mocks.useSentNotes.mockReturnValue({ data: undefined });
    const html = renderToStaticMarkup(<JobSheetSteps job={jobSheetJobs.paid} initiallyOpen />);
    // The time is the revise run's start: a clock time this week, a date after that.
    expect(rowTag(html, 'review')).toMatch(/>notes sent [^<]+</);
    expect(rowTag(html, 'review')).not.toContain('2 notes');
    expect(rowsOf(html)).toHaveLength(14);
  });

  it('shows the rows of the job from its steps', () => {
    answer(jobSheetStepsResponse('editing'));
    const html = section(jobSheetJobs.editing);
    expect(rowsOf(html)).toHaveLength(8);
    expect(rowTag(html, '5')).toContain('now · 2 of 5');
    expect(html).toContain('started ');
  });

  it('shows eight rows not started for a job whose steps come back empty', () => {
    answer(jobSheetStepsResponse('queued'));
    const html = section(jobSheetJobs.queued);
    expect(rowsOf(html).map(([, kind]) => kind)).toEqual(Array(8).fill('pending'));
    expect(html).toContain('>not started<');
  });

  it('folds a finished job, closed at first', () => {
    answer(jobSheetStepsResponse('approved'));
    const html = section(jobSheetJobs.approved);
    expect(html).toContain('All 8 steps done · 29 min of work');
    expect(html).toContain('aria-expanded="false"');
    expect(rowsOf(html)).toEqual([]);
  });

  it('draws nothing under the heading while loading, until the skeleton delay has passed', () => {
    answer(undefined);
    // The default delay is 250 ms, so the first render has no skeleton.
    const html = section(jobSheetJobs.review);
    expect(html).toContain('>Steps</h3>');
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('<li');
    expect(html).not.toContain('Couldn’t load');
  });

  it('draws the skeleton rows when the delay is zero (a load that has taken its time)', () => {
    answer(undefined);
    const html = section(jobSheetJobs.review, 0);
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(8);
  });

  it('says it could not load the steps when the request failed and nothing is kept', () => {
    answer(undefined, true);
    const html = section(jobSheetJobs.review, 0);
    expect(html).toContain('Couldn’t load the steps.');
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('<li');
  });

  it('says so too while a failed read is being asked again (the app retries for ever)', () => {
    answer(undefined, false, 1);
    const html = section(jobSheetJobs.review, 0);
    expect(html).toContain('Couldn’t load the steps.');
    expect(html).not.toContain('data-slot="skeleton"');
  });

  it('keeps showing the steps it had when a later read fails', () => {
    answer(jobSheetStepsResponse('review'), true, 2);
    const html = section(jobSheetJobs.review);
    expect(rowsOf(html)).toHaveLength(9);
    expect(html).not.toContain('Couldn’t load');
  });
});
