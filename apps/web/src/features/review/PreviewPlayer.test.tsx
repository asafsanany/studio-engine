import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { fontPickerCatalog } from '@/features/library-picker/font-picker';
import { FONT_LIST } from '@/features/library-picker/test-helpers';
import { fontPreviewPlan } from './font-preview';
import { PlayerError, PlayerSkeleton } from './PlayerStates';
import { PreviewPlayer, type PreviewPlayerProps } from './PreviewPlayer';

// Static renders of the first frame: the player is "loading" (nothing has happened yet). What it
// does afterwards (events, full screen, scrubbing) is covered in the browser; see the item.

function player(props: Partial<PreviewPlayerProps> = {}): string {
  return render(
    <PreviewPlayer
      src="/__dev/preview-sample/index.html"
      videoWidth={1080}
      videoHeight={1920}
      maxWidth={480}
      maxHeight={560}
      durationSec={6}
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

describe('<PreviewPlayer>', () => {
  it('draws the poster over the video, filling the box, until it plays (the iPhone’s black frame)', () => {
    const html = player({ poster: '/api/jobs/j1/preview-poster?r=0' });
    const img = tagWith(html, 'data-slot="preview-poster"');
    expect(img).toMatch(/^<img/);
    expect(img).toContain('src="/api/jobs/j1/preview-poster?r=0"');
    expect(img).toContain('alt=""');
    expect(img).toContain('pointer-events-none absolute inset-0 size-full object-contain');
    // It comes after the player's element, so it is drawn over it.
    expect(html.indexOf('data-slot="preview-poster"')).toBeGreaterThan(
      html.indexOf('<hyperframes-player'),
    );
  });

  it('has no poster unless it is given one', () => {
    expect(player()).not.toContain('data-slot="preview-poster"');
  });

  it('is a labelled, focusable group in the loading state', () => {
    const column = tagWith(player(), 'data-slot="preview-player"');
    expect(column).toContain('data-status="loading"');
    expect(column).toContain('tabindex="-1"');
    expect(column).toContain('role="group"');
    expect(column).toContain('aria-label="Preview"');
    expect(column).toContain('flex flex-col bg-black outline-none');
  });

  it('makes the column exactly as wide as a 9:16 video: 315 × 560 in 480 × 560', () => {
    const html = player();
    expect(tagWith(html, 'data-slot="preview-player"')).toContain('style="width:315px"');
    expect(tagWith(html, '<hyperframes-player')).toContain('width:315px;height:560px');
  });

  it('holds a column and a stage of the largest format’s size, the video in the middle (two formats)', () => {
    // A 9:16 video in the box of a 1:1 one: 315 × 560 of 560 × 560.
    const html = player({ columnWidth: 560, stageHeight: 560, maxWidth: 560 });
    expect(tagWith(html, 'data-slot="preview-player"')).toContain('style="width:560px"');
    expect(tagWith(html, 'data-slot="preview-stage"')).toContain('style="height:560px"');
    expect(tagWith(html, 'data-slot="preview-stage"')).toContain('justify-center');
    expect(tagWith(html, '<hyperframes-player')).toContain('width:315px;height:560px');
  });

  it('is the column and the stage it always was without them', () => {
    expect(tagWith(player(), 'data-slot="preview-stage"')).not.toContain('style=');
  });

  it('makes the column exactly as wide as a 16:9 video: 448 × 252 in 448 × 560', () => {
    const html = player({ videoWidth: 1920, videoHeight: 1080, maxWidth: 448, maxHeight: 560 });
    expect(tagWith(html, 'data-slot="preview-player"')).toContain('style="width:448px"');
    expect(tagWith(html, '<hyperframes-player')).toContain('width:448px;height:252px');
  });

  it('renders the <hyperframes-player> element with the attributes the player needs', () => {
    const element = tagWith(player(), '<hyperframes-player');
    expect(element).toMatch(/^<hyperframes-player/);
    expect(element).toContain('src="/__dev/preview-sample/index.html"');
    expect(element).toContain('width="1080"');
    expect(element).toContain('height="1920"');
    expect(element).toContain('disable-click-to-play=""');
    expect(element).toContain('assets-loading-ui="none"');
    expect(element).toMatch(/runtime-src="[^"]*hyperframe\.runtime\.iife[^"]*\.js"/);
    expect(element).toContain('display:block');
  });

  it('plays once by default: the element has no loop attribute (Review never sets one)', () => {
    expect(tagWith(player(), '<hyperframes-player')).not.toMatch(/\bloop\b/);
    expect(tagWith(player({ loop: false }), '<hyperframes-player')).not.toMatch(/\bloop\b/);
  });

  it('turns on the player’s own loop with the loop prop, and changes nothing else', () => {
    const once = tagWith(player(), '<hyperframes-player');
    const looping = tagWith(player({ loop: true }), '<hyperframes-player');
    expect(looping).toMatch(/\bloop=""/);
    expect(looping.replace(' loop=""', '')).toBe(once);
  });

  it('plays at 1× by default: the element has no playback-rate, and the bar reads 1×', () => {
    const html = player();
    expect(tagWith(html, '<hyperframes-player')).not.toContain('playback-rate');
    expect(html).toMatch(/aria-label="Back to normal speed"[^>]*>1×<\/button>/);
  });

  it('gives the player the speed it is passed, kept to 0.3× to 3×', () => {
    expect(tagWith(player({ speed: 2 }), '<hyperframes-player')).toContain('playback-rate="2"');
    expect(tagWith(player({ speed: 0.1 }), '<hyperframes-player')).toContain('playback-rate="0.3"');
    expect(player({ speed: 2 })).toMatch(/aria-label="Back to normal speed"[^>]*>2×<\/button>/);
  });

  it('never turns on the player’s own controls, or a cross-origin sandbox', () => {
    const element = tagWith(player(), '<hyperframes-player');
    expect(element).not.toMatch(/\bcontrols\b/);
    expect(element).not.toContain('sandbox-origin');
  });

  it('keeps the runtime on our own origin, not on a CDN', () => {
    const runtime = /runtime-src="([^"]*)"/.exec(player())?.[1] ?? '';
    // A same-origin path (/@fs/... in dev, /assets/... in a build), never a full URL.
    expect(runtime).toMatch(/^\/[^/]/);
    expect(runtime).not.toContain('jsdelivr');
  });

  it('disables the controls while loading, and takes the length from durationSec', () => {
    const html = player();
    const controls = html.slice(html.indexOf('data-slot="player-controls"'));
    // Play, mute, the speed's readout and full screen.
    expect(controls.match(/<button [^>]*disabled=""/g)).toHaveLength(4);
    expect(controls).toContain('>0:06</span>');
    expect(controls).toContain('>0:00</span>');
  });

  it('shows 0:00 as the length without a durationSec', () => {
    const html = player({ durationSec: undefined });
    expect(html.slice(html.indexOf('data-slot="player-controls"'))).not.toContain('>0:06<');
  });

  it('draws no skeleton on the first render (it waits 300 ms), no error and no click catcher', () => {
    const html = player();
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('Loading the preview');
    expect(html).not.toContain('The preview didn');
    expect(html).not.toContain('cursor-pointer absolute');
    expect(html).not.toContain('aria-hidden="true" class="absolute inset-0 cursor-pointer"');
  });

  it('puts the timeline overlay in the timeline', () => {
    const html = player({ timelineOverlay: <i data-testid="note-dot" /> });
    expect(html.indexOf('data-testid="note-dot"')).toBeGreaterThan(
      html.indexOf('data-slot="slider-track"'),
    );
  });

  it('takes a class name for the column', () => {
    expect(tagWith(player({ className: 'rounded-lg' }), 'data-slot="preview-player"')).toContain(
      'rounded-lg',
    );
  });

  it('has the controls inside the column, under the video', () => {
    const html = player();
    expect(html.indexOf('data-slot="player-controls"')).toBeGreaterThan(
      html.indexOf('<hyperframes-player'),
    );
  });
});

