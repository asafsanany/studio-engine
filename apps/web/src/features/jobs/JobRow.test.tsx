import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createTestQueryClient, makeEpisodeJob, makeJob } from '@/data/test-utils';
import { ActionCell } from './cells/ActionCell';
import {
  JobRow,
  MENU_WIDTH,
  menuWidth,
  READY_MENU_WIDTH,
  ROW_LAYOUT_CLASSES,
  RowMenuItemLabel,
} from './JobRow';
import { CANVAS_JOBS } from './test-jobs';

const canvasJob = (id: string) => {
  const job = CANVAS_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no canvas job ${id}`);
  return job;
};

/** A row of the job with its Action cell, inside a list. */
const row = (id: string) =>
  renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <ul>
          <JobRow job={canvasJob(id)}>
            <ActionCell job={canvasJob(id)} />
          </JobRow>
        </ul>
      </TooltipProvider>
    </QueryClientProvider>,
  );

/** The `<li>` of a row's markup. */
const li = (markup: string) => markup.match(/<li [^>]*>/)?.[0] ?? '';
const classOf = (tag: string) => tag.match(/class="([^"]*)"/)?.[1] ?? '';

describe('<JobRow>', () => {
  it('is the list item of the job, with its id', () => {
    const markup = row('j1');
    expect(markup).toMatch(/<ul><li [^>]*data-job-id="j1"/);
    expect(markup).not.toContain('<tr');
  });

  it('is 44 px high, rounded, on a grid of icon, name, detail, time and next step', () => {
    const className = classOf(li(row('j1')));
    expect(className).toContain('h-11');
    expect(className).toContain('rounded-lg');
    expect(className).toContain('grid');
    expect(className).toContain('grid-cols-[16px_minmax(0,1fr)_auto_80px_32px]');
    expect(className).toContain('gap-3');
    // 12 px of room on the left, 6 px on the right.
    expect(className).toContain('pl-3');
    expect(className).toContain('pr-1.5');
    for (const name of ROW_LAYOUT_CLASSES.split(' ')) expect(className).toContain(name);
  });

  it('is the trigger of a context menu, closed until a right-click', () => {
    const markup = row('j1');
    expect(li(markup)).toContain('data-state="closed"');
    expect(markup).not.toContain('role="menu"');
  });

  it('has a quiet background on hover, while its menu is open and while it has keyboard focus', () => {
    const className = classOf(li(row('j1')));
    expect(className).toContain('hover:bg-muted/60');
    expect(className).toContain('data-[state=open]:bg-muted/60');
    expect(className).toContain('focus-visible:bg-muted/60');
  });

  it('has no lines, no border and no outline', () => {
    const className = classOf(li(row('j1')));
    expect(className).not.toMatch(/\bborder/);
    expect(className).toContain('outline-none');
    expect(className).not.toMatch(/blue|outline-ring|ring-/);
  });

  it('eases its background in and out', () => {
    const className = classOf(li(row('j1')));
    expect(className).toContain('transition-colors');
    expect(className).toContain('ease-in-out');
  });

  it('can be focused by a click or by the page, but is not a Tab stop', () => {
    expect(li(row('j5'))).toContain('tabindex="-1"');
  });

  it('gives its Action cell the actions it shares with the menu (the cell shows the next step)', () => {
    expect(row('j1')).toContain('aria-label="Start now"');
    expect(row('j1')).not.toContain('aria-label="Hold"');
    expect(row('j5')).not.toContain('<button');
  });
});

describe('menuWidth', () => {
  it('is the board’s 208 px, and 264 px for a ready row, whose Use this look item is a sentence', () => {
    expect(MENU_WIDTH).toBe('w-52');
    expect(READY_MENU_WIDTH).toBe('w-66');
    expect(menuWidth(canvasJob('j6'))).toBe(READY_MENU_WIDTH);
    for (const id of ['j1', 'j2', 'j3', 'j5', 'j7', 'j8']) {
      expect(menuWidth(canvasJob(id)), id).toBe(MENU_WIDTH);
    }
  });

  it('is 264 px for an episode of a series too, while series are on: "Open the series <name>" would wrap in 208', () => {
    for (const state of ['queued', 'editing', 'review'] as const) {
      const episode = makeEpisodeJob({ state });
      expect(menuWidth(episode, true), state).toBe(READY_MENU_WIDTH);
      expect(menuWidth(episode, false), state).toBe(MENU_WIDTH);
      expect(menuWidth(episode), state).toBe(MENU_WIDTH);
      expect(menuWidth(makeJob({ state }), true), state).toBe(MENU_WIDTH);
    }
  });
});

describe('<RowMenuItemLabel>', () => {
  const label = (props: React.ComponentProps<typeof RowMenuItemLabel>) =>
    renderToStaticMarkup(<RowMenuItemLabel {...props} />);

  it('is the plain text of an item that has no name of the person’s in it', () => {
    expect(label({ label: 'Download MP4' })).toBe('Download MP4');
  });

  it('puts the person’s name in its own <bdi>, in one element so the menu item’s gap stays out of the sentence', () => {
    expect(label({ label: 'Use this look for Arc Fitness…', bidi: 'Arc Fitness' })).toBe(
      '<span>Use this look for <bdi>Arc Fitness</bdi>…</span>',
    );
    expect(label({ label: 'Arc Fitness’s look comes from this job', bidi: 'Arc Fitness' })).toBe(
      '<span><bdi>Arc Fitness</bdi>’s look comes from this job</span>',
    );
  });

  it('keeps a Hebrew name in its own direction inside the English sentence', () => {
    expect(label({ label: 'Use this look for מרפאת מירה…', bidi: 'מרפאת מירה' })).toBe(
      '<span>Use this look for <bdi>מרפאת מירה</bdi>…</span>',
    );
  });

  it('shows the label as it is when the name is not in it', () => {
    expect(label({ label: 'Use this look…', bidi: 'Arc Fitness' })).toBe('Use this look…');
  });
});
