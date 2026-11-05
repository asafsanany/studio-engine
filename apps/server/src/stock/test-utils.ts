// Stand-ins for Openverse and Unsplash for the stock tests: a fake `fetch` that answers like the
// two services and records what it was asked, so no test touches the network.

export const OPENVERSE_BASE = 'https://api.openverse.org';
export const UNSPLASH_BASE = 'https://api.unsplash.com';
export const SFX_URL = 'https://cdn.example.org/whoosh.mp3';
export const PHOTO_FILE_URL = 'https://images.unsplash.com/photo-1';

export const MP3_BYTES = Buffer.from('ID3-fake-mp3-bytes');
export const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function openverseResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ov-1',
    title: 'Whoosh',
    creator: 'Jane Doe',
    creator_url: 'https://freesound.org/people/jane/',
    license: 'by',
    license_version: '4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    foreign_landing_url: 'https://freesound.org/s/1/',
    url: SFX_URL,
    filetype: 'mp3',
    duration: 1200,
    category: null,
    ...over,
  };
}

export function unsplashResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ph1',
    description: 'A street at night',
    alt_description: null,
    width: 4000,
    height: 6000,
    urls: { raw: `${PHOTO_FILE_URL}?ixid=abc123`, regular: 'https://images.unsplash.com/regular' },
    links: { html: 'https://unsplash.com/photos/ph1' },
    user: { name: 'Sam Lee', links: { html: 'https://unsplash.com/@sam' } },
    ...over,
  };
}

export interface FakeServices {
  fetch: typeof fetch;
  calls: Call[];
  /** Replace what a service answers: a function of the request returns a Response, or null to use the default. */
  override: ((call: Call) => Response | null) | null;
  sfxResults: Record<string, unknown>[];
  photoResults: Record<string, unknown>[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function fakeServices(): FakeServices {
  const services: FakeServices = {
    calls: [],
    override: null,
    sfxResults: [openverseResult()],
    photoResults: [unsplashResult()],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : '',
      };
      services.calls.push(call);
      const overridden = services.override?.(call);
      if (overridden) return overridden;
      if (url.startsWith(`${OPENVERSE_BASE}/v1/auth_tokens/token/`)) {
        return json({ access_token: 'ov-token-123456', expires_in: 36000, token_type: 'Bearer' });
      }
      if (url.startsWith(`${OPENVERSE_BASE}/v1/audio/`)) {
        return json({ result_count: services.sfxResults.length, results: services.sfxResults });
      }
      if (url.startsWith(`${UNSPLASH_BASE}/search/photos`)) {
        return json({ total: 1, results: services.photoResults }, 200, {
          'x-ratelimit-remaining': '49',
        });
      }
      if (url.startsWith(`${UNSPLASH_BASE}/photos/`) && url.endsWith('/download')) {
        return json({ url: 'https://images.unsplash.com/photo-1' });
      }
      if (url === SFX_URL) {
        return new Response(MP3_BYTES, { headers: { 'content-type': 'audio/mpeg' } });
      }
      if (url.startsWith(PHOTO_FILE_URL)) {
        return new Response(JPG_BYTES, { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return services;
}