describe('<PreviewPlayer> with a font to preview (FN19)', () => {
  const fontPreview = fontPreviewPlan('captions in @Heebo Bold', fontPickerCatalog(FONT_LIST));

  it('has a plan to show', () => {
    expect(fontPreview?.captions?.label).toBe('@Heebo Bold');
  });

  it('is exactly the player it was without one while it loads: no pill, nothing else drawn', () => {
    const plain = player();
    expect(player({ fontPreview })).toBe(plain);
    expect(player({ fontPreview: null })).toBe(plain);
    expect(plain).not.toContain('font-preview-pill');
    expect(plain).not.toContain('Previewing');
  });

  it('draws nothing on the phone’s MP4, which has no page to restyle', () => {
    const plain = player({ asVideo: true, src: '/api/jobs/j1/preview-video?r=0' });
    expect(player({ asVideo: true, src: '/api/jobs/j1/preview-video?r=0', fontPreview })).toBe(
      plain,
    );
  });
});

describe('<PlayerSkeleton>', () => {
  it('is a pulsing skeleton over the box, with a status text for screen readers', () => {
    const html = render(<PlayerSkeleton />);
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('animate-pulse');
    expect(html).toContain('absolute inset-0 rounded-none');
    expect(html).toContain('role="status"');
    expect(html).toContain('sr-only');
    expect(html).toContain('Loading the preview…');
  });
});

