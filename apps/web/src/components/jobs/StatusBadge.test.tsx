import type { JobState } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import type { StatusBadgeJob } from './StatusBadge';
import { FailedBadge, STATUS_DOT_CLASSES, STATUS_LABELS, StatusBadge } from './StatusBadge';
import { render } from './test-helpers';

const NOW = Date.parse('2026-10-20T13:42:00.000Z');

const job = (patch: Partial<StatusBadgeJob>): StatusBadgeJob => ({
  state: 'queued',
  placeInLine: null,
  settlesAt: null,
  output: null,
  failedAt: null,
  stoppedAt: null,
  error: null,
  preview: null,
  round: 0,
  ...patch,
});

/** The visible text of the markup: tags stripped. */
const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('STATUS_LABELS / STATUS_DOT_CLASSES', () => {
  it('has the approved badge text for all eight states', () => {
    expect(STATUS_LABELS).toEqual({
      arriving: 'Arriving',
      queued: 'Queued',
      held: 'Held',
      editing: 'Editing',
      review: 'Review',
      ready: 'Approved',
      failed: 'Failed',
      cancelled: 'Cancelled',
    });
  });

  it('uses the status colour tokens for the dots', () => {
    expect(STATUS_DOT_CLASSES).toEqual({
      arriving: 'bg-status-neutral',
      queued: 'bg-status-neutral',
      held: 'bg-status-held',
      editing: 'bg-status-editing',
      review: 'bg-status-review',
      ready: 'bg-status-ready',
      failed: 'bg-status-failed',
      cancelled: 'bg-status-cancelled',
    });
  });
});

describe('<StatusBadge>', () => {
  const cases: [JobState, Partial<StatusBadgeJob>, string, string][] = [
    [
      'arriving',
      { settlesAt: new Date(NOW + 42_000).toISOString() },
      'Arriving',
      'settles in 0:42',
    ],
    ['queued', { placeInLine: 2 }, 'Queued', '#2 in line'],
    ['held', {}, 'Held', ''],
    [
      'ready',
      {
        output: {
          fileName: 'a/b.mp4',
          durationSec: 45,
          width: 1080,
          height: 1920,
          sizeBytes: 62e6,
        },
      },
      'Approved',
      '0:45 · 1080×1920 · 62 MB',
    ],
    ['cancelled', { stoppedAt: 4 }, 'Cancelled', 'at Plan'],
    ['editing', {}, 'Editing', ''],
    [
      'review',
      { preview: { durationSec: 28.4, width: 1080, height: 1920 } },
      'Review',
      '0:28 · 1080×1920',
    ],
  ];

  it.each(cases)('%s: badge text, dot and detail', (state, patch, label, detail) => {
    const html = render(<StatusBadge job={job({ state, ...patch })} now={NOW} />);
    expect(text(html)).toBe(label + detail);
    expect(html).toContain(`data-status="${state}"`);
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain(STATUS_DOT_CLASSES[state]);
    // The detail is its own grey, tabular-figures element, and only exists when there is some.
    expect(html.includes('text-muted-foreground tabular-nums')).toBe(detail !== '');
  });

  it('shows the round once notes were sent', () => {
    const html = render(
      <StatusBadge
        job={job({
          state: 'review',
          preview: { durationSec: 28.4, width: 1080, height: 1920 },
          round: 1,
        })}
        now={NOW}
      />,
    );
    // One round of notes was sent, so this is the second cut.
    expect(text(html)).toBe('Review0:28 · 1080×1920 · round 2');
    expect(html).toContain('data-status="review"');
    expect(html).toContain('bg-status-review');
  });

  it('counts the settle timer down from the `now` it is given', () => {
    const settlesAt = new Date(NOW + 42_000).toISOString();
    const at = (now: number) =>
      text(render(<StatusBadge job={job({ state: 'arriving', settlesAt })} now={now} />));
    expect(at(NOW)).toBe('Arrivingsettles in 0:42');
    expect(at(NOW + 41_000)).toBe('Arrivingsettles in 0:01');
    expect(at(NOW + 60_000)).toBe('Arrivingsettles in 0:00');
  });

  it('shows the grey text it is given instead of the state’s own detail', () => {
    const html = render(
      <StatusBadge job={job({ state: 'held' })} now={NOW} detail="while you write a note" />,
    );
    expect(text(html)).toBe('Heldwhile you write a note');
    expect(html).toContain('text-muted-foreground tabular-nums');
    // An empty override is still an override: the grey text is left out.
    expect(
      text(
        render(<StatusBadge job={job({ state: 'queued', placeInLine: 2 })} now={NOW} detail="" />),
      ),
    ).toBe('Queued');
  });

  it('hands a failed job to FailedBadge', () => {
    const html = render(
      <StatusBadge job={job({ state: 'failed', failedAt: 8, error: 'x' })} now={NOW} />,
    );
    expect(text(html)).toBe('Failed at Render');
    expect(html).toContain('data-variant="destructive"');
  });
});

describe('<FailedBadge>', () => {
  it('reads "Failed at <step>" in the red tint, as a focusable button when there is an error', () => {
    const html = render(
      <FailedBadge job={job({ state: 'failed', failedAt: 8, error: 'Disk full' })} now={NOW} />,
    );
    expect(text(html)).toBe('Failed at Render');
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain(
      'border-status-failed/40 bg-status-failed/10 text-status-failed-foreground',
    );
    expect(html).toContain('bg-status-failed');
    expect(html).toContain('cursor-help');
  });

  it('names whatever step it failed at', () => {
    const at = (failedAt: StatusBadgeJob['failedAt']) =>
      text(render(<FailedBadge job={job({ state: 'failed', failedAt, error: 'x' })} now={NOW} />));
    expect(at(1)).toBe('Failed at Brief');
    expect(at(2)).toBe('Failed at Transcribe');
    expect(at(5)).toBe('Failed at Cut');
  });

  it('reads just "Failed" when the step is unknown', () => {
    const html = render(<FailedBadge job={job({ state: 'failed', error: 'x' })} now={NOW} />);
    expect(text(html)).toBe('Failed');
  });

  it('is a plain badge, not a button, when there is no error text to show', () => {
    const html = render(<FailedBadge job={job({ state: 'failed', failedAt: 3 })} now={NOW} />);
    expect(text(html)).toBe('Failed at Scan');
    expect(html).not.toContain('<button');
    expect(html).toMatch(/^<span /);
  });
});
