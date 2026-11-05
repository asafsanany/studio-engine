import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { PlayerControls, type PlayerControlsProps } from './PlayerControls';

const noop = () => {};

function controls(props: Partial<PlayerControlsProps> = {}): string {
  return render(
    <PlayerControls
      currentSec={3.4}
      durationSec={6}
      playing={false}
      muted={false}
      volume={0.8}
      fullscreen={false}
      onTogglePlay={noop}
      onSeek={noop}
      onToggleMute={noop}
      onVolumeChange={noop}
      onToggleFullscreen={noop}
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

describe('<PlayerControls>', () => {
  it('is the board’s 76 px bar: a top border on the background, padded 8 / 12 / 9', () => {
    const html = controls();
    expect(html).toMatch(/^<div data-slot="player-controls"/);
    const bar = tagWith(html, 'data-slot="player-controls"');
    for (const name of [
      'h-[76px]',
      'shrink-0',
      'flex-col',
      'gap-1.5',
      'border-t',
      'bg-background',
    ]) {
      expect(bar, name).toContain(name);
    }
    expect(bar).toContain('px-3 pt-2 pb-[9px]');
  });

  it('shows Play with the Play icon when paused', () => {
    const html = controls({ playing: false });
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain('lucide-play');
    expect(html).not.toContain('aria-label="Pause"');
  });

  it('shows Pause with the Pause icon while playing', () => {
    const html = controls({ playing: true });
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('lucide-pause');
    expect(html).not.toContain('aria-label="Play"');
  });

  it('draws the play and pause icons filled, not outlined (the board)', () => {
    const icon = tagWith(controls(), 'lucide-play');
    expect(icon).toContain('size-[18px]');
    expect(icon).toContain('fill-current');
    expect(icon).toContain('stroke-none');
  });

  it('shows Mute with the speaker while the sound is on', () => {
    const html = controls();
    expect(html).toContain('aria-label="Mute"');
    expect(html).toContain('lucide-volume-2');
  });

  it('shows Unmute, the crossed speaker and an empty volume when muted', () => {
    const html = controls({ muted: true, volume: 0.8 });
    expect(html).toContain('aria-label="Unmute"');
    expect(html).toContain('lucide-volume-x');
    // The two slider ranges, the timeline's first: the volume slider is empty.
    const ranges = html.match(/data-slot="slider-range"[^>]*style="[^"]*"/g) ?? [];
    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toContain('right:100%');
  });

  it('shows Unmute at volume 0 even when not muted', () => {
    const html = controls({ muted: false, volume: 0 });
    expect(html).toContain('aria-label="Unmute"');
    expect(html).toContain('lucide-volume-x');
  });

  it('fills the volume slider to the volume', () => {
    const ranges = controls({ volume: 0.25 }).match(/data-slot="slider-range"[^>]*style="[^"]*"/g);
    expect(ranges?.[1]).toContain('right:75%');
  });

  it('shows Full screen and the Maximize icon, then Exit full screen and Minimize', () => {
    const normal = controls();
    expect(normal).toContain('aria-label="Full screen"');
    expect(normal).toContain('lucide-maximize');
    expect(normal).not.toContain('lucide-minimize');

    const full = controls({ fullscreen: true });
    expect(full).toContain('aria-label="Exit full screen"');
    expect(full).toContain('lucide-minimize');
    expect(full).not.toContain('lucide-maximize');
  });

  it('has exactly three buttons, no skip buttons, and no title attributes', () => {
    const html = controls();
    expect(html.match(/<button /g)).toHaveLength(3);
    expect(html).not.toMatch(/\btitle=/);
    expect(html).not.toMatch(/skip|forward|backward|rewind/i);
  });

  it('writes the playhead and the length as clocks, in small tabular figures', () => {
    const html = controls({ currentSec: 3.4, durationSec: 6 });
    const playhead = html.match(/<span class="([^"]*)">0:03<\/span>/);
    const length = html.match(/<span class="([^"]*)">0:06<\/span>/);
    expect(playhead?.[1]).toBe('shrink-0 text-xs tabular-nums text-foreground');
    expect(length?.[1]).toBe('shrink-0 text-xs tabular-nums text-muted-foreground');
  });

  it('names the timeline, bounds it by the length and fills it to the playhead', () => {
    const html = controls({ currentSec: 3.4, durationSec: 6 });
    const timeline = tagWith(html, 'aria-label="Position in the video"');
    expect(timeline).toContain('role="slider"');
    expect(timeline).toContain('aria-valuemin="0"');
    expect(timeline).toContain('aria-valuemax="6"');
    // Radix renders no aria-valuenow on the server, so the Range shows the value: 100 - 3.4/6.
    const range = html.match(/data-slot="slider-range"[^>]*style="([^"]*)"/);
    expect(range?.[1]).toMatch(/^left:0%;right:43\.33+\d*%$/);
  });

  it('bounds the timeline by 1 while the length is unknown', () => {
    const timeline = tagWith(
      controls({ currentSec: 0, durationSec: 0 }),
      'aria-label="Position in the video"',
    );
    expect(timeline).toContain('aria-valuemax="1"');
  });

  it('names the volume slider', () => {
    const volume = tagWith(controls(), 'aria-label="Volume"');
    expect(volume).toContain('role="slider"');
    expect(volume).toContain('aria-valuemax="1"');
  });

  it('makes every button a ghost icon-sm button', () => {
    const html = controls();
    const buttons = html.match(/<button [^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button).toContain('type="button"');
      expect(button).toContain('data-variant="ghost"');
      expect(button).toContain('data-size="icon-sm"');
    }
  });

  it('renders the timeline overlay inside the slider, before the thumb', () => {
    const html = controls({ timelineOverlay: <i data-testid="note-dot" /> });
    const track = html.indexOf('data-slot="slider-track"');
    const dot = html.indexOf('data-testid="note-dot"');
    const thumb = html.indexOf('data-slot="slider-thumb"');
    expect(dot).toBeGreaterThan(track);
    expect(thumb).toBeGreaterThan(dot);
    // The layer does not catch the pointer, so a click on the track still seeks.
    expect(html).toContain(
      '<div class="pointer-events-none absolute inset-0"><i data-testid="note-dot"',
    );
  });

  it('draws no overlay layer without an overlay', () => {
    expect(controls()).not.toContain('pointer-events-none absolute inset-0');
  });

  it('disables every button and both sliders when it is not ready', () => {
    const html = controls({ disabled: true });
    const buttons = html.match(/<button [^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toContain('disabled=""');
    expect(html.match(/data-slot="slider" /g)).toHaveLength(2);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html.match(/<span [^>]*data-disabled=""[^>]*data-slot="slider"/g)).toHaveLength(2);
  });

  it('enables everything when ready', () => {
    const html = controls();
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('data-disabled');
  });

  it('keeps the stock look: no blue, no primary fill or ring, a neutral keyboard-only ring', () => {
    const html = controls();
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1] ?? '');
    for (const className of classes) {
      expect(className).not.toMatch(/blue|bg-primary|ring-primary/);
    }
    expect(html).toContain('focus-visible:ring-ring/35');
    expect(html).toContain('bg-foreground');
    // The thumb is white, 12 px, with no border; the volume thumb is 10 px.
    const thumbs = html.match(/<span [^>]*data-slot="slider-thumb"[^>]*>/g) ?? [];
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toMatch(/\bsize-3\b/);
    expect(thumbs[0]).toMatch(/\bborder-0\b/);
    expect(thumbs[1]).toMatch(/\bsize-2\.5\b/);
  });

  it('takes a class name', () => {
    expect(tagWith(controls({ className: 'w-[315px]' }), 'data-slot="player-controls"')).toContain(
      'w-[315px]',
    );
  });

  it('draws a trailing note (what the video plays) at the right, before full screen', () => {
    const html = controls({ trailing: <span data-slot="music-now">Music v2</span> });
    expect(html).toContain('<span data-slot="music-now">Music v2</span>');
    expect(html.indexOf('Music v2')).toBeGreaterThan(html.indexOf('aria-label="Volume"'));
    expect(html.indexOf('Music v2')).toBeLessThan(html.indexOf('aria-label="Full screen"'));
  });

  it('keeps the trailing note inside the bar: it takes the room left and is for screen readers in a narrow bar', () => {
    const html = controls({ trailing: <span data-slot="music-now">Music v2</span> });
    expect(tagWith(html, 'data-slot="player-controls"')).toContain('@container');
    const slot = tagWith(html, 'data-slot="player-trailing"');
    for (const name of ['min-w-0', 'flex-1', 'justify-end', '@max-[440px]:*:sr-only']) {
      expect(slot).toContain(name);
    }
    expect(html.indexOf('data-slot="player-trailing"')).toBeLessThan(html.indexOf('Music v2'));
  });

  it('has nothing there by default', () => {
    expect(controls()).not.toContain('music-now');
  });

  it('has no speed without onSpeedChange (the phone and Graphics draw their own bars)', () => {
    expect(controls()).not.toContain('data-slot="player-speed"');
    expect(controls()).not.toContain('aria-label="Playback speed"');
  });

  it('draws the speed after the volume: its readout, then a 0.3× to 3× slider', () => {
    const html = controls({ speed: 1.5, onSpeedChange: noop });
    const speed = tagWith(html, 'aria-label="Playback speed"');
    expect(speed).toContain('role="slider"');
    expect(speed).toContain('aria-valuemin="0.3"');
    expect(speed).toContain('aria-valuemax="3"');
    const reset = html.match(
      /<button [^>]*aria-label="Back to normal speed"[^>]*>([^<]*)<\/button>/,
    );
    expect(reset?.[1]).toBe('1.5×');
    expect(reset?.[0]).toContain('tabular-nums');
    expect(html.indexOf('data-slot="player-speed"')).toBeGreaterThan(
      html.indexOf('aria-label="Volume"'),
    );
    expect(html.indexOf('data-slot="player-speed"')).toBeLessThan(
      html.indexOf('aria-label="Full screen"'),
    );
  });

  it('reads 1× by default, and disables the speed with the rest while loading', () => {
    const html = controls({ onSpeedChange: noop, disabled: true });
    const reset = html.match(
      /<button [^>]*aria-label="Back to normal speed"[^>]*>([^<]*)<\/button>/,
    );
    expect(reset?.[1]).toBe('1×');
    expect(reset?.[0]).toContain('disabled=""');
    expect(tagWith(html, 'aria-label="Playback speed"')).toContain('data-disabled=""');
  });
});
