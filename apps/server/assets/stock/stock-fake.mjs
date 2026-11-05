// The FAKE services of the stock script (Stock media, ST5). With STUDIO_STOCK_FAKE=1 stock.mjs
// answers from here instead of Openverse and Unsplash: no key, no network, the same JSON-line
// contract, so the engine, the stock prompt and the tests can run the whole flow. It serves two
// sound effects and two photos for any words, and tiny placeholder files (a silent WAV, a 1-pixel
// JPEG). Plain Node, no dependencies.

import { API_BASE as OPENVERSE } from './openverse.mjs';
import { API_BASE as UNSPLASH } from './unsplash.mjs';

export const FAKE_HOST = 'https://fake.stock.test';

/** A silent mono 8-bit WAV of 0.1 s at 8 kHz. */
export const WAV = (() => {
  const samples = 800;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
})();

/** A 1x1 JPEG. */
export const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

const SFX = [
  {
    id: 'fake-sfx-1',
    title: 'Whoosh (fake)',
    creator: 'Fake Foley',
    license: 'by',
    duration: 1200,
  },
  { id: 'fake-sfx-2', title: 'Click (fake)', creator: 'Fake Foley', license: 'cc0', duration: 400 },
];
const PHOTOS = [
  {
    id: 'fake-photo-1',
    description: 'A street at night (fake)',
    name: 'Fake Photographer',
    width: 4000,
    height: 6000,
  },
  {
    id: 'fake-photo-2',
    description: 'A quiet harbour (fake)',
    name: 'Fake Photographer',
    width: 6000,
    height: 4000,
  },
];

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A `fetch` that answers like the two services and serves the placeholder files. */
export function fakeFetch() {
  return async (input) => {
    const url = String(input);
    if (url.startsWith(`${OPENVERSE}/v1/auth_tokens/token/`)) {
      return json({ access_token: 'fake-token', expires_in: 36000, token_type: 'Bearer' });
    }
    if (url.startsWith(`${OPENVERSE}/v1/audio/`)) {
      return json({
        results: SFX.map((sfx) => ({
          id: sfx.id,
          title: sfx.title,
          creator: sfx.creator,
          creator_url: 'https://fake.stock.test/people/foley',
          license: sfx.license,
          license_version: '4.0',
          license_url: 'https://creativecommons.org/licenses/by/4.0/',
          foreign_landing_url: `${FAKE_HOST}/sound/${sfx.id}`,
          url: `${FAKE_HOST}/sfx/${sfx.id}.wav`,
          filetype: 'wav',
          duration: sfx.duration,
          category: null,
        })),
      });
    }
    if (url.startsWith(`${UNSPLASH}/search/photos`)) {
      return json(
        {
          results: PHOTOS.map((photo) => ({
            id: photo.id,
            description: photo.description,
            alt_description: null,
            width: photo.width,
            height: photo.height,
            urls: { raw: `https://images.unsplash.com/${photo.id}?ixid=fake` },
            links: { html: `https://unsplash.com/photos/${photo.id}` },
            user: { name: photo.name, links: { html: 'https://unsplash.com/@fake' } },
          })),
        },
        { 'x-ratelimit-remaining': '49' },
      );
    }
    if (url.startsWith(`${UNSPLASH}/photos/`) && url.endsWith('/download')) {
      return json({ url: 'https://images.unsplash.com/fake' });
    }
    if (url.startsWith(`${FAKE_HOST}/sfx/`)) {
      return new Response(WAV, { headers: { 'content-type': 'audio/wav' } });
    }
    if (url.startsWith('https://images.unsplash.com/')) {
      return new Response(JPG, { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('not found', { status: 404 });
  };
}
