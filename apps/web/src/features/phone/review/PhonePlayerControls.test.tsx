import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import type { PlayerControlsProps } from '@/features/review/PlayerControls';
import { PhonePlayerControls } from './PhonePlayerControls';

const noop = () => {};

function controls(
  override: Partial<PlayerControlsProps> = {},
  props: Partial<React.ComponentProps<typeof PhonePlayerControls>> = {},
): string {
  return render(
    <PhonePlayerControls
      controls={{
        currentSec: 3.4,
        durationSec: 44,
        playing: false,
        muted: false,
        volume: 0.8,
        fullscreen: false,
        onTogglePlay: noop,
        onSeek: noop,
        onToggleMute: noop,
        onVolumeChange: noop,
        onToggleFullscreen: noop,
        ...override,
      }}
      noteCount={2}
      notesOpen={false}
      onToggleNotes={noop}
      {...props}
    />,
  );
}

/** The opening tag of the first element in `html` that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('<PhonePlayerControls>', () => {
  it('has the 32 px timeline: the playhead, the track and the length', () => {
    const html = controls();
    const timeline = tagWith(html, 'data-slot="phone-timeline"');
    expect(timeline).toContain('h-8');
    expect(html).toContain('0:03');
    expect(html).toContain('0:44');
    expect(html).toContain('aria-label="Position in the video"');
  });

  it('draws the notes’ dots on the track', () => {
    const html = controls({ timelineOverlay: <i data-testid="dots" /> });
    expect(html.indexOf('data-testid="dots"')).toBeGreaterThan(html.indexOf('data-slot="slider"'));
    expect(html).toContain('pointer-events-none absolute inset-0');
  });

  it('has the 52 px row: Play first, then Notes N, Record and Write', () => {
    const html = controls();
    expect(tagWith(html, 'data-slot="phone-review-controls"')).toContain('h-[52px]');
    const play = tagWith(html, 'aria-label="Play"');
    expect(play).toContain('size-11');
    expect(play).toContain('data-variant="ghost"');
    const order = ['aria-label="Play"', 'Notes', 'Record', 'Write'].map((word) =>
      html.indexOf(word),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(tagWith(html, 'data-slot="phone-note-count"')).toContain('rounded-full');
    expect(html).toMatch(/data-slot="phone-note-count"[^>]*>2</);
  });

  it('turns Play into Pause while it plays', () => {
    expect(controls({ playing: true })).toContain('aria-label="Pause"');
    expect(controls({ playing: true })).not.toContain('aria-label="Play"');
  });

  it('presses Notes while the list is open', () => {
    expect(controls({}, { notesOpen: true })).toMatch(
      /aria-pressed="true"[^>]*>(<svg.*?<\/svg>)?Notes/,
    );
    expect(controls({}, { notesOpen: false })).toMatch(
      /aria-pressed="false"[^>]*>(<svg.*?<\/svg>)?Notes/,
    );
  });

  it('has no full screen control (iPhone Safari has none for an element) and no volume', () => {
    const html = controls();
    expect(html.toLowerCase()).not.toContain('full screen');
    expect(html).not.toContain('Volume');
    expect(html).not.toContain('Mute');
  });

  it('drops the row once Send or Approve went through, and keeps the timeline (board MReviewDone)', () => {
    const html = controls({}, { showButtons: false });
    expect(html).not.toContain('data-slot="phone-review-controls"');
    expect(html).not.toContain('aria-label="Play"');
    expect(html).not.toContain('Notes');
    expect(html).toContain('data-slot="phone-timeline"');
  });

  it('waits until the player is ready', () => {
    const html = controls({ disabled: true });
    expect(tagWith(html, 'aria-label="Play"')).toContain('disabled');
  });

  it('presses Write while the note box is open, and Play is off meanwhile (board MReviewWrite)', () => {
    const writing = controls({}, { writing: true, playLocked: true });
    expect(writing).toMatch(/aria-pressed="true"[^>]*>(<svg.*?<\/svg>)?Write/);
    expect(tagWith(writing, 'aria-label="Play"')).toContain('disabled=""');

    const watching = controls();
    expect(watching).toMatch(/aria-pressed="false"[^>]*>(<svg.*?<\/svg>)?Write/);
    expect(tagWith(watching, 'aria-label="Play"')).not.toContain('disabled=""');
  });

  it('Record is a plain button, not a toggle', () => {
    const html = controls();
    const end = html.indexOf('Record</button>');
    const record = html.slice(
      html.lastIndexOf('<button', end),
      html.indexOf('>', html.lastIndexOf('<button', end)) + 1,
    );
    expect(record).toContain('data-variant="outline"');
    expect(record).not.toContain('aria-pressed');
  });
});
