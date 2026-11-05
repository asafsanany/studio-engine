// The key the inbox reads the DMs with. The owner puts it in the repo's .env (`INSTAGRAM_DM_TOKEN`);
// an Instagram login key lasts 60 days, so the inbox refreshes it every couple of days and keeps
// the refreshed one in <dataDir>/instagram-dms/key.json (readable by this user only). A Unified
// login key never runs out and is never refreshed. A new key in .env (a different one) wins over
// the saved one again.

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type GraphClient, readDmToken } from './graph.js';

/** How old the key may get before it is refreshed. Instagram refreshes keys over 24 hours old. */
export const KEY_REFRESH_EVERY_MS = 2 * 24 * 60 * 60_000;

/** The wait after a refresh that failed (the old key works until it runs out). */
export const KEY_REFRESH_RETRY_MS = 6 * 60 * 60_000;

interface SavedKey {
  token: string;
  /** Which key of .env this one came from (a hash, never the key). */
  envFingerprint: string;
  /** When this key was made or refreshed. */
  savedAt: number;
  /** When a refresh last failed. */
  failedAt?: number;
}

export interface DmKeyLogger {
  warn(obj: object, msg: string): void;
}

export interface DmKeyStoreOptions {
  /** <dataDir>/instagram-dms/key.json */
  path: string;
  env?: Record<string, string | undefined>;
  envFile?: string;
  now?: () => number;
  logger?: DmKeyLogger;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export class DmKeyStore {
  private readonly now: () => number;

  constructor(private readonly options: DmKeyStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Whether .env has a key at all. */
  hasKey(): boolean {
    return this.envToken() !== null;
  }

  /**
   * The key to read the DMs with: the refreshed one while .env still has the key it came from,
   * else the one in .env (`fresh`: the inbox has not used it before). `null` when .env has none.
   */
  current(): { token: string; fresh: boolean } | null {
    const fromEnv = this.envToken();
    if (fromEnv === null) return null;
    const print = fingerprint(fromEnv);
    const saved = this.read();
    if (saved !== null && saved.envFingerprint === print)
      return { token: saved.token, fresh: false };
    this.write({ token: fromEnv, envFingerprint: print, savedAt: this.now() });
    return { token: fromEnv, fresh: true };
  }

  /** Refreshes the saved key when it is due. Never throws: the old key works until it runs out. */
  async refreshIfDue(client: Pick<GraphClient, 'refreshToken' | 'refreshable'>): Promise<void> {
    if (!client.refreshable) return;
    const saved = this.read();
    if (saved === null) return;
    const now = this.now();
    if (now - saved.savedAt < KEY_REFRESH_EVERY_MS) return;
    if (saved.failedAt !== undefined && now - saved.failedAt < KEY_REFRESH_RETRY_MS) return;
    try {
      const { token } = await client.refreshToken();
      this.write({ token, envFingerprint: saved.envFingerprint, savedAt: now });
    } catch (err) {
      this.write({ ...saved, failedAt: now });
      this.options.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not refresh the Instagram DMs key; the one there is works until it runs out',
      );
    }
  }

  private envToken(): string | null {
    return readDmToken(this.options.env, this.options.envFile);
  }

  private read(): SavedKey | null {
    try {
      const json: unknown = JSON.parse(readFileSync(this.options.path, 'utf8'));
      if (typeof json !== 'object' || json === null) return null;
      const { token, envFingerprint, savedAt, failedAt } = json as Record<string, unknown>;
      if (typeof token !== 'string' || typeof envFingerprint !== 'string') return null;
      if (typeof savedAt !== 'number') return null;
      return {
        token,
        envFingerprint,
        savedAt,
        ...(typeof failedAt === 'number' ? { failedAt } : {}),
      };
    } catch {
      return null; // none yet, or unreadable: .env's key is used
    }
  }

  private write(key: SavedKey): void {
    const { path } = this.options;
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(key)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  }
}
