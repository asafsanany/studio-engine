// Which `claude` binary an edit runs with. Shared by the runner (E3) and `pnpm run doctor`
// (scripts/doctor.ts imports this file directly), so both always agree.
//
// Only Node built-ins and erasable TypeScript here: the doctor runs this file on plain Node 22
// with type stripping, outside the server build.

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ClaudeBinSource = 'config' | 'PATH' | 'native install' | 'desktop app';

export interface ClaudeBin {
  path: string;
  source: ClaudeBinSource;
}

/** Where the standalone CLI installs, and where the desktop app keeps the CLIs it bundles. */
export function claudeLocations(home: string) {
  return {
    nativeClaude: join(home, '.local', 'bin', 'claude'),
    desktopClaudeRoot: join(home, 'Library', 'Application Support', 'Claude', 'claude-code'),
  };
}

/** Where Homebrew and the uv installer put binaries; a launchd job's PATH has none of them. */
export function extraBinDirs(home: string): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin')];
}

function expandTilde(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p;
}

/** Compares dotted numeric versions ("2.1.299" > "2.1.95"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** First executable called `name` on PATH, then in `extraDirs`. */
export function findExecutable(
  name: string,
  pathEnv: string | undefined,
  extraDirs: string[] = [],
): { path: string; onPath: boolean } | null {
  const onPath = (pathEnv ?? '').split(delimiter).filter(Boolean);
  for (const dir of onPath) {
    const p = join(dir, name);
    if (isExecutable(p)) return { path: p, onPath: true };
  }
  for (const dir of extraDirs) {
    const p = join(dir, name);
    if (isExecutable(p)) return { path: p, onPath: false };
  }
  return null;
}

/**
 * Claude Code binaries the desktop app ships, newest version first:
 * <root>/<version>/<hash>/claude.app/Contents/MacOS/claude. The version folder changes on
 * every app update, so this is looked up on each run rather than stored.
 */
export function bundledClaudeBins(root: string): string[] {
  const versions = listDir(root)
    .filter((v) => /^\d+(\.\d+)*$/.test(v))
    .sort((a, b) => compareVersions(b, a));
  const bins: string[] = [];
  for (const version of versions) {
    for (const hash of listDir(join(root, version)).sort()) {
      const bin = join(root, version, hash, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (isExecutable(bin)) bins.push(bin);
    }
  }
  return bins;
}

/**
 * The `claude` binary an edit runs with. Order: the configured `claudeBin`, `claude` on PATH,
 * the native install in ~/.local/bin, then the newest binary bundled with the desktop app. A
 * configured `claudeBin` always wins, even when it is missing, so the doctor and the runner can
 * say so instead of silently running another one.
 */
export function resolveClaudeBin(opts: {
  home: string;
  pathEnv: string | undefined;
  configBin?: string;
}): ClaudeBin | null {
  const loc = claudeLocations(opts.home);
  if (opts.configBin) return { path: expandTilde(opts.configBin, opts.home), source: 'config' };
  const onPath = findExecutable('claude', opts.pathEnv);
  if (onPath) return { path: onPath.path, source: 'PATH' };
  if (isExecutable(loc.nativeClaude)) return { path: loc.nativeClaude, source: 'native install' };
  const bundled = bundledClaudeBins(loc.desktopClaudeRoot)[0];
  return bundled ? { path: bundled, source: 'desktop app' } : null;
}
