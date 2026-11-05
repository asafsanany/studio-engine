/**
 * `pnpm release:check` (also part of `pnpm check`): guards the versioning rule in CLAUDE.md.
 * It fails when
 * - the root package.json version has no entry in packages/shared/src/releases.ts, or the newest
 *   entry is ahead of that version;
 * - the entries are not valid or not strictly newest first;
 * - X of the version differs from X of the last git tag, unless ALLOW_MAJOR_BUMP=1 is set.
 *   Only the owner sets that: no agent bumps X.
 *
 * Runs on plain Node 22 (built-in type stripping). It imports the release notes from the shared
 * package, which only needs zod. `checkRelease` is pure so tests can feed it any version,
 * releases and tags; only the bottom of this file touches package.json, git and the environment.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  findRelease,
  parseVersion,
  RELEASES,
  releasesSchema,
} from '../packages/shared/src/releases.ts';

export interface ReleaseCheckInput {
  /** The root package.json version. */
  version: string;
  /** The release notes to check (validated here, so any value can be passed). */
  releases: unknown;
  /** Every git tag, or null when git could not be asked (no git, not a repository). */
  tags: readonly string[] | null;
  /** True when ALLOW_MAJOR_BUMP=1: The owner approves a change of X. */
  allowMajorBump: boolean;
}

export interface ReleaseCheckResult {
  ok: boolean;
  /** Why the check failed, each with how to fix it. */
  errors: string[];
  /** What was checked, and anything that was skipped. */
  notes: string[];
}

export interface VersionTag {
  tag: string;
  /** The tag's `X.Y.Z`, without the `v` or any `-dev` style suffix. */
  version: string;
}

/**
 * The newest tag that looks like a version (`v0.1.0`, `0.2.0`, `v0.1.0-dev`), by number, not by
 * date or by name. Other tags (`latest`, `backup-2026`) are ignored.
 */
export function latestVersionTag(tags: readonly string[]): VersionTag | null {
  let best: VersionTag | null = null;
  for (const tag of [...tags].sort()) {
    const version = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(tag.trim())?.[1];
    if (!version || parseVersion(version) === null) continue;
    if (best === null || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best;
}

const RELEASES_FILE = 'packages/shared/src/releases.ts';

/** Check the versioning rule. Pure: everything it needs is in `input`. */
export function checkRelease(input: ReleaseCheckInput): ReleaseCheckResult {
  const { version, tags, allowMajorBump } = input;
  const errors: string[] = [];
  const notes: string[] = [];

  const current = parseVersion(version);
  if (current === null) {
    errors.push(`The version in package.json is "${version}"; it must look like 0.1.0 (X.Y.Z).`);
  }

  // The entries must be valid and strictly newest first.
  const parsed = releasesSchema.safeParse(input.releases);
  if (parsed.success) {
    const entries = parsed.data;
    for (let i = 1; i < entries.length; i++) {
      const newer = (entries[i - 1] as { version: string }).version;
      const older = (entries[i] as { version: string }).version;
      const order = compareVersions(newer, older);
      if (order === 0) {
        errors.push(`${RELEASES_FILE} lists ${newer} twice. Each version gets one entry.`);
      } else if (order < 0) {
        errors.push(
          `${RELEASES_FILE} must be newest first, but ${older} comes after ${newer}. Put the newest entry at the top and keep versions strictly decreasing.`,
        );
      }
    }

    if (current !== null) {
      if (!findRelease(entries, version)) {
        errors.push(
          `Version ${version} has no release entry. Add { version: '${version}', date, items } at the top of RELEASES in ${RELEASES_FILE}, written in plain language for the owner.`,
        );
      } else {
        notes.push(`Version ${version} has a release entry (${entries.length} in total).`);
      }
      const newest = entries.reduce<string | null>(
        (best, entry) =>
          best === null || compareVersions(entry.version, best) > 0 ? entry.version : best,
        null,
      );
      if (newest !== null && compareVersions(newest, version) > 0) {
        errors.push(
          `The release entry for ${newest} is ahead of the package.json version (${version}). Bump the version in package.json to ${newest}, or remove the entry. Never change X (the first number) yourself.`,
        );
      }
    }
  } else {
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      errors.push(`${RELEASES_FILE} is not valid${where}: ${issue.message}`);
    }
  }

  // X may only change when the owner says so.
  if (current !== null) {
    if (tags === null) {
      notes.push('Git could not be asked for tags here, so X was not compared with the last tag.');
    } else {
      const last = latestVersionTag(tags);
      if (last === null) {
        notes.push('No version tag in this repository, so X was not compared with a last tag.');
      } else {
        const tagX = (parseVersion(last.version) as number[])[0];
        if (tagX === current[0]) {
          notes.push(`X (${current[0]}) matches the last git tag ${last.tag}.`);
        } else if (allowMajorBump) {
          notes.push(
            `X changed from ${tagX} (last git tag ${last.tag}) to ${current[0]}; accepted because ALLOW_MAJOR_BUMP=1 is set.`,
          );
        } else {
          errors.push(
            `X changed: package.json is ${version} but the last git tag is ${last.tag} (X = ${tagX}). Only the owner changes X. If they approved it, run with ALLOW_MAJOR_BUMP=1 (ALLOW_MAJOR_BUMP=1 pnpm check) and tag the release; otherwise put X back to ${tagX}.`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, notes };
}

export function formatReport(result: ReleaseCheckResult): string {
  const lines = [result.ok ? 'release:check passed' : 'release:check FAILED'];
  for (const error of result.errors) lines.push(`  ✗ ${error}`);
  for (const note of result.notes) lines.push(`  - ${note}`);
  return lines.join('\n');
}

/**
 * Every git tag of the repository at `cwd` (worktrees share their tags), or null when git cannot
 * be run there. An empty list means a repository without tags.
 */
export function readGitTags(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  try {
    const out = execFileSync('git', ['tag', '--list'], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const rootPackage = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
    version?: unknown;
  };
  const result = checkRelease({
    version: typeof rootPackage.version === 'string' ? rootPackage.version : '',
    releases: RELEASES,
    tags: readGitTags(root),
    // Exactly "1": The owner's approval is deliberate, "0" or "true" do not count.
    allowMajorBump: process.env.ALLOW_MAJOR_BUMP === '1',
  });
  const report = formatReport(result);
  if (result.ok) console.log(report);
  else console.error(report);
  process.exitCode = result.ok ? 0 : 1;
}
