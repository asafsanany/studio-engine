import {
  type AnalyticsTypicalJob,
  analyticsTypicalJobSchema,
  TYPICAL_JOB_STAGES,
} from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { ANALYTICS_CARDS } from './analytics-copy';
import { TypicalJobCard } from './TypicalJobCard';

const MIN = 60;

// Board J1: stage by stage, wait, Brief ... Check, you, render, in minutes, now and before.
const NOW_MIN = [4, 2, 3, 4, 6, 16, 13, 8, 112, 4];
const BEFORE_MIN = [5, 3, 3, 6, 9, 22, 18, 8, 150, 5];

function typicalJob(overrides: Partial<AnalyticsTypicalJob> = {}): AnalyticsTypicalJob {
  return analyticsTypicalJobSchema.parse({
    stages: TYPICAL_JOB_STAGES.map((stage, index) => ({
      ...stage,
      medianSec: (NOW_MIN[index] ?? 0) * MIN,
      beforeSec: (BEFORE_MIN[index] ?? 0) * MIN,
    })),
    editorSec: 52 * MIN,
    editorBeforeSec: 69 * MIN,
    wholeSec: 172 * MIN,
    wholeBeforeSec: 197 * MIN,
    slowestStepKey: 'cut',
    jobsCounted: 9,
    jobsCountedBefore: 8,
    ...overrides,
  });
}

/** The text of some markup, each piece of it between bars. */
const plain = (markup: string): string => markup.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

const render = (job: AnalyticsTypicalJob) =>
  renderToStaticMarkup(<TypicalJobCard typicalJob={job} />);

