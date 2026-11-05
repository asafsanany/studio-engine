import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

// A local fake of Higgsfield's API for the shots script's tests (GN3): nothing here touches the
// network or a key that works anywhere. It speaks the shapes GN1 saw live (higgsfield-api.md):
// estimate (a price, or a per-second description), the presigned upload flow, a generation that goes
// queued -> in_progress -> completed (video.url / images[0].url), the idempotency receipt, 401, 403
// {"detail":"not_enough_credits"}, 429 with Retry-After, 400 with a detail, 5xx, failed and nsfw.
// Every request is logged so a test can say what was sent, with which headers, and how often.

/** The key the fake accepts, shaped like Higgsfield's (`id:secret`). */
export const FAKE_KEY = 'fakekeyid-4242-aaaa:fakesecret-9f8e7d6c5b4a3f2e1d0c';

const ASSETS = fileURLToPath(new URL('../../assets/generate/', import.meta.url));
/** A real 1-second black MP4 (1.8 KB): what every finished clip downloads as. */
export const BLACK_MP4 = readFileSync(`${ASSETS}testdata/black-1s.mp4`);
/** A 1x1 PNG. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const SLUG_KLING = 'kling-video/v2.5-turbo/standard/image-to-video';
export const SLUG_WAN = 'alibaba/wan-3.0/image-to-video';
export const SLUG_SOUL = 'higgsfield-ai/soul/v2/standard';
export const SLUG_QWEN_EDIT = 'alibaba/qwen-image-3/edit';
export const SLUG_Z_IMAGE = 'z-image/turbo';

const WAN_DESCRIPTION =
  'Priced per generated second by resolution: 480p $0.05, 720p $0.10, or 1080p $0.20. Rates shown are before any applicable customer discount.';

const estimateOf = (usd: string, discount: string | null) => ({
  type: 'estimate',
  credits: '1.000',
  usd,
  discount: discount === null ? null : { percentage: discount, credits: '1.000', usd },
});

/** What the fake answers to `POST /estimate/<slug>` by slug (as of 25 Oct 2026). */
export const DEFAULT_PRICES: Record<string, unknown> = {
  [SLUG_KLING]: estimateOf('0.105', '50.00'),
  [SLUG_WAN]: { type: 'description', pricing_description: WAN_DESCRIPTION },
  [SLUG_SOUL]: estimateOf('0.004', null),
  'higgsfield-ai/soul/v2/image-to-image': estimateOf('0.004', null),
  [SLUG_QWEN_EDIT]: estimateOf('0.040', null),
  'alibaba/qwen-image-3/text-to-image': estimateOf('0.040', null),
  [SLUG_Z_IMAGE]: estimateOf('0.015', null),
};

/** Knobs a test turns to make the fake misbehave. */
export interface Scenario {
  /** 401 to every API call. */
  rejectKey: boolean;
  /** 403 {"detail":"not_enough_credits"} on a generation (the free calls still work). */
  emptyBalance: boolean;
  /** 400 {detail} on estimate and generation. */
  badRequest: string | null;
  /** The 400's detail also repeats the Authorization header it got (a server that echoes). */
  echoAuthInError: boolean;
  /** 429 on the next `times` generations (nothing is created). */
  throttle: { times: number; retryAfter: string | null; bodySeconds: number | null };
  /** This status on the next `times` generations (nothing is created). */
  submitStatus: { status: number; times: number };
  /** For the next `times` generations the request IS created but the connection is cut. */
  dropResponse: number;
  /** This status on the next `times` estimates. */
  estimateStatus: { status: number; times: number };
  /** This status on the next `times` status polls. */
  statusStatus: { status: number; times: number };
  /** How a request ends. */
  outcome: 'completed' | 'failed' | 'nsfw' | 'canceled';
  /** Polls that answer queued / in_progress before the outcome (the first is queued). */
  pollsBeforeDone: number;
  /** A request that never finishes while this is true. */
  hold: boolean;
  /** The submit answer names a status_url on a host that must never get the key. */
  evilStatusUrl: boolean;
  /** `completed` without a file. */
  noFile: boolean;
  /** A completed video that is not a video. */
  badFile: boolean;
  prices: Record<string, unknown>;
}

