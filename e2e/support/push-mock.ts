// A stand-in for the push service (Apple's, Google's) that the e2e run can point the engine at, so
// "what would the phone get?" can be answered without a phone and without ever sending a real push.
//
// It is an https server on a spare loopback port with a throw-away self-signed certificate (the
// engine's `web-push` only sends to https): the engine process is started with
// `NODE_EXTRA_CA_CERTS=<caFile>` (see `EngineOptions.env`) so it trusts exactly that certificate.
// Each `subscribe(name)` makes a subscription like a phone's — an endpoint on this server, a P-256
// key pair kept here and a 16-byte auth secret — and what the engine then sends to that endpoint
// is checked the way a phone would: the body is decrypted (RFC 8291 aes128gcm) with the
// subscription's own private key, and the VAPID token in `Authorization` (RFC 8292) is verified
// against the key the engine told the phone to subscribe with. Everything is kept for the spec to
// read, and `log()` prints it one line per push.
//
// The certificate comes from the `openssl` command line (on every Mac); it lives in a temp folder
// that `stop()` removes.

import { execFile } from 'node:child_process';
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  createVerify,
  type ECDH,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** What a phone hands the engine (`PushSubscription.toJSON()`). */
export interface MockSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The payload the engine sent, as the phone's service worker reads it. */
export interface PushedPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  badge?: number;
}

/** One push the mock received for one subscription. */
export interface ReceivedPush {
  /** The name the subscription was made with. */
  device: string;
  /** Milliseconds since the mock started. */
  atMs: number;
  /** What the mock answered: the subscription's `answer` (201 unless it was made to refuse). */
  answered: number;
  headers: { ttl: string | undefined; contentEncoding: string | undefined };
  vapid: {
    /** The `sub` claim: a mailto: or https address. */
    subject: string | null;
    /** The `aud` claim: the origin of the push service, here this mock. */
    audience: string | null;
    /** Seconds from now to the token's `exp`. */
    expiresInSec: number | null;
    /** The token is signed by the key in `k`. */
    signatureValid: boolean;
    /** The `k` the engine sent, base64url. */
    key: string | null;
  };
  /** The decrypted payload; `null` when the body could not be read with the subscription's keys. */
  payload: PushedPayload | null;
}

export interface PushMock {
  /** The certificate the engine must trust: `NODE_EXTRA_CA_CERTS=<caFile>`. */
  caFile: string;
  /** `https://127.0.0.1:<port>`. */
  origin: string;
  /**
   * A new phone: an endpoint of this server and the keys to go with it. `answer` is the status the
   * mock gives every push to it (201 like a push service; 410 for a subscription that is gone).
   */
  subscribe(name: string, options?: { answer?: number }): MockSubscription;
  /** The pushes received so far, oldest first; those of one device, or of all. */
  received(device?: string): ReceivedPush[];
  /** One line per push received, for a log. */
  log(): string;
  stop(): Promise<void>;
}

interface Phone {
  ecdh: ECDH;
  auth: Buffer;
  answer: number;
}

/** The text of `value` as base64url, no padding (how a browser writes keys). */
const b64url = (value: Buffer): string => value.toString('base64url');

/** RFC 8291 aes128gcm: the body of one push, decrypted with the subscription's own key and secret. */
function decrypt(body: Buffer, phone: Phone): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverKey = body.subarray(21, 21 + idLength);
  const records = body.subarray(21 + idLength);
  const phoneKey = phone.ecdh.getPublicKey();

  const secret = phone.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), phoneKey, serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, phone.auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(records.subarray(records.length - 16));
  const padded = Buffer.concat([
    decipher.update(records.subarray(0, records.length - 16)),
    decipher.final(),
  ]);
  // The last record ends with the delimiter 0x02 and then zeros.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (padded[end - 1] !== 2) throw new Error('The last record has no 0x02 delimiter.');
  return padded.subarray(0, end - 1).toString('utf8');
}

/** The claims of a VAPID `Authorization` header, with whether its signature holds. */
function readVapid(authorization: string | undefined): ReceivedPush['vapid'] {
  const none = {
    subject: null,
    audience: null,
    expiresInSec: null,
    signatureValid: false,
    key: null,
  };
  const match = /^vapid t=([^,\s]+),\s*k=(\S+)$/.exec(authorization ?? '');
  if (match === null) return none;
  const [, token = '', key = ''] = match;
  const [header = '', claims = '', signature = ''] = token.split('.');
  try {
    const point = Buffer.from(key, 'base64url');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33, 65)),
      },
      format: 'jwk',
    });
    const verifier = createVerify('SHA256').update(`${header}.${claims}`);
    const signatureValid = verifier.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as {
      sub?: string;
      aud?: string;
      exp?: number;
    };
    return {
      subject: body.sub ?? null,
      audience: body.aud ?? null,
      expiresInSec: typeof body.exp === 'number' ? body.exp - Math.floor(Date.now() / 1000) : null,
      signatureValid,
      key,
    };
  } catch {
    return { ...none, key };
  }
}

function readBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** A throw-away certificate for 127.0.0.1 (a P-256 key, two days), in `dir`. */
async function makeCertificate(dir: string): Promise<{ key: string; cert: string }> {
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  await execFileAsync('openssl', [
    ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
    ...['-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=127.0.0.1'],
    ...['-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
  ]);
  return { key: await readFile(keyFile, 'utf8'), cert: await readFile(certFile, 'utf8') };
}

export async function startPushMock(): Promise<PushMock> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-push-mock-'));
  const { key, cert } = await makeCertificate(dir);
  const startedAt = Date.now();
  const phones = new Map<string, Phone>();
  const pushes: ReceivedPush[] = [];

  const server: Server = createServer({ key, cert }, async (request, response) => {
    const name = /^\/push\/([^/?]+)$/.exec(request.url ?? '')?.[1];
    const phone = name === undefined ? undefined : phones.get(name);
    const body = await readBody(request);
    if (request.method !== 'POST' || name === undefined || phone === undefined) {
      response.writeHead(404).end();
      return;
    }

    let payload: PushedPayload | null = null;
    try {
      payload = JSON.parse(decrypt(body, phone)) as PushedPayload;
    } catch {
      payload = null;
    }
    pushes.push({
      device: name,
      atMs: Date.now() - startedAt,
      answered: phone.answer,
      headers: {
        ttl: request.headers.ttl as string | undefined,
        contentEncoding: request.headers['content-encoding'],
      },
      vapid: readVapid(request.headers.authorization),
      payload,
    });
    response.writeHead(phone.answer).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const origin = `https://127.0.0.1:${port}`;

  return {
    caFile: join(dir, 'cert.pem'),
    origin,
    subscribe(name, { answer = 201 } = {}) {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const auth = randomBytes(16);
      phones.set(name, { ecdh, auth, answer });
      return {
        endpoint: `${origin}/push/${name}`,
        keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
      };
    },
    received: (device) => pushes.filter((push) => device === undefined || push.device === device),
    log: () =>
      pushes
        .map((push) => {
          const { payload, vapid } = push;
          const what =
            payload === null
              ? '(could not be decrypted)'
              : `${payload.title} | ${payload.body} | ${payload.url} | tag ${payload.tag} | badge ${payload.badge ?? '-'}`;
          const how = `TTL ${push.headers.ttl}, ${push.headers.contentEncoding}, VAPID ${vapid.signatureValid ? 'ok' : 'BAD'} sub ${vapid.subject}`;
          return `+${(push.atMs / 1000).toFixed(2).padStart(6)}s  ${push.device.padEnd(6)} -> ${push.answered}  ${what}  [${how}]`;
        })
        .join('\n'),
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
