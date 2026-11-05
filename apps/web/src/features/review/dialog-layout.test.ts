import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWPORT,
  MIN_VIDEO_BOX,
  NOTES_PANEL_WIDTH,
  REVIEW_DIALOG_BORDER,
  REVIEW_DIALOG_MARGIN,
  REVIEW_FOOTER_HEIGHT,
  REVIEW_HEADER_HEIGHT,
  reviewDialogLayout,
  reviewDialogLayoutOfFormats,
} from './dialog-layout';
import { CONTROLS_HEIGHT } from './fit-player';

const PORTRAIT = { videoWidth: 1080, videoHeight: 1920 } as const;
const LANDSCAPE = { videoWidth: 1920, videoHeight: 1080 } as const;
const CHROME_W = 362;
const CHROME_H = 202;

describe('the layout constants', () => {
  it('are the board’s sizes', () => {
    expect(REVIEW_HEADER_HEIGHT).toBe(60);
    expect(REVIEW_FOOTER_HEIGHT).toBe(64);
    expect(NOTES_PANEL_WIDTH).toBe(360);
    expect(REVIEW_DIALOG_BORDER).toBe(1);
    expect(REVIEW_DIALOG_MARGIN).toBe(16);
    expect(DEFAULT_VIEWPORT).toEqual({ width: 1440, height: 900 });
  });

  it('add up to the fixed parts around the video box: 362 wide and 202 tall', () => {
    expect(NOTES_PANEL_WIDTH + 2 * REVIEW_DIALOG_BORDER).toBe(CHROME_W);
    expect(
      REVIEW_HEADER_HEIGHT + CONTROLS_HEIGHT + REVIEW_FOOTER_HEIGHT + 2 * REVIEW_DIALOG_BORDER,
    ).toBe(CHROME_H);
  });
});

describe('reviewDialogLayout: the worked examples', () => {
  it.each([
    [1440, 900, PORTRAIT, [1046, 666], [375, 666], [737, 868]],
    [1440, 900, LANDSCAPE, [1046, 666], [1046, 588], [1408, 790]],
    [1320, 880, PORTRAIT, [926, 646], [363, 646], [725, 848]],
    [1320, 880, LANDSCAPE, [926, 646], [926, 521], [1288, 723]],
    [1280, 800, PORTRAIT, [886, 566], [318, 566], [680, 768]],
  ] as const)('%i×%i with a %j video', (viewportWidth, viewportHeight, video, max, box, dialog) => {
    const layout = reviewDialogLayout({ viewportWidth, viewportHeight, ...video });
    expect([layout.maxVideoWidth, layout.maxVideoHeight]).toEqual(max);
    expect([layout.video.width, layout.video.height]).toEqual(box);
    expect([layout.width, layout.height]).toEqual(dialog);
  });
});