describe('<PlayerError>', () => {
  it('says the preview did not load and offers Try again', () => {
    const html = render(<PlayerError onRetry={() => {}} />);
    // React escapes the apostrophe.
    expect(html).toContain('The preview didn&#x27;t load.');
    expect(html).toMatch(
      /<button [^>]*type="button"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?Try again<\/button>/,
    );
    expect(html).toContain('lucide-rotate-ccw');
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-size="sm"');
  });

  it('fills the box on a dark ground', () => {
    const html = render(<PlayerError onRetry={() => {}} />);
    expect(html).toContain('absolute inset-0 flex flex-col items-center justify-center gap-3');
    expect(html).toContain('bg-[#111111]');
  });
});

describe('<PreviewPlayer> on the phone (fitToStage and renderControls)', () => {
  it('is as wide as its parent, not as wide as the video', () => {
    const column = tagWith(player({ fitToStage: true }), 'data-slot="preview-player"');
    expect(column).toContain('w-full');
    expect(column).not.toContain('style=');
  });

  it('starts from maxWidth × maxHeight until the stage is measured: 9:16 in 390 × 560 is 315 × 560', () => {
    const html = player({ fitToStage: true, maxWidth: 390, maxHeight: 560 });
    expect(tagWith(html, '<hyperframes-player')).toContain('width:315px;height:560px');
  });

  it('gives the stage the classes it is told: it fills, or has its own height', () => {
    const fill = player({ fitToStage: true, stageClassName: 'min-h-0 flex-1' });
    expect(tagWith(fill, 'data-slot="preview-stage"')).toContain('min-h-0 flex-1');
    const shrunk = player({ fitToStage: true, stageClassName: 'h-[260px] shrink-0' });
    expect(tagWith(shrunk, 'data-slot="preview-stage"')).toContain('h-[260px]');
    // Without fitToStage the stage is the Mac's: its classes are not taken.
    const mac = player({ stageClassName: 'h-[260px]' });
    expect(tagWith(mac, 'data-slot="preview-stage"')).not.toContain('h-[260px]');
  });

  it('draws the controls it is given in place of the bar', () => {
    const html = player({
      renderControls: (controls) => <p data-testid="mine">{controls.durationSec}</p>,
    });
    expect(html).toContain('<p data-testid="mine">6</p>');
    expect(html).not.toContain('data-slot="player-controls"');
  });

  it('hands over the player’s own state and handlers', () => {
    let seen: Parameters<NonNullable<PreviewPlayerProps['renderControls']>>[0] | undefined;
    player({
      timelineOverlay: <i />,
      renderControls: (controls) => {
        seen = controls;
        return null;
      },
    });
    expect(seen).toMatchObject({ currentSec: 0, durationSec: 6, playing: false, disabled: true });
    expect(typeof seen?.onTogglePlay).toBe('function');
    expect(typeof seen?.onSeek).toBe('function');
    expect(typeof seen?.onSeekCommit).toBe('function');
    expect(seen?.timelineOverlay).toBeTruthy();
  });

  it('keeps the Mac’s bar when it is given none', () => {
    expect(player({ fitToStage: true })).toContain('data-slot="player-controls"');
  });
});
