// The Tailscale CLI, for the phone over Tailscale Serve (Mobile plan §4, PH1): where it is, the
// command that serves the engine, and what `tailscale status --json` says about this Mac. Shared by
// the engine (remote/tailnet.ts) and `pnpm run doctor`, so both find the same CLI.
//
// Only Node built-ins and erasable TypeScript, with no relative imports: the doctor loads this file
// on plain Node 22 with type stripping, outside the server build.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The CLI inside the Mac app (App Store or standalone download). The app puts no `tailscale` on
 * PATH unless it is asked to, and the engine's launchd agent has a short PATH anyway.
 */
export const TAILSCALE_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * The environment to run the CLI with. The Mac app's binary acts as the CLI only when it is started
 * from a terminal; run by the launchd agent (no TERM) it tries to open the app instead and prints
 * "The Tailscale GUI failed to start". `TAILSCALE_BE_CLI=1` makes it the CLI wherever it runs.
 */
export function tailscaleCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TAILSCALE_BE_CLI: '1' };
}

/** Searched after PATH: Homebrew's folders, where the app's "Install CLI" also links it. */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface FindTailscaleOptions {
  pathEnv: string | undefined;
  /** Default: Homebrew's folders. Tests pass their own. */
  extraDirs?: readonly string[];
  /** Default {@link TAILSCALE_APP_BIN}. Tests pass their own. */
  appBin?: string;
}

export interface TailscaleBin {
  path: string;
  /** Whether a shell finds it as plain `tailscale`, so a printed command can say just that. */
  onPath: boolean;
}

/** The CLI to run: `tailscale` on PATH or in Homebrew's folders, else the Mac app's own. */
export function findTailscale({
  pathEnv,
  extraDirs = EXTRA_DIRS,
  appBin = TAILSCALE_APP_BIN,
}: FindTailscaleOptions): TailscaleBin | null {
  for (const dir of (pathEnv ?? '').split(delimiter).filter(Boolean)) {
    const path = join(dir, 'tailscale');
    if (isExecutable(path)) return { path, onPath: true };
  }
  for (const dir of extraDirs) {
    const path = join(dir, 'tailscale');
    if (isExecutable(path)) return { path, onPath: false };
  }
  return isExecutable(appBin) ? { path: appBin, onPath: false } : null;
}

/**
 * The command that serves the engine on the tailnet at https://<mac>.<tailnet>.ts.net, in the
 * background, until it is turned off. `bin` is what to type for the CLI (default `tailscale`).
 */
export function serveCommand(port: number, bin = 'tailscale'): string {
  return `${bin} serve --bg ${port}`;
}

/** A name as a Host header or Tailscale shows it, compared: lowercase, without a trailing dot. */
export function normaliseHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

export interface TailscaleSelf {
  /** This Mac's name on the tailnet (`Self.DNSName`), normalised. `null` when signed out. */
  dnsName: string | null;
  /** The Mac's owner (`User[Self.UserID].LoginName`), lowercase. `null` when it can't be told. */
  ownerLogin: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * This Mac's name and owner from `tailscale status --json`. A missing or odd field is `null`, never
 * an error. The owner is looked up by `Self.UserID` among the keys of `User`, which are exact (the
 * number itself may not be: user ids come close to 2^53), and only when exactly one key matches.
 * A tagged Mac belongs to no person (`tagged-devices`), so it has no owner.
 */
export function parseTailscaleStatus(status: unknown): TailscaleSelf {
  const self = record(record(status)?.Self);
  const users = record(record(status)?.User);

  const rawName = self?.DNSName;
  const dnsName =
    typeof rawName === 'string' && normaliseHostname(rawName) !== ''
      ? normaliseHostname(rawName)
      : null;

  let ownerLogin: string | null = null;
  const userId = self?.UserID;
  if (users !== null && typeof userId === 'number') {
    const keys = Object.keys(users).filter((key) => Number(key) === userId);
    const login = keys.length === 1 ? record(users[keys[0] as string])?.LoginName : undefined;
    if (typeof login === 'string' && login.trim() !== '' && login !== 'tagged-devices') {
      ownerLogin = login.trim().toLowerCase();
    }
  }
  return { dnsName, ownerLogin };
}