describe('reviewDialogLayout: any window', () => {
  const sizes: [number, number][] = [];
  for (const width of [600, 800, 1024, 1280, 1366, 1440, 1920, 2560]) {
    for (const height of [500, 600, 720, 800, 900, 1080, 1440]) sizes.push([width, height]);
  }

  it('is exactly the video box plus 362 × 202, for both aspects', () => {
    for (const [viewportWidth, viewportHeight] of sizes) {
      for (const video of [PORTRAIT, LANDSCAPE]) {
        const layout = reviewDialogLayout({ viewportWidth, viewportHeight, ...video });
        expect(layout.width, `${viewportWidth}×${viewportHeight}`).toBe(
          layout.video.width + CHROME_W,
        );
        expect(layout.height, `${viewportWidth}×${viewportHeight}`).toBe(
          layout.video.height + CHROME_H,
        );
      }
    }
  });

  it('never exceeds the window minus 32, once the window is larger than the floor allows', () => {
    for (const [viewportWidth, viewportHeight] of sizes) {
      for (const video of [PORTRAIT, LANDSCAPE]) {
        const layout = reviewDialogLayout({ viewportWidth, viewportHeight, ...video });
        const roomW = viewportWidth - 32 - CHROME_W;
        const roomH = viewportHeight - 32 - CHROME_H;
        // Below the floor (a very small window) the player keeps its smallest box instead.
        if (roomW >= MIN_VIDEO_BOX && roomH >= MIN_VIDEO_BOX) {
          expect(layout.width, `${viewportWidth}×${viewportHeight}`).toBeLessThanOrEqual(
            viewportWidth - 32,
          );
          expect(layout.height, `${viewportWidth}×${viewportHeight}`).toBeLessThanOrEqual(
            viewportHeight - 32,
          );
        }
      }
    }
  });

  it('keeps the video’s aspect ratio to within a pixel', () => {
    for (const [viewportWidth, viewportHeight] of sizes) {
      for (const video of [PORTRAIT, LANDSCAPE]) {
        const { video: box } = reviewDialogLayout({ viewportWidth, viewportHeight, ...video });
        const expectedHeight = (box.width * video.videoHeight) / video.videoWidth;
        expect(
          Math.abs(box.height - expectedHeight),
          `${viewportWidth}×${viewportHeight}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('leaves the controls out of maxVideoHeight: it plus 202 plus 32 is the window height', () => {
    for (const [viewportWidth, viewportHeight] of sizes) {
      const layout = reviewDialogLayout({ viewportWidth, viewportHeight, ...PORTRAIT });
      if (viewportHeight - 32 - CHROME_H >= MIN_VIDEO_BOX) {
        expect(layout.maxVideoHeight + CHROME_H + 32).toBe(viewportHeight);
      }
    }
  });

  it('keeps a smallest video box in a very small window', () => {
    const layout = reviewDialogLayout({ viewportWidth: 300, viewportHeight: 300, ...PORTRAIT });
    expect(layout.maxVideoWidth).toBe(MIN_VIDEO_BOX);
    expect(layout.maxVideoHeight).toBe(MIN_VIDEO_BOX);
    expect(layout.video.height).toBe(MIN_VIDEO_BOX);
  });

  it.each([
    ['NaN', Number.NaN],
    ['0', 0],
    ['negative', -5],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('uses 1440×900 for a %s window side', (_label, bad) => {
    const expected = reviewDialogLayout({ viewportWidth: 1440, viewportHeight: 900, ...PORTRAIT });
    expect(reviewDialogLayout({ viewportWidth: bad, viewportHeight: bad, ...PORTRAIT })).toEqual(
      expected,
    );
    expect(reviewDialogLayout({ viewportWidth: bad, viewportHeight: 900, ...PORTRAIT })).toEqual(
      expected,
    );
    expect(reviewDialogLayout({ viewportWidth: 1440, viewportHeight: bad, ...PORTRAIT })).toEqual(
      expected,
    );
  });
});

describe('reviewDialogLayoutOfFormats', () => {
  const WINDOW = { viewportWidth: 1440, viewportHeight: 900 } as const;
  const SQUARE = { width: 1080, height: 1080 } as const;

  it('is the layout of the one video it is given', () => {
    expect(
      reviewDialogLayoutOfFormats({ ...WINDOW, videos: [{ width: 1080, height: 1920 }] }),
    ).toEqual(reviewDialogLayout({ ...WINDOW, ...PORTRAIT }));
  });

  it('holds the largest box of a 9:16 and a 1:1 video, so the dialog never changes size', () => {
    const portrait = reviewDialogLayout({ ...WINDOW, ...PORTRAIT });
    const square = reviewDialogLayout({
      ...WINDOW,
      videoWidth: SQUARE.width,
      videoHeight: SQUARE.height,
    });
    const both = reviewDialogLayoutOfFormats({
      ...WINDOW,
      videos: [{ width: 1080, height: 1920 }, SQUARE],
    });
    expect(portrait.video).toEqual({ width: 375, height: 666 });
    expect(square.video).toEqual({ width: 666, height: 666 });
    expect(both.video).toEqual({ width: 666, height: 666 });
    expect(both.width).toBe(666 + CHROME_W);
    expect(both.height).toBe(666 + CHROME_H);
    expect(both.maxVideoWidth).toBe(portrait.maxVideoWidth);
    expect(both.maxVideoHeight).toBe(portrait.maxVideoHeight);
    // The order of the formats does not matter.
    expect(
      reviewDialogLayoutOfFormats({ ...WINDOW, videos: [SQUARE, { width: 1080, height: 1920 }] }),
    ).toEqual({
      ...both,
      ...reviewDialogLayoutOfFormats({
        ...WINDOW,
        videos: [SQUARE, { width: 1080, height: 1920 }],
      }),
    });
  });
});
