// The Mac's Tailscale name and owner, for the phone over Tailscale Serve (Mobile plan §4, PH1): what
// the access guard (remote/access.ts) lets in from outside this Mac.
//
// `tailscale status --json` is read at boot and every 5 minutes. `Self.DNSName` is the name the
// phone opens (https://<mac>.<tailnet>.ts.net) and `User[Self.UserID].LoginName` is the Mac's
// owner, the one login let in by default. `remoteHosts` and `remoteLogins` in config.json replace
// either list; with both set, Tailscale is never asked. A read that fails (Tailscale is not
// installed, not running or signed out) keeps what the last good one said. Until there is one,
// only this Mac gets in.

import { execFile } from 'node:child_process';
import type { RemoteAccess } from './access.js';
import { findTailscale, parseTailscaleStatus, tailscaleCliEnv } from './tailscale-cli.js';

export const TAILNET_REFRESH_MS = 5 * 60_000;
/** A CLI that hangs (its app stuck starting, say) must not pile up reads. */
const STATUS_TIMEOUT_MS = 10_000;

/** Reads `tailscale status --json` as parsed JSON. Rejects when there is no CLI or it fails. */
export type ReadTailscaleStatus = () => Promise<unknown>;

/** The real read, with the CLI `findTailscale` finds from `pathEnv`. */
export function tailscaleStatusReader(pathEnv: string | undefined): ReadTailscaleStatus {
  return () => {
    const bin = findTailscale({ pathEnv });
    if (bin === null) return Promise.reject(new Error('the Tailscale CLI was not found'));
    return new Promise((resolve, reject) => {
      execFile(
        bin.path,
        ['status', '--json'],
        {
          timeout: STATUS_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: tailscaleCliEnv(process.env),
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  };
}

export interface TailnetTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The real timers, unreferenced: the refresh alone must not keep the process up. */
const systemTimers: TailnetTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface TailnetLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TailnetOptions {
  /** config.json's `remoteHosts`: replaces the name read from Tailscale. */
  remoteHosts?: readonly string[];
  /** config.json's `remoteLogins`: replaces the Mac's owner read from Tailscale. */
  remoteLogins?: readonly string[];
  /** Default: the real CLI, found on `process.env.PATH`. Tests pass their own. */
  readStatus?: ReadTailscaleStatus;
  /** Default {@link TAILNET_REFRESH_MS}. */
  intervalMs?: number;
  /** Default: the real timers. Tests pass their own. */
  timers?: TailnetTimers;
  logger?: TailnetLogger;
}

export interface Tailnet {
  /** Who may come in from outside this Mac, as known now. */
  current(): RemoteAccess;
  /** Reads Tailscale now and then every 5 minutes. Does nothing when config.json names both lists. */
  start(): void;
  /** Stops reading. Safe to call twice, or without `start`. */
  stop(): void;
  /** Reads Tailscale once and applies what it says. Never rejects. */
  refresh(): Promise<void>;
}

export function createTailnet({
  remoteHosts,
  remoteLogins,
  readStatus = tailscaleStatusReader(process.env.PATH),
  intervalMs = TAILNET_REFRESH_MS,
  timers = systemTimers,
  logger,
}: TailnetOptions = {}): Tailnet {
  let found: { hosts: string[]; logins: string[] } = { hosts: [], logins: [] };
  let handle: unknown = null;
  // Logged once until a read works again, not every 5 minutes.
  let failing = false;

  const current = (): RemoteAccess => ({
    hosts: remoteHosts ?? found.hosts,
    logins: remoteLogins ?? found.logins,
  });

  async function refresh(): Promise<void> {
    let status: unknown;
    try {
      status = await readStatus();
    } catch (err) {
      if (!failing) {
        failing = true;
        logger?.warn(
          { err },
          'could not read `tailscale status`: the phone cannot open the engine until it can',
        );
      }
      return;
    }
    failing = false;
    const self = parseTailscaleStatus(status);
    const next = {
      hosts: self.dnsName === null ? [] : [self.dnsName],
      logins: self.ownerLogin === null ? [] : [self.ownerLogin],
    };
    if (next.hosts.join() !== found.hosts.join() || next.logins.join() !== found.logins.join()) {
      found = next;
      logger?.info(
        { remoteHosts: current().hosts, remoteLogins: current().logins },
        'read this Mac from Tailscale: who may open the engine over Serve',
      );
    }
  }

  return {
    current,
    start() {
      if (handle !== null || (remoteHosts !== undefined && remoteLogins !== undefined)) return;
      void refresh();
      handle = timers.setInterval(() => void refresh(), intervalMs);
    },
    stop() {
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
    },
    refresh,
  };
}

/** What the config alone allows, for an engine that does not ask Tailscale (tests, mostly). */
export function configuredAccess(config: {
  remoteHosts?: readonly string[];
  remoteLogins?: readonly string[];
}): RemoteAccess {
  return { hosts: config.remoteHosts ?? [], logins: config.remoteLogins ?? [] };
}
