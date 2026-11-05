import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { NoteDots } from './NoteDots';
import { timelineLeft } from './player-state';
import { renderReview, tagWith } from './test-helpers';

const text = makeReviewNote({ id: 'n1', atSec: 2.4 });
const voice = makeReviewNote({ id: 'n2', atSec: 7.8, kind: 'voice' });

function dots(props: Partial<React.ComponentProps<typeof NoteDots>> = {}): string {
  return renderReview(
    <NoteDots
      notes={[text, voice]}
      durationSec={28}
      hoveredId={null}
      isActive={() => false}
      onHover={() => {}}
      onSelect={() => {}}
      {...props}
    />,
  );
}

describe('<NoteDots>', () => {
  it('is a button for each note, named by its time and kind', () => {
    const html = dots();
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(tagWith(html, 'data-note-id="n1"')).toContain('aria-label="Note at 0:02"');
    expect(tagWith(html, 'data-note-id="n2"')).toContain('aria-label="Voice note at 0:07"');
  });

  it('is a mouse target: out of the tab order, and it takes the pointer back from the overlay', () => {
    const tag = tagWith(dots(), 'data-note-id="n1"');
    expect(tag).toContain('type="button"');
    expect(tag).toContain('tabindex="-1"');
    expect(tag).toContain('data-slot="note-dot"');
    expect(tag).toContain('pointer-events-auto');
    expect(tag).toContain('cursor-pointer');
    expect(tag).toContain('size-3.5');
  });

  it('sits where the slider’s thumb would be for that time', () => {
    const html = dots();
    expect(tagWith(html, 'data-note-id="n1"')).toContain(`left:${timelineLeft(2.4, 28)}`);
    expect(tagWith(html, 'data-note-id="n2"')).toContain(`left:${timelineLeft(7.8, 28)}`);
    expect(timelineLeft(2.4, 28)).toMatch(/^calc\(/);
  });

  it('is an 8 px blue dot with a ring in the dialog’s colour', () => {
    const html = dots();
    const dot = html.slice(html.indexOf('<span'), html.indexOf('</span>'));
    expect(dot).toContain('size-2"');
    expect(dot).not.toContain('size-2.5');
    expect(dot).toContain('bg-[#3B82F6]');
    expect(dot).toContain('shadow-[0_0_0_2px_#09090B]');
    expect(dot).toContain('ease-in-out');
    expect(dot).toContain('aria-hidden="true"');
  });

  it('is 10 px when its note is hovered or active', () => {
    const hovered = dots({ hoveredId: 'n1' });
    expect(hovered.slice(hovered.indexOf('<span'), hovered.indexOf('</span>'))).toContain(
      'size-2.5',
    );
    const second = hovered.slice(hovered.indexOf('data-note-id="n2"'));
    expect(second.slice(second.indexOf('<span'), second.indexOf('</span>'))).not.toContain(
      'size-2.5',
    );

    const active = dots({ isActive: (note) => note.id === 'n2' });
    const afterSecond = active.slice(active.indexOf('data-note-id="n2"'));
    expect(
      afterSecond.slice(afterSecond.indexOf('<span'), afterSecond.indexOf('</span>')),
    ).toContain('size-2.5');
  });

  it('draws nothing when the video has no length yet', () => {
    expect(dots({ durationSec: 0 })).toBe('');
  });

  it('draws nothing for no notes', () => {
    expect(dots({ notes: [] })).toBe('');
  });

  it('draws no red pin unless a voice note is being recorded', () => {
    expect(dots()).not.toContain('data-slot="recording-pin"');
    expect(dots({ recordingAtSec: null })).not.toContain('data-slot="recording-pin"');
  });
});

describe('<NoteDots> with a recording', () => {
  it('marks the moment with a red pin, named by its time, where the slider’s thumb would be', () => {
    const pin = tagWith(dots({ recordingAtSec: 2.4 }), 'data-slot="recording-pin"');
    expect(pin).toContain('role="img"');
    expect(pin).toContain('aria-label="Recording at 0:02"');
    expect(pin).toContain('bg-[#F87171]');
    expect(pin).toContain('size-2.5');
    expect(pin).toContain('rounded-full');
    expect(pin).toContain('shadow-[0_0_0_2px_#09090B]');
    expect(pin).toContain(`left:${timelineLeft(2.4, 28)}`);
  });

  it('is drawn above the slider’s thumb, so it shows when the playhead is where the note is pinned', () => {
    // Record pauses the video and pins the note at the playhead: the thumb is on the same spot, and
    // the dots (below the thumb) would hide the pin without a z-index.
    expect(tagWith(dots({ recordingAtSec: 2.4 }), 'data-slot="recording-pin"')).toContain('z-10');
    expect(tagWith(dots(), 'data-slot="note-dot"')).not.toContain('z-10');
  });

  it('is not clickable: no button, no pointer events taken back', () => {
    const html = dots({ notes: [], recordingAtSec: 2.4 });
    const pin = tagWith(html, 'data-slot="recording-pin"');
    expect(pin).toContain('<span');
    expect(pin).not.toContain('pointer-events-auto');
    expect(html).not.toContain('<button');
  });

  it('shows with no notes at all', () => {
    const html = dots({ notes: [], recordingAtSec: 2.4 });
    expect(html).toContain('data-slot="recording-pin"');
    expect(html).not.toContain('data-slot="note-dot"');
  });

  it('stays next to the notes’ dots', () => {
    const html = dots({ recordingAtSec: 0 });
    expect(html.match(/data-slot="note-dot"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Recording at 0:00"');
    expect(tagWith(html, 'data-slot="recording-pin"')).toContain(`left:${timelineLeft(0, 28)}`);
  });

  it('draws nothing while the video has no length', () => {
    expect(dots({ durationSec: 0, recordingAtSec: 2.4 })).toBe('');
  });
});

describe('<NoteDots> on the phone', () => {
  it('has a 28 px hit box (board MReview) instead of the Mac’s 14 px', () => {
    const tag = tagWith(dots({ variant: 'phone' }), 'data-note-id="n1"');
    expect(tag).toContain('size-7');
    expect(tag).not.toContain('size-3.5');
    expect(tag).toContain('pointer-events-auto');
  });

  it('sits where a 14 px thumb would be, not a 12 px one', () => {
    const html = dots({ variant: 'phone' });
    expect(tagWith(html, 'data-note-id="n1"')).toContain(`left:${timelineLeft(2.4, 28, 14)}`);
    expect(tagWith(html, 'data-note-id="n2"')).toContain(`left:${timelineLeft(7.8, 28, 14)}`);
  });
});