describe('<TypicalJobCard> with the numbers of board J1', () => {
  const markup = render(typicalJob());

  it('is a card with the title and subtitle of the board', () => {
    expect(markup).toContain('aria-label="A typical job, step by step"');
    expect(markup).toContain(`>${ANALYTICS_CARDS.typicalJob.title}</h3>`);
    expect(markup).toContain(`>${ANALYTICS_CARDS.typicalJob.subtitle}</p>`);
    expect(markup).toContain('h-[470px]');
    expect(markup).toContain('min-[1000px]:col-span-6');
  });

  it('says the whole job and how much faster it is', () => {
    expect(markup).toContain('Whole job · 2 h 52 m');
    expect(markup).toMatch(/text-\[#4ADE80\]"> \(25 min faster\)<\/span>/);
  });

  it('draws the strip of four parts, with their widths, and a legend', () => {
    const strip = markup.slice(markup.indexOf('h-5 gap-0.5'), markup.indexOf('<ul'));
    // Each part is a hover target (the card of its name and time comes up on hover).
    expect(strip.match(/data-slot="tooltip-trigger"/g)).toHaveLength(4);
    expect(strip).toContain('width:max(4px, calc(2.33% - 2px));background:#71717A');
    expect(strip).toContain('width:max(4px, calc(30.23% - 2px));background:#3987e5');
    expect(strip).toContain('width:max(4px, calc(65.12% - 2px));background:#c98500');
    expect(strip).toContain('background:#199e70');

    const legend = [...markup.matchAll(/<li class="[^"]*">(.*?)<\/li>/g)].map((m) =>
      m[1]?.replace(/<[^>]+>/g, ''),
    );
    expect(legend).toEqual([
      'Waiting to start 4 min',
      'The editor 52 min',
      'Waiting for you 1 h 52 m',
      'Render 4 min',
    ]);
  });

  it('says the editor total, its change, and the table header with the minutes axis', () => {
    expect(markup).toContain('The editor\u2019s 52 min, step by step');
    expect(markup).toMatch(/> \(17 min faster\)<\/span>/);
    expect(plain(markup)).toContain('|Step|0|10|20|30|40|50|Typical|vs before|Brief|');
    expect(markup).toContain('left:18.18%');
    expect(markup).toContain('left:90.91%');
  });

  it('has a row per step with its time and its change', () => {
    expect(plain(markup)).toContain(
      '|Brief|2 min|\u22121 min|Transcribe|3 min|same|Scan|4 min|\u22122 min|Plan|6 min|\u22123 min|Cut|16 min|\u22126 min|Preview|13 min|\u22125 min|Check|8 min|same|Orange is',
    );
  });

  it('places the bars in time and draws the slowest, Cut, in orange and the rest in blue', () => {
    expect(markup).toContain('left:0.00%;width:3.64%;background:#3987e5');
    expect(markup).toContain('left:27.27%;width:29.09%;background:#d95926');
    expect(markup).toContain('left:80.00%;width:14.55%;background:#3987e5');
    expect(markup.match(/background:#d95926/g)).toHaveLength(1);
    expect(markup.match(/left:[\d.]+%;width:[\d.]+%;background:#3987e5/g)).toHaveLength(6);
  });

  it('colours a drop green and leaves same grey', () => {
    expect(markup).toMatch(/text-\[#4ADE80\]">−1 min</);
    expect(markup).toMatch(/text-muted-foreground">same</);
    expect(markup).not.toContain('#F87171');
  });

  it('ends with the sentence of the board', () => {
    expect(markup).toContain(
      '<p class="text-xs text-muted-foreground">Orange is the slowest step: Cut, 16 min (was 22). Cut and Preview are 29 of the editor’s 52 min; the biggest wait is you.</p>',
    );
  });

  it('is read-only: nothing to click, no retry markers', () => {
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
    expect(markup.toLowerCase()).not.toContain('retry');
    expect(markup).not.toContain('No data yet');
    expect(markup).not.toContain('Not enough');
  });
});

describe('<TypicalJobCard> when things got slower', () => {
  it('writes a rise in red with a plus, and the headline slower', () => {
    // The 30 days before: the seven steps added up to 40 min, against 52 now.
    const job = typicalJob({ wholeBeforeSec: 150 * MIN });
    const before = [1, 2, 3, 4, 6, 16, 8];
    let step = 0;
    const stages = job.stages.map((stage) =>
      stage.kind === 'editor' ? { ...stage, beforeSec: (before[step++] ?? 0) * MIN } : stage,
    );
    const markup = render({ ...job, stages });
    expect(markup).toMatch(/text-\[#F87171\]"> \(22 min slower\)<\/span>/);
    expect(markup).toMatch(/text-\[#F87171\]"> \(12 min slower\)<\/span>/);
  });
});

describe('<TypicalJobCard> on thin data', () => {
  it('heads the steps with the sum of its bars, not with the median job', () => {
    const markup = render(typicalJob({ editorSec: 3 * MIN, editorBeforeSec: null }));
    expect(markup).toContain('The editor’s 52 min, step by step');
    expect(plain(markup)).toContain('The editor 3 min');
  });
});

describe('<TypicalJobCard> with too few finished jobs', () => {
  it.each([0, 1])('says "Not enough finished jobs yet" for %s finished jobs', (count) => {
    const markup = render(typicalJob({ jobsCounted: count }));
    expect(markup).toContain('>Not enough finished jobs yet</p>');
    expect(markup).toContain('text-muted-foreground');
    expect(markup).toContain(`>${ANALYTICS_CARDS.typicalJob.title}</h3>`);
    expect(markup).not.toContain('Whole job');
    expect(markup).not.toContain('Typical');
  });

  it('says it for the empty answer the engine gives with nothing recorded', () => {
    const markup = render(makeAnalyticsResponse().typicalJob);
    expect(markup).toContain('>Not enough finished jobs yet</p>');
    expect(markup).not.toContain('<button');
  });
});

describe('<TypicalJobCard> with some numbers missing', () => {
  it('leaves out the part of the strip no job had, and the change with nothing to compare with', () => {
    const job = typicalJob({ wholeBeforeSec: null, editorBeforeSec: null });
    const stages = job.stages.map((stage) =>
      stage.key === 'waiting-for-you'
        ? { ...stage, medianSec: null }
        : { ...stage, beforeSec: null },
    );
    const markup = render({ ...job, stages });
    expect(markup).not.toContain('title="Waiting for you');
    expect(markup).not.toContain('faster');
    expect(markup).not.toContain('slower');
    // Every step has nothing to compare with: a dash.
    expect(markup.match(/>—</g)).toHaveLength(7);
  });
});