export interface Logged {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface Generation {
  id: string;
  slug: string;
  idempotencyKey: string | undefined;
  body: Record<string, unknown>;
  polls: number;
}

export interface FakeHiggsfield {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  key: string;
  log: Logged[];
  /** The requests that were created (not the receipts of an idempotent replay). */
  generations: Generation[];
  /** The bytes PUT to the presigned storage URLs, by the id in the URL. */
  uploads: Map<string, { contentType: string; bytes: Buffer }>;
  scenario: Scenario;
  /** Called when a generation arrives, before it is answered. */
  onSubmit: ((generation: Generation) => void) | null;
  /** The logged requests of a method and a path (a string: starts with; a RegExp: matches). */
  requests(method: string, path: string | RegExp): Logged[];
  close(): Promise<void>;
}

export function freshScenario(): Scenario {
  return {
    rejectKey: false,
    emptyBalance: false,
    badRequest: null,
    echoAuthInError: false,
    throttle: { times: 0, retryAfter: null, bodySeconds: null },
    submitStatus: { status: 503, times: 0 },
    dropResponse: 0,
    estimateStatus: { status: 503, times: 0 },
    statusStatus: { status: 503, times: 0 },
    outcome: 'completed',
    pollsBeforeDone: 2,
    hold: false,
    evilStatusUrl: false,
    noFile: false,
    badFile: false,
    prices: { ...DEFAULT_PRICES },
  };
}

const isVideo = (slug: string): boolean => /image-to-video|first-last-frame/.test(slug);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

/** What the real estimate says about a body (one problem at a time), enough for the tests. */
function problemWith(slug: string, body: Record<string, unknown>): string | null {
  if (isVideo(slug)) {
    if (typeof body.prompt !== 'string') return "'prompt' is a required property";
    if (typeof body.image_url !== 'string') return "'image_url' is a required property";
    const duration = body.duration;
    if (slug === SLUG_KLING && duration !== undefined && duration !== 5 && duration !== 10) {
      return `duration: ${String(duration)} is not one of [5, 10]`;
    }
    if (slug === SLUG_WAN && typeof duration === 'number' && (duration < 2 || duration > 30)) {
      return `duration: ${duration} is out of range`;
    }
  } else if (typeof body.prompt !== 'string') return "'prompt' is a required property";
  return null;
}

export async function startFakeHiggsfield(): Promise<FakeHiggsfield> {
  const generations: Generation[] = [];
  const byKey = new Map<string, { generation: Generation; fingerprint: string }>();
  const log: Logged[] = [];
  const uploads = new Map<string, { contentType: string; bytes: Buffer }>();
  const slots = new Map<string, string>();
  const state = { port: 0 };
  const fake: FakeHiggsfield = {
    url: '',
    key: FAKE_KEY,
    log,
    generations,
    uploads,
    scenario: freshScenario(),
    onSubmit: null,
    requests: (method, path) =>
      log.filter(
        (entry) =>
          entry.method === method &&
          (typeof path === 'string' ? entry.path.startsWith(path) : path.test(entry.path)),
      ),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const failure = (res: ServerResponse, status: number, detail: string, req: IncomingMessage) => {
    const echoed = fake.scenario.echoAuthInError
      ? ` (you sent Authorization: ${String(req.headers.authorization)})`
      : '';
    send(res, status, { detail: `${detail}${echoed}` });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname;
      let body: unknown = null;
      try {
        body =
          raw.length > 0 && req.headers['content-type']?.includes('json')
            ? JSON.parse(String(raw))
            : null;
      } catch {
        body = null;
      }
      log.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
      const method = req.method ?? 'GET';
      const scenario = fake.scenario;
      const origin = fake.url;

      // Files: the storage the presigned URLs point at, the CDN, and finished outputs. No key.
      if (method === 'PUT' && path.startsWith('/s3/')) {
        const id = path.slice('/s3/'.length);
        const wanted = slots.get(id);
        if (
          wanted === undefined ||
          req.headers['content-type'] !== wanted ||
          req.headers['x-amz-tagging'] !== 'retention=temporary' ||
          req.headers.authorization !== undefined
        ) {
          send(res, 403, { detail: 'SignatureDoesNotMatch' });
          return;
        }
        uploads.set(id, { contentType: wanted, bytes: raw });
        res.writeHead(200);
        res.end();
        return;
      }
      if (method === 'GET' && path.startsWith('/cdn/')) {
        const stored = uploads.get(path.slice('/cdn/'.length).replace(/\.\w+$/, ''));
        res.writeHead(stored ? 200 : 404);
        res.end(stored?.bytes);
        return;
      }
      if (method === 'GET' && path.startsWith('/out/')) {
        const id = path.slice('/out/'.length);
        const body = id.endsWith('.mp4')
          ? scenario.badFile
            ? Buffer.from('<html>no</html>')
            : BLACK_MP4
          : PNG_BYTES;
        res.writeHead(200, { 'Content-Type': id.endsWith('.mp4') ? 'video/mp4' : 'image/png' });
        res.end(body);
        return;
      }

      // The API: everything needs the key.
      if (scenario.rejectKey || req.headers.authorization !== `Key ${fake.key}`) {
        send(res, 401, { detail: 'Invalid credentials' });
        return;
      }

      if (method === 'GET' && path === '/models') {
        send(res, 200, { total: 2, items: [{ slug: SLUG_KLING }, { slug: SLUG_WAN }] });
        return;
      }

      if (method === 'POST' && path === '/files/generate-upload-url') {
        const contentType = (body as { content_type?: string } | null)?.content_type;
        if (typeof contentType !== 'string') {
          send(res, 400, { detail: "'content_type' is a required property" });
          return;
        }
        const id = randomUUID();
        slots.set(id, contentType);
        send(res, 200, {
          public_url: `${origin}/cdn/${id}.png`,
          upload_url: `${origin}/s3/${id}`,
          content_type: contentType,
          upload_headers: { 'Content-Type': contentType, 'x-amz-tagging': 'retention=temporary' },
        });
        return;
      }

      if (method === 'POST' && path.startsWith('/estimate/')) {
        const slug = path.slice('/estimate/'.length);
        if (scenario.estimateStatus.times > 0) {
          scenario.estimateStatus.times -= 1;
          send(res, scenario.estimateStatus.status, { detail: 'try later' });
          return;
        }
        if (scenario.badRequest !== null) return failure(res, 400, scenario.badRequest, req);
        const answer = scenario.prices[slug];
        if (answer === undefined) {
          send(res, 404, { detail: `Model ${slug} not found` });
          return;
        }
        const problem = problemWith(slug, (body ?? {}) as Record<string, unknown>);
        if (problem !== null) {
          send(res, 400, { detail: problem });
          return;
        }
        send(res, 200, answer);
        return;
      }

      const status = /^\/requests\/([^/]+)\/status$/.exec(path);
      if (method === 'GET' && status) {
        const generation = generations.find((item) => item.id === status[1]);
        if (!generation) {
          send(res, 404, { detail: 'Request not found' });
          return;
        }
        if (scenario.statusStatus.times > 0) {
          scenario.statusStatus.times -= 1;
          send(res, scenario.statusStatus.status, { detail: 'try later' });
          return;
        }
        generation.polls += 1;
        const common = {
          request_id: generation.id,
          status_url: `${origin}/requests/${generation.id}/status`,
          cancel_url: `${origin}/requests/${generation.id}/cancel`,
        };
        if (scenario.hold || generation.polls === 1) {
          send(res, 200, { status: 'queued', ...common });
        } else if (generation.polls <= scenario.pollsBeforeDone) {
          send(res, 200, { status: 'in_progress', ...common });
        } else if (scenario.outcome === 'completed') {
          const file = isVideo(generation.slug) ? `${generation.id}.mp4` : `${generation.id}.png`;
          const output = scenario.noFile
            ? {}
            : isVideo(generation.slug)
              ? { video: { url: `${origin}/out/${file}` } }
              : { images: [{ url: `${origin}/out/${file}` }] };
          send(res, 200, {
            status: 'completed',
            ...common,
            expires_at: '2026-11-01T17:06:03.420936+00:00',
            ...output,
          });
        } else {
          send(res, 200, {
            status: scenario.outcome,
            ...common,
            ...(scenario.outcome === 'failed' ? { error: 'Generation failed' } : {}),
          });
        }
        return;
      }

      if (method === 'POST') {
        // A generation: POST /<slug>.
        const slug = path.slice(1);
        const idempotencyKey = req.headers['idempotency-key'];
        const key = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;
        const fingerprint = JSON.stringify([slug, body]);
        if (scenario.throttle.times > 0) {
          scenario.throttle.times -= 1;
          const headers: Record<string, string> = {};
          if (scenario.throttle.retryAfter !== null)
            headers['Retry-After'] = scenario.throttle.retryAfter;
          send(
            res,
            429,
            {
              detail: {
                code: 'account_queue_full',
                message: 'Too many queued generations for this account',
                retryable: true,
                retry_after_seconds: scenario.throttle.bodySeconds ?? 30,
              },
            },
            headers,
          );
          return;
        }
        if (scenario.submitStatus.times > 0) {
          scenario.submitStatus.times -= 1;
          send(res, scenario.submitStatus.status, { detail: 'admission_control_unavailable' });
          return;
        }
        if (scenario.emptyBalance) {
          send(res, 403, { detail: 'not_enough_credits' });
          return;
        }
        if (scenario.badRequest !== null) return failure(res, 400, scenario.badRequest, req);
        if (scenario.prices[slug] === undefined) {
          send(res, 404, { detail: `Model ${slug} not found` });
          return;
        }
        const known = key === undefined ? undefined : byKey.get(key);
        if (known) {
          if (known.fingerprint !== fingerprint) {
            send(res, 422, {
              detail: 'Idempotency-Key was already used with different request parameters',
            });
            return;
          }
          // The receipt of the original request: it says queued even if the job is long done.
          send(res, 200, {
            status: 'queued',
            request_id: known.generation.id,
            status_url: `${origin}/requests/${known.generation.id}/status`,
            cancel_url: `${origin}/requests/${known.generation.id}/cancel`,
            expires_after: 604800,
          });
          return;
        }
        const problem = problemWith(slug, (body ?? {}) as Record<string, unknown>);
        if (problem !== null) {
          send(res, 400, { detail: problem });
          return;
        }
        const generation: Generation = {
          id: randomUUID(),
          slug,
          idempotencyKey: key,
          body: (body ?? {}) as Record<string, unknown>,
          polls: 0,
        };
        fake.onSubmit?.(generation);
        generations.push(generation);
        if (key !== undefined) byKey.set(key, { generation, fingerprint });
        if (scenario.dropResponse > 0) {
          scenario.dropResponse -= 1;
          req.socket.destroy();
          return;
        }
        send(res, 200, {
          status: 'queued',
          request_id: generation.id,
          status_url: scenario.evilStatusUrl
            ? `http://evil.invalid/requests/${generation.id}/status`
            : `${origin}/requests/${generation.id}/status`,
          cancel_url: `${origin}/requests/${generation.id}/cancel`,
          expires_after: 604800,
        });
        return;
      }

      send(res, 404, { detail: 'Not found' });
    })().catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${state.port}`;
  return fake;
}
