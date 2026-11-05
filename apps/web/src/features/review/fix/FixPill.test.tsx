import { describe, expect, it } from 'vitest';
import { renderReview, tagWith } from '../test-helpers';
import { FixPill } from './FixPill';
import type { FixPillFit, FixPillView } from './fix-pill';

// The pill on the video for a quick fix (board QFReview, states 3 to 5). What it does when held is
// in the browser; the keys that hold it are compareKeyAction's (paused-look.test.ts).

const FIXING: FixPillView = { kind: 'fixing', fixId: 'f1', time: '0:12' };
const CHANGED: FixPillView = {
  kind: 'changed',
  fixId: 'f1',
  time: '0:12',
  beforeSrc: '/api/jobs/a1/fixes/f1/compare/before.png',
};
const NO_COMPARE: FixPillView = { ...CHANGED, beforeSrc: null };

function pill(view: FixPillView, comparing = false, fit?: FixPillFit): string {
  return renderReview(<FixPill view={view} comparing={comparing} fit={fit} />);
}

describe('<FixPill> while a fix runs', () => {
  it('says "Fixing at 0:12…" with a spinner and no button', () => {
    const html = pill(FIXING);
    expect(html).toContain('>Fixing at 0:12…<');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Compare');
  });

  it('is a status, not a control: no keys of its own', () => {
    const wrapper = tagWith(pill(FIXING), 'data-slot="fix-pill"');
    expect(wrapper).toContain('role="status"');
    expect(wrapper).toContain('data-state="fixing"');
    expect(wrapper).not.toContain('data-own-keys');
  });
});

describe('<FixPill> after a fix', () => {
  it('says "Changed at 0:12" with a Compare button', () => {
    const html = pill(CHANGED);
    expect(html).toContain('>Changed at 0:12<');
    expect(html).toContain('>Compare<');
    expect(tagWith(html, 'aria-pressed')).toContain('aria-pressed="false"');
    expect(tagWith(html, 'data-slot="fix-pill"')).toContain('data-state="changed"');
  });

  it('says "Before the fix" while Compare is held, and shows Compare pressed', () => {
    const html = pill(CHANGED, true);
    expect(tagWith(html, 'aria-pressed')).toContain('aria-pressed="true"');
    expect(tagWith(html, 'data-slot="fix-pill"')).toContain('data-state="comparing"');
    // Both lines are there, so the pill keeps its width and Compare does not move out from under a
    // pointer that holds it; the one that is not said is invisible.
    expect(html).toMatch(/<span class="[^"]*invisible[^"]*">Changed at 0:12<\/span>/);
    expect(html).toMatch(/<span class="[^"]*">Before the fix<\/span>/);
    expect(html).not.toMatch(/invisible[^>]*>Before the fix</);
  });

  it('hides "Before the fix" while Compare is not held', () => {
    const html = pill(CHANGED);
    expect(html).toMatch(/<span class="[^"]*invisible[^"]*">Before the fix<\/span>/);
    expect(html).not.toMatch(/invisible[^>]*>Changed at 0:12</);
  });

  it('has Space and Enter for Compare, not for play/pause', () => {
    expect(tagWith(pill(CHANGED), 'data-slot="fix-pill"')).toContain('data-own-keys=""');
  });

  it('says "Changed at 0:12" alone without a before still: no Compare button', () => {
    const html = pill(NO_COMPARE);
    expect(html).toContain('>Changed at 0:12<');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Compare');
    expect(html).not.toContain('Before the fix');
  });
});

describe('<FixPill> look', () => {
  it('is the font pill’s: bottom left, 34 px high, the same colours', () => {
    for (const view of [FIXING, CHANGED]) {
      const wrapper = tagWith(pill(view), 'data-slot="fix-pill"');
      expect(wrapper).toContain('absolute bottom-2.5 left-2.5');
      expect(wrapper).toContain('h-[34px]');
      expect(wrapper).toContain('rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)]');
      expect(wrapper).toContain('text-xs');
      expect(wrapper).toContain('text-[#FAFAFA]');
    }
  });

  it('has the Compare button of the paused frame’s pill, ghost and 26 px high', () => {
    const button = tagWith(pill(CHANGED), 'aria-pressed');
    expect(button).toContain('type="button"');
    expect(button).toContain('h-[26px]');
    expect(button).toContain('cursor-pointer');
  });

  it('writes the words left to right, whatever the page’s direction', () => {
    expect(pill(CHANGED)).toContain('dir="ltr"');
    expect(pill(FIXING)).toContain('dir="ltr"');
  });
});

// CVP-404 (C58): on the phone the video is 146 px wide with the notes list open, so the pill is as
// wide as its words need and may reach past the video's edge, with a Compare a finger can hit.
describe('<FixPill> on the phone', () => {
  it('is the Mac’s by default: inside the video, cut with an ellipsis, Compare 26 px', () => {
    for (const view of [FIXING, CHANGED]) {
      const html = pill(view);
      const wrapper = tagWith(html, 'data-slot="fix-pill"');
      expect(wrapper).toContain('data-fit="video"');
      expect(wrapper).toContain('max-w-[calc(100%-20px)]');
      expect(wrapper).not.toContain('w-max');
      expect(html).toContain('truncate');
    }
    expect(tagWith(pill(CHANGED), 'aria-pressed')).not.toContain('h-8');
  });

  it('is as wide as its words at the corner: no maximum width, no cut words, 40 px high', () => {
    for (const view of [FIXING, CHANGED]) {
      const html = pill(view, false, 'corner');
      const wrapper = tagWith(html, 'data-slot="fix-pill"');
      expect(wrapper).toContain('data-fit="corner"');
      expect(wrapper).toContain('absolute bottom-2.5 left-2.5');
      expect(wrapper).toContain('h-10 w-max');
      expect(wrapper).not.toContain('max-w-');
      expect(wrapper).not.toContain('h-[34px]');
      expect(html).not.toContain('truncate');
    }
  });

  it('is in the middle of the video’s bottom, as wide as its words, when the video is narrow', () => {
    for (const view of [FIXING, CHANGED]) {
      const html = pill(view, false, 'centered');
      const wrapper = tagWith(html, 'data-slot="fix-pill"');
      expect(wrapper).toContain('data-fit="centered"');
      expect(wrapper).toContain('absolute bottom-2.5 left-1/2');
      expect(wrapper).toContain('h-10 w-max -translate-x-1/2');
      expect(wrapper).not.toContain('left-2.5');
      expect(wrapper).not.toContain('max-w-');
      expect(html).not.toContain('truncate');
    }
  });

  it('has a Compare button 32 px high for a finger, and keeps the board’s words', () => {
    for (const fit of ['corner', 'centered'] as const) {
      const button = tagWith(pill(CHANGED, false, fit), 'aria-pressed');
      expect(button).toContain('h-8');
      expect(button).not.toContain('h-[26px]');
      expect(pill(CHANGED, false, fit)).toContain('>Changed at 0:12<');
      expect(pill(CHANGED, true, fit)).toContain('>Before the fix<');
      expect(pill(FIXING, false, fit)).toContain('>Fixing at 0:12…<');
    }
  });

  it('keeps the same look and its keys: colours, own keys, left to right', () => {
    const wrapper = tagWith(pill(CHANGED, false, 'centered'), 'data-slot="fix-pill"');
    expect(wrapper).toContain('rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)]');
    expect(wrapper).toContain('data-own-keys=""');
    expect(pill(FIXING, false, 'centered')).toContain('role="status"');
  });
});
