// The engine's VAPID keys (Mobile plan §6, PH11): the key pair that signs every web push, made
// once into <dataDir>/push.json (~/.studio-engine/push.json) with mode 0600 and kept for good. The
// phones subscribe to the public key, so a new pair would silence every one of them: a file that
// exists but cannot be read is an error to fix, never something to write over. The keys are
// never logged and the file is never committed (it lives outside the repo).

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** The file in the data folder that holds the keys. */
export const PUSH_KEYS_FILE = 'push.json';

export interface VapidKeys {
  /** base64url, the `applicationServerKey` the phones subscribe with. */
  publicKey: string;
  /** base64url. Secret. */
  privateKey: string;
}

const fileSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  createdAt: z.string().optional(),
});

/** push.json exists and cannot be used, or cannot be written. The message says what to do. */
export class VapidKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VapidKeysError';
  }
}

export function pushKeysPath(dataDir: string): string {
  return join(dataDir, PUSH_KEYS_FILE);
}

function readKeys(path: string): VapidKeys | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No file, or no folder to have one in: the write below says what is wrong with the folder.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new VapidKeysError(`${path} cannot be read (${code}).`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new VapidKeysError(
      `${path} is not a pair of push keys. Fix it, or delete it to start over: every phone then has to turn notifications on again.`,
    );
  }
  // A file made by hand or restored from a backup may be readable by others.
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {
    // Not ours to change; the keys still work.
  }
  return { publicKey: parsed.data.publicKey, privateKey: parsed.data.privateKey };
}

/**
 * Reads the keys from `<dataDir>/push.json`, or makes a pair with `generate` and writes it (mode
 * 0600, through a temporary file so a crash never leaves half of one). Throws `VapidKeysError`.
 */
export function ensureVapidKeys(options: {
  dataDir: string;
  generate: () => VapidKeys;
  clock?: () => Date;
}): VapidKeys {
  const { dataDir, generate, clock = () => new Date() } = options;
  const path = pushKeysPath(dataDir);
  const existing = readKeys(path);
  if (existing !== null) return existing;

  const keys = generate();
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = { ...keys, createdAt: clock().toISOString() };
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    throw new VapidKeysError(
      `${path} cannot be written (${(err as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
  return keys;
}

/** The keys, made or read on first use and then kept. A failure is thrown again at the next use. */
export interface VapidKeyStore {
  get(): VapidKeys;
}

export function createVapidKeyStore(options: {
  dataDir: string;
  generate: () => VapidKeys;
  clock?: () => Date;
}): VapidKeyStore {
  let keys: VapidKeys | null = null;
  return {
    get() {
      keys ??= ensureVapidKeys(options);
      return keys;
    },
  };
}
