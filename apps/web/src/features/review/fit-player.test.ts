import { describe, expect, it } from 'vitest';
import { CONTROLS_HEIGHT, fitPlayer } from './fit-player';

const NINE_SIXTEEN = { videoW: 1080, videoH: 1920 };
const SIXTEEN_NINE = { videoW: 1920, videoH: 1080 };

describe('fitPlayer', () => {
  it('gives the board its four boxes', () => {
    // 9:16 into a height of 592 (width to spare).
    expect(fitPlayer({ ...NINE_SIXTEEN, maxW: 2000, maxH: 592 })).toEqual({
      width: 333,
      height: 592,
    });
    // 16:9 into 880 wide (height to spare).
    expect(fitPlayer({ ...SIXTEEN_NINE, maxW: 880, maxH: 2000 })).toEqual({
      width: 880,
      height: 495,
    });
    // Full screen, 1320 × (880 - 76): a bar of 76 px below the video.
    expect(fitPlayer({ ...NINE_SIXTEEN, maxW: 1320, maxH: 880 - CONTROLS_HEIGHT })).toEqual({
      width: 452,
      height: 804,
    });
    expect(fitPlayer({ ...SIXTEEN_NINE, maxW: 1320, maxH: 880 - CONTROLS_HEIGHT })).toEqual({
      width: 1320,
      height: 743,
    });
  });

  it('fits the gallery boxes', () => {
    expect(fitPlayer({ ...NINE_SIXTEEN, maxW: 480, maxH: 560 })).toEqual({
      width: 315,
      height: 560,
    });
    expect(fitPlayer({ ...SIXTEEN_NINE, maxW: 448, maxH: 560 })).toEqual({
      width: 448,
      height: 252,
    });
    expect(fitPlayer({ ...NINE_SIXTEEN, maxW: 400, maxH: 700 })).toEqual({
      width: 394,
      height: 700,
    });
  });

  it('returns the box itself when the video has its ratio', () => {
    expect(fitPlayer({ videoW: 16, videoH: 9, maxW: 320, maxH: 180 })).toEqual({
      width: 320,
      height: 180,
    });
  });

  it('floors fractional maxima', () => {
    expect(fitPlayer({ videoW: 1, videoH: 1, maxW: 100.9, maxH: 200 })).toEqual({
      width: 100,
      height: 100,
    });
    expect(fitPlayer({ videoW: 1, videoH: 1, maxW: 200, maxH: 99.99 })).toEqual({
      width: 99,
      height: 99,
    });
  });

  it('never exceeds the maximum, and keeps the aspect ratio to within a pixel', () => {
    const videos = [
      [1080, 1920],
      [1920, 1080],
      [1080, 1080],
      [1080, 1350],
      [1366, 768],
      [768, 1366],
    ] as const;
    for (const [videoW, videoH] of videos) {
      for (let maxW = 1; maxW <= 1400; maxW += 37) {
        for (let maxH = 1; maxH <= 1000; maxH += 41) {
          const box = fitPlayer({ videoW, videoH, maxW, maxH });
          const label = `${videoW}x${videoH} into ${maxW}x${maxH} gave ${box.width}x${box.height}`;
          expect(box.width, label).toBeLessThanOrEqual(maxW);
          expect(box.height, label).toBeLessThanOrEqual(maxH);
          expect(Number.isInteger(box.width) && Number.isInteger(box.height), label).toBe(true);
          // Whole pixels cost at most a pixel of ratio, on either axis.
          expect(Math.abs((box.width * videoH) / videoW - box.height), label).toBeLessThan(1);
          expect(Math.abs((box.height * videoW) / videoH - box.width), label).toBeLessThan(1);
        }
      }
    }
  });

  it('fills the limiting side exactly', () => {
    for (const [maxW, maxH] of [
      [480, 560],
      [900, 300],
      [333, 333],
    ] as const) {
      const box = fitPlayer({ ...NINE_SIXTEEN, maxW, maxH });
      expect(box.width === maxW || box.height === maxH).toBe(true);
    }
  });

  it('gives 0 × 0 for zero, negative and non-finite inputs', () => {
    const ok = { ...NINE_SIXTEEN, maxW: 480, maxH: 560 };
    for (const key of ['videoW', 'videoH', 'maxW', 'maxH'] as const) {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(fitPlayer({ ...ok, [key]: bad }), `${key} = ${bad}`).toEqual({
          width: 0,
          height: 0,
        });
      }
    }
  });

  it('knows the controls are 76 px tall', () => {
    expect(CONTROLS_HEIGHT).toBe(76);
  });
});
