import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { GraphicControls, type GraphicControlsProps } from './GraphicControls';

const noop = () => {};

function controls(props: Partial<GraphicControlsProps> = {}): string {
  return render(
    <GraphicControls
      currentSec={1.2}
      durationSec={3.8}
      playing={false}
      onTogglePlay={noop}
      onReplay={noop}
      onSeek={noop}
      {...props}
    />,
  );
}

describe('<GraphicControls>', () => {
  it('is a 420 px column of play/pause, play from the start, the timeline and the time', () => {
    const html = controls();
    expect(html).toContain('data-slot="graphic-controls"');
    expect(html).toContain('max-w-[420px]');
    expect(html.indexOf('aria-label="Play"')).toBeLessThan(
      html.indexOf('aria-label="Play from the start"'),
    );
    expect(html.indexOf('aria-label="Play from the start"')).toBeLessThan(
      html.indexOf('data-slot="slider"'),
    );
    expect(html.indexOf('data-slot="slider"')).toBeLessThan(html.indexOf('1.2 / 3.0 s'));
  });

  it('says Pause while playing and Play while paused', () => {
    expect(controls({ playing: true })).toContain('aria-label="Pause"');
    expect(controls({ playing: true })).toContain('lucide-pause');
    expect(controls({ playing: false })).toContain('aria-label="Play"');
    expect(controls({ playing: false })).toContain('lucide-play');
  });

  it('reads the time against the graphic’s own length, without the tail', () => {
    expect(controls({ currentSec: 0.5, durationSec: 3.8 })).toContain('0.5 / 3.0 s');
    expect(controls({ currentSec: 3.6, durationSec: 3.8 })).toContain('3.0 / 3.0 s');
    expect(controls({ currentSec: 0, durationSec: 13.05 })).toContain('0.0 / 12.3 s');
  });

  it('has a timeline labelled Time that runs over the whole loop', () => {
    const html = controls({ currentSec: 1.9, durationSec: 3.8 });
    expect(html).toContain('aria-label="Time"');
    expect(html).toContain('aria-valuemax="3.8"');
    // Half way through the loop: the filled part of the track ends at 50 %.
    expect(html).toContain('style="left:0%;right:50%"');
  });

  it('dims the whole bar and disables its buttons and timeline when there is nothing to play', () => {
    const html = controls({ disabled: true });
    expect(html).toContain('opacity-40');
    expect(html.match(/<button [^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain('data-disabled=""');
  });

  it('is full strength when it can play', () => {
    const html = controls();
    expect(html).not.toContain('opacity-40');
    expect(html).not.toMatch(/<button [^>]*disabled=""/);
  });

  it('eases its dimming in and out', () => {
    expect(controls()).toContain('ease-in-out');
  });
});
