import { readFileSync } from 'node:fs';
import { apiErrorSchema, FONT_FRAMES, FONT_MESSAGES } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { fakeFontService } from '../fonts/test-utils.js';
import { lutFramePath } from '../luts/lut-frames.js';
import { FONT_FRAME_CACHE_CONTROL, FONT_FRAME_NOT_FOUND, fontFrameOf } from './font-frames.js';

// GET /api/fonts/frame/<frame>.jpg (FN8): the three test photos of the "On a frame" view, the same
// files the LUTs page uses, served for good.

function appWith(service = fakeFontService()) {
  return createApp({ fonts: true, fontsRoutes: { service } });
}

describe('GET /api/fonts/frame/:frame.jpg', () => {
  it.each(FONT_FRAMES)(
    'serves the %s photo as a JPEG the browser may keep for good',
    async (frame) => {
      const res = await appWith().request(`/api/fonts/frame/${frame}.jpg`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/jpeg');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('Cache-Control')).toBe(FONT_FRAME_CACHE_CONTROL);
      const body = Buffer.from(await res.arrayBuffer());
      // A JPEG starts with FF D8, and it is the LUTs' plain frame, byte for byte.
      expect(body.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(body.equals(readFileSync(lutFramePath(frame)))).toBe(true);
      expect(Number(res.headers.get('Content-Length') ?? body.length)).toBe(body.length);
    },
  );

  it('serves the three frames as three different photos', async () => {
    const app = appWith();
    const sizes = new Set<number>();
    for (const frame of FONT_FRAMES) {
      const res = await app.request(`/api/fonts/frame/${frame}.jpg`);
      sizes.add((await res.arrayBuffer()).byteLength);
    }
    expect(sizes.size).toBe(3);
  });

  it('never asks the Fonts service', async () => {
    const list = vi.fn();
    const get = vi.fn();
    const file = vi.fn();
    const app = appWith(fakeFontService({ list, get, file }));
    await app.request('/api/fonts/frame/person.jpg');
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
  });

  it.each([
    'night.jpg',
    'person',
    'person.png',
    'person.jpeg',
    'person.jpg.jpg',
    'PERSON.jpg',
    '.jpg',
    // The flat twin of the LUTs page is never served here.
    'person-log.jpg',
    'street-log.jpg',
    // Nothing outside the three names, whatever it is dressed as.
    '..%2Fperson.jpg',
    '%2e%2e%2Fluts%2Fframes%2Fperson.jpg',
    'CREDITS.md',
  ])('answers 404 for %s', async (file) => {
    const res = await appWith().request(`/api/fonts/frame/${file}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('immutable');
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_FRAME_NOT_FOUND });
  });

  it('answers 404 for a deeper path, and for the bare folder', async () => {
    const app = appWith();
    for (const path of [
      '/api/fonts/frame/person/after.jpg',
      '/api/fonts/frame/',
      '/api/fonts/frame',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Content-Type') ?? '', path).not.toContain('image/');
    }
  });

  it('is off with the rest of Fonts while the switch is: 404 "Fonts are off."', async () => {
    const app = createApp({ fonts: false, fontsRoutes: { service: fakeFontService() } });
    const res = await app.request('/api/fonts/frame/person.jpg');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.off });

    const unrouted = await createApp({ fonts: true }).request('/api/fonts/frame/person.jpg');
    expect(unrouted.status).toBe(404);
    expect(apiErrorSchema.parse(await unrouted.json())).toEqual({ error: FONT_MESSAGES.off });
  });

  it('does not take the place of a family: /api/fonts/frame is still not /api/fonts/:slug', async () => {
    const get = vi.fn(async () => ({
      ok: false as const,
      status: 404 as const,
      error: FONT_MESSAGES.notFound,
    }));
    const app = appWith(fakeFontService({ get }));
    // A slug named like the folder still goes to the service ...
    const res = await app.request('/api/fonts/frame');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.notFound });
    expect(get).toHaveBeenCalledWith('frame');
    // ... and a family's own address is untouched.
    get.mockClear();
    await app.request('/api/fonts/heebo');
    expect(get).toHaveBeenCalledWith('heebo');
  });
});

describe('fontFrameOf', () => {
  it('names the frame of an address segment, and nothing else', () => {
    expect(fontFrameOf('person.jpg')).toBe('person');
    expect(fontFrameOf('street.jpg')).toBe('street');
    expect(fontFrameOf('interior.jpg')).toBe('interior');
    expect(fontFrameOf('person')).toBeUndefined();
    expect(fontFrameOf('person-log.jpg')).toBeUndefined();
    expect(fontFrameOf('')).toBeUndefined();
  });
});
