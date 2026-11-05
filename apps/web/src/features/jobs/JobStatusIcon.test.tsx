import { JOB_STATES, type Job, type JobDelivery, type JobState } from '@studio/shared';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { makeJobDelivery } from '@/data/test-utils';
import {
  ICON_LABELS,
  type IconKind,
  iconKindOf,
  JobStatusIcon,
  STATUS_ICON_CLASSES,
  StatusGlyph,
} from './JobStatusIcon';

const UNPAID = makeJobDelivery();
const UPLOADED = makeJobDelivery({
  uploadedAt: '2026-10-20T09:30:00.000Z',
  reelUrl: 'https://www.instagram.com/reel/C-rooftop/',
});
const PAID = makeJobDelivery({ paidOn: '2026-10-23' });

/** The job each icon is drawn for: a ready job is Approved, Delivered, Uploaded or Paid by its delivery. */
function jobOf(kind: IconKind, step: Job['step'] = null) {
  switch (kind) {
    case 'approved':
      return { state: 'ready' as const, step, delivery: null };
    case 'delivered':
      return { state: 'ready' as const, step, delivery: UNPAID };
    case 'uploaded':
      return { state: 'ready' as const, step, delivery: UPLOADED };
    case 'paid':
      return { state: 'ready' as const, step, delivery: PAID };
    default:
      return { state: kind, step, delivery: null };
  }
}

const ICON_KINDS = Object.keys(ICON_LABELS) as IconKind[];

const icon = (kind: IconKind, step: Job['step'] = null) =>
  render(<JobStatusIcon job={jobOf(kind, step)} />);

/** The icon of a state as the job list draws it: a ready job with no delivery is Approved. */
const stateIcon = (state: JobState, step: Job['step'] = null) =>
  render(<JobStatusIcon job={{ state, step, delivery: null }} />);

/** The opening `<svg …>` tag of some markup. */
const svg = (markup: string) => markup.match(/<svg[^>]*>/)?.[0] ?? '';

/** The attribute of the first tag of some markup, or `undefined`. */
const attr = (tag: string, name: string) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1];

describe('<JobStatusIcon>: every icon is a named 16 px image in its own colour', () => {
  it.each(ICON_KINDS)('%s', (kind) => {
    const tag = svg(icon(kind));
    expect(attr(tag, 'role')).toBe('img');
    expect(attr(tag, 'aria-label')).toBe(ICON_LABELS[kind]);
    expect(attr(tag, 'width')).toBe('16');
    expect(attr(tag, 'height')).toBe('16');
    expect(attr(tag, 'viewBox')).toBe('0 0 16 16');
    expect(attr(tag, 'class')).toContain(STATUS_ICON_CLASSES[kind]);
  });

  it('has data-status, the job’s state, and data-stage, the stage of a ready job', () => {
    for (const state of JOB_STATES.filter((state) => state !== 'ready')) {
      const tag = svg(stateIcon(state));
      expect(attr(tag, 'data-status'), state).toBe(state);
      expect(tag, state).not.toContain('data-stage');
    }
    for (const stage of ['approved', 'delivered', 'uploaded', 'paid'] as const) {
      const tag = svg(icon(stage));
      expect(attr(tag, 'data-status'), stage).toBe('ready');
      expect(attr(tag, 'data-stage'), stage).toBe(stage);
    }
  });

  it('is named Arriving, Queued, Held, Editing, Review, Approved, Delivered, Uploaded, Paid, Failed, Cancelled', () => {
    expect(ICON_KINDS.map((kind) => attr(svg(icon(kind)), 'aria-label'))).toEqual([
      'Arriving',
      'Queued',
      'Held',
      'Editing',
      'Review',
      'Approved',
      'Delivered',
      'Uploaded',
      'Paid',
      'Failed',
      'Cancelled',
    ]);
  });

  it('never calls a ready job "Ready": it is Approved until it is marked delivered', () => {
    expect(attr(svg(stateIcon('ready')), 'aria-label')).toBe('Approved');
    expect(Object.values(ICON_LABELS)).not.toContain('Ready');
  });

  it('draws a ready job by its stage and every other job by its state', () => {
    expect(iconKindOf({ state: 'ready', delivery: null })).toBe('approved');
    expect(iconKindOf({ state: 'ready', delivery: UNPAID })).toBe('delivered');
    expect(iconKindOf({ state: 'ready', delivery: UPLOADED })).toBe('uploaded');
    expect(iconKindOf({ state: 'ready', delivery: PAID })).toBe('paid');
    // A paid job stays Paid when a reel is linked to it.
    expect(iconKindOf({ state: 'ready', delivery: { ...UPLOADED, paidOn: '2026-10-23' } })).toBe(
      'paid',
    );
    for (const state of JOB_STATES.filter((state) => state !== 'ready')) {
      // Even with the delivery of an earlier run: only a ready job has a stage.
      expect(iconKindOf({ state, delivery: PAID as JobDelivery }), state).toBe(state);
    }
  });

  it('takes the colour of the icon’s own status token, arriving and queued sharing the grey', () => {
    expect(STATUS_ICON_CLASSES).toEqual({
      arriving: 'text-status-neutral',
      queued: 'text-status-neutral',
      held: 'text-status-held',
      editing: 'text-status-editing',
      review: 'text-status-review',
      approved: 'text-status-ready',
      delivered: 'text-status-delivered',
      uploaded: 'text-status-uploaded',
      paid: 'text-status-paid',
      failed: 'text-status-failed',
      cancelled: 'text-status-cancelled',
    });
  });

  it('draws everything in currentColor, or in the page colours for the marks cut out of a disc', () => {
    for (const kind of ICON_KINDS) {
      const markup = icon(kind, 5);
      expect(markup, kind).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
      for (const [, colour] of markup.matchAll(/(?:stroke|fill)="([^"]*)"/g)) {
        expect(
          ['currentColor', 'none', 'var(--background)', 'var(--foreground)'],
          `${kind}: ${colour}`,
        ).toContain(colour);
      }
    }
  });
});

