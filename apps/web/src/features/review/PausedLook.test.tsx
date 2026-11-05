import { describe, expect, it } from 'vitest';
import { PausedLook, type PausedLookPhase, PausedLookView } from './PausedLook';
import { renderReview } from './test-helpers';

// The markup of the look on the paused frame in each of its states (board LUReview, chip and sent).
// What it does when pressed and loaded is in e2e/paused-look.spec.ts.

const TARGET = { slug: 'cinematic', token: 'luts/cinematic', count: 1 };

function view(
  props: Partial<React.ComponentProps<typeof PausedLookView>> & { phase: PausedLookPhase },
): string {
  return renderReview(
    <PausedLookView
      target={TARGET}
      lutSrc="/api/jobs/j1/review/frame?t=12&lut=cinematic"
      plainSrc="/api/jobs/j1/review/frame?t=12"
      timeLabel="0:12"
      plainFailed={false}
      comparing={false}
      skeleton={false}
      {...props}
    />,
  );
}

describe('<PausedLook>', () => {
  it('first draws the pictures out of sight, with no pill: the video is never covered by half a picture', () => {
    const html = renderReview(
      <PausedLook
        target={TARGET}
        lutSrc="/api/jobs/j1/review/frame?t=12&lut=cinematic"
        plainSrc="/api/jobs/j1/review/frame?t=12"
        timeLabel="0:12"
      />,
    );
    expect(html).toContain('data-phase="loading"');
    expect(html).toContain('class="absolute inset-0 invisible"');
    expect(html).not.toContain('Previewing');
    expect(html).not.toContain('data-slot="paused-look-skeleton"');
  });

  it('is the plain frame with the frame with the LUT over it, the pill and Compare, once loaded', () => {
    const html = view({ phase: 'shown' });
    expect(html).not.toContain('invisible');
    expect(html).toContain('alt="Frame from the video at 0:12"');
    expect(html.indexOf('review/frame?t=12"')).toBeLessThan(html.indexOf('lut=cinematic"'));
    expect(html).toContain('Previewing luts/cinematic');
    expect(html).toContain('>Compare<');
    expect(html).toContain('aria-pressed="false"');
    // The look is fully there, and fades with the board's 150 ms ease-in-out.
    expect(html).toContain('opacity-100');
    expect(html).toContain('duration-150 ease-in-out');
  });

  it('puts the pill at the bottom left, 34 px high, and lets clicks through everywhere else', () => {
    const html = view({ phase: 'shown' });
    expect(html).toContain('pointer-events-none absolute inset-0');
    expect(html).toContain('pointer-events-auto absolute bottom-2.5 left-2.5');
    expect(html).toContain('h-[34px]');
    // Space and Enter belong to Compare there, not to play/pause.
    expect(html).toContain('data-own-keys=""');
  });

  it('says "the last of 2" when the note names several', () => {
    const html = view({ phase: 'shown', target: { ...TARGET, count: 2 } });
    expect(html).toContain('Previewing the last of 2');
    expect(html).not.toContain('Previewing luts/');
  });

  it('fades the look out while Compare is held, and shows it pressed', () => {
    const html = view({ phase: 'shown', comparing: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('opacity-0');
    expect(html).not.toContain('opacity-100');
  });

  it('shows a skeleton where the pill goes after a wait, and no pill', () => {
    const html = view({ phase: 'loading', skeleton: true });
    expect(html).toContain('data-slot="paused-look-skeleton"');
    expect(html).toContain('invisible');
    expect(html).not.toContain('Previewing');
    expect(html).not.toContain('>Compare<');
  });

  it('shows nothing at all when the frame failed', () => {
    const html = view({ phase: 'failed' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Previewing');
    expect(html).not.toContain('Compare');
    expect(html).not.toContain('skeleton');
  });

  it('leaves out the plain frame when it failed: Compare then shows the video itself', () => {
    const html = view({ phase: 'shown', plainFailed: true });
    expect(html).not.toContain('alt="Frame from the video');
    expect(html).toContain('lut=cinematic');
    expect(html).toContain('>Compare<');
  });
});
