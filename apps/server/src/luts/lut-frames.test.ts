import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LUT_FRAME_CREDITS, LUT_FRAMES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { LUT_FRAMES_DIR, LUTS_ASSETS_DIR, lutFramePath } from './lut-frames.js';

describe('the bundled test frames', () => {
  it('are in apps/server/assets/luts/frames, found from src/ and dist/ alike', () => {
    expect(LUTS_ASSETS_DIR).toMatch(/apps[\\/]server[\\/]assets[\\/]luts[\\/]$/);
    expect(LUT_FRAMES_DIR).toBe(join(LUTS_ASSETS_DIR, 'frames/'));
  });

  it('have each frame as a JPEG with its flat log twin, and nothing else but the credits', () => {
    for (const frame of LUT_FRAMES) {
      for (const flat of [false, true]) {
        const path = lutFramePath(frame, flat);
        expect(path.endsWith(flat ? `${frame}-log.jpg` : `${frame}.jpg`), path).toBe(true);
        expect(existsSync(path), path).toBe(true);
        // A JPEG starts with FF D8.
        expect(readFileSync(path).subarray(0, 2).toString('hex'), path).toBe('ffd8');
      }
    }
    expect(readdirSync(LUT_FRAMES_DIR).sort()).toEqual([
      'CREDITS.md',
      'interior-log.jpg',
      'interior.jpg',
      'person-log.jpg',
      'person.jpg',
      'street-log.jpg',
      'street.jpg',
    ]);
  });

  it('are credited in CREDITS.md to the photographers the page names', () => {
    const credits = readFileSync(join(LUT_FRAMES_DIR, 'CREDITS.md'), 'utf8');
    for (const frame of LUT_FRAMES) {
      const author = LUT_FRAME_CREDITS[frame].replace(', Unsplash', '');
      expect(credits, frame).toContain(author);
    }
  });
});