describe('<JobStatusIcon>: the drawing of each state', () => {
  it('arriving and queued: a dashed ring, nothing in it', () => {
    for (const state of ['arriving', 'queued'] as const) {
      const markup = icon(state);
      expect(markup).toContain(
        '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.5 2.6"></circle>',
      );
      expect(markup.match(/<circle/g)).toHaveLength(1);
      expect(markup).not.toContain('<path');
    }
  });

  it('held: a ring with two pause bars', () => {
    const markup = icon('held');
    expect(markup).toContain(
      '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"></circle>',
    );
    expect(markup).not.toContain('stroke-dasharray');
    expect(markup).toContain(
      '<path d="M6.5 5.5v5M9.5 5.5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
    );
  });

  it('review: a ring with a play triangle', () => {
    const markup = icon('review');
    expect(markup).toContain('r="6.5"');
    expect(markup).toContain('<path d="M6.6 5.3v5.4L10.9 8z" fill="currentColor"></path>');
  });

  it('approved: a filled disc with a check cut out of it', () => {
    const markup = icon('approved');
    expect(markup).toContain('<circle cx="8" cy="8" r="7" fill="currentColor"></circle>');
    expect(markup).toContain(
      '<path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--background)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>',
    );
  });

  it('delivered: a filled disc with an arrow pointing right cut out of it', () => {
    const markup = icon('delivered');
    expect(markup).toContain('<circle cx="8" cy="8" r="7" fill="currentColor"></circle>');
    expect(markup).toContain(
      '<path d="M4.8 8h6.1M8.4 5.4 11 8l-2.6 2.6" fill="none" stroke="var(--background)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>',
    );
  });

  it('paid: a filled disc with a white shekel sign on it', () => {
    const markup = icon('paid');
    expect(markup).toContain('<circle cx="8" cy="8" r="7" fill="currentColor"></circle>');
    expect(markup).toContain(
      '<text x="8" y="11.2" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--foreground)">₪</text>',
    );
  });

  it('failed: a filled disc with an exclamation mark cut out of it', () => {
    const markup = icon('failed');
    expect(markup).toContain('<circle cx="8" cy="8" r="7" fill="currentColor"></circle>');
    expect(markup).toContain(
      '<path d="M8 4.6v4.2" stroke="var(--background)" stroke-width="1.6" stroke-linecap="round"></path>',
    );
    expect(markup).toContain(
      '<circle cx="8" cy="11.2" r="0.95" fill="var(--background)"></circle>',
    );
  });

  it('cancelled: a ring with a slash', () => {
    const markup = icon('cancelled');
    expect(markup).toContain('r="6.5"');
    expect(markup).toContain(
      '<path d="M5.2 10.8 10.8 5.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>',
    );
  });

  it('has no ring where it has a disc, and no disc where it has a ring', () => {
    for (const kind of ['approved', 'delivered', 'paid', 'failed'] as const) {
      expect(icon(kind)).not.toContain('r="6.5"');
    }
    for (const kind of ['held', 'review', 'cancelled', 'editing'] as const) {
      expect(icon(kind, 3)).not.toContain('r="7"');
    }
  });
});

describe('<JobStatusIcon>: the pie of an editing job', () => {
  /** The opening tags of the pie's circles: the finished steps, then the current one (if drawn). */
  const pie = (markup: string) => markup.match(/<circle[^>]*stroke-width="5"[^>]*>/g) ?? [];

  it('has data-done, the number of finished steps: 0 at Brief up to 7 at Render', () => {
    const done = ([1, 2, 3, 4, 5, 6, 7, 8] as const).map((step) =>
      attr(svg(icon('editing', step)), 'data-done'),
    );
    expect(done).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('has data-done only while editing', () => {
    for (const kind of ICON_KINDS.filter((k) => k !== 'editing')) {
      expect(svg(icon(kind, 5)), kind).not.toContain('data-done');
    }
  });

  it('draws the finished steps solid and the current one at 40 %, on the ring', () => {
    // Cut is the fifth step: four are finished, so a half circle (4/8 of 15.708) is solid.
    const markup = icon('editing', 5);
    expect(markup).toContain('r="6.5"');
    const [finished, current] = pie(markup);
    expect(finished).toBe(
      '<circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="5" transform="rotate(-90 8 8)" stroke-dasharray="7.854 15.708">',
    );
    expect(current).toBe(
      '<circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="5" transform="rotate(-90 8 8)" stroke-dasharray="1.964 15.708" stroke-dashoffset="-7.854" opacity="0.4">',
    );
    expect(pie(markup)).toHaveLength(2);
  });

  it('starts the pie at the top and fills it clockwise, one eighth for each step', () => {
    const lengths = ([1, 2, 3, 4, 5, 6, 7, 8] as const).map((step) => {
      const [finished, current] = pie(icon('editing', step));
      return {
        solid: Number(finished?.match(/stroke-dasharray="([\d.]+) /)?.[1]),
        from: Math.abs(Number(current?.match(/stroke-dashoffset="(-?[\d.]+)"/)?.[1] ?? 0)),
      };
    });
    // The finished part ends exactly where the current step starts.
    for (const { solid, from } of lengths) expect(from).toBeCloseTo(solid, 3);
    expect(lengths.map(({ solid }) => solid)).toEqual([
      0, 1.964, 3.927, 5.891, 7.854, 9.818, 11.781, 13.745,
    ]);
  });

  it('draws nothing finished at Brief, and the last eighth as the current step at Render', () => {
    const [firstFinished, firstCurrent] = pie(icon('editing', 1));
    expect(firstFinished).toContain('stroke-dasharray="0 15.708"');
    expect(firstCurrent).toContain('stroke-dashoffset="0"');
    const [, last] = pie(icon('editing', 8));
    expect(last).toContain('stroke-dashoffset="-13.745"');
  });

  it('has an empty pie, and no current step, with no step at all', () => {
    const markup = icon('editing', null);
    expect(attr(svg(markup), 'data-done')).toBe('0');
    expect(pie(markup)).toHaveLength(1);
    expect(pie(markup)[0]).toContain('stroke-dasharray="0 15.708"');
  });
});

describe('<JobStatusIcon>: Uploaded', () => {
  it('is a disc with an arrow up, cut out of it in the page background', () => {
    const markup = icon('uploaded');
    expect(markup).toContain('<circle cx="8" cy="8" r="7" fill="currentColor"');
    expect(markup).toContain('d="M8 11.2V4.8M5.4 7.4 8 4.8l2.6 2.6"');
    expect(markup).toContain('stroke="var(--background)"');
  });

  it('is not the arrow of Delivered, which points right', () => {
    expect(icon('uploaded')).not.toEqual(icon('delivered'));
    expect(icon('delivered')).toContain('d="M4.8 8h6.1M8.4 5.4 11 8l-2.6 2.6"');
  });
});

describe('<JobStatusIcon>: the tooltip', () => {
  it('shows the same name as the icon’s label on hover', () => {
    for (const kind of ICON_KINDS) {
      // The component has no hooks: its element tree is the Tooltip, trigger and content.
      const tooltip = JobStatusIcon({ job: jobOf(kind) }) as ReactElement<{
        children: ReactElement<{ children?: unknown }>[];
      }>;
      const [trigger, content] = tooltip.props.children;
      expect(isValidElement(trigger)).toBe(true);
      expect(content?.props.children, kind).toBe(ICON_LABELS[kind]);
    }
  });

  it('is on the icon itself: the markup is the icon alone, with the tooltip closed', () => {
    const markup = icon('approved');
    expect(markup.startsWith('<svg')).toBe(true);
    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain('data-slot="tooltip-content"');
  });
});

describe('<StatusGlyph>: the icon on its own', () => {
  it('draws the same shapes as the job list’s icon, at the size asked for', () => {
    for (const kind of ICON_KINDS) {
      const listed = icon(kind);
      const glyph = renderToStaticMarkup(<StatusGlyph kind={kind} size={14} />);
      expect(attr(svg(glyph), 'width'), kind).toBe('14');
      expect(attr(svg(glyph), 'height'), kind).toBe('14');
      expect(attr(svg(glyph), 'viewBox'), kind).toBe('0 0 16 16');
      expect(attr(svg(glyph), 'class'), kind).toContain(STATUS_ICON_CLASSES[kind]);
      // Everything inside the <svg> is the same drawing.
      const inner = (markup: string) => markup.slice(markup.indexOf('>') + 1);
      expect(inner(glyph), kind).toBe(inner(listed));
    }
  });

  it('is 16 px by default, with no name and no tooltip: the caller names it or hides it', () => {
    const glyph = renderToStaticMarkup(<StatusGlyph kind="delivered" aria-hidden="true" />);
    expect(attr(svg(glyph), 'width')).toBe('16');
    expect(attr(svg(glyph), 'aria-hidden')).toBe('true');
    expect(attr(svg(glyph), 'role')).toBeUndefined();
    expect(attr(svg(glyph), 'aria-label')).toBeUndefined();
    expect(glyph).not.toContain('data-state');
  });
});
