// The usage log: <dataDir>/usage.jsonl, one UsageEntry per line (@studio/shared › usage.ts).
// Sessions append through `pnpm usage` (usage-cli.ts), the app after each of its runs. Each entry
// takes the session's tokens since its previous entry from the session's transcripts, so the log
// keeps the numbers after Claude Code clears old transcripts.

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  lastEntryAt,
  type ModelUsage,
  parseUsageLog,
  type UsageEntry,
  type UsageTag,
  usageEntrySchema,
} from '@studio/shared';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { sumUsage } from './transcript-usage.js';

export const USAGE_LOG_FILE = 'usage.jsonl';

export function usageLogPath(dataDir: string): string {
  return join(dataDir, USAGE_LOG_FILE);
}

/** Where Claude Code keeps transcripts: <CLAUDE_CONFIG_DIR or ~/.claude>/projects. */
export function claudeProjectsDir(home: string, env: Record<string, string | undefined>): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return join(
    configDir !== undefined && configDir !== '' ? configDir : join(home, '.claude'),
    'projects',
  );
}

export async function readUsageLog(dataDir: string): Promise<UsageEntry[]> {
  try {
    return parseUsageLog(await readFile(usageLogPath(dataDir), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Every transcript file of a session, in whichever project folder it is: <session>.jsonl and its
 * subagents' <session>/subagents/*.jsonl.
 */
export async function sessionTranscripts(projectsDir: string, session: string): Promise<string[]> {
  const files: string[] = [];
  for (const project of await list(projectsDir)) {
    const dir = join(projectsDir, project);
    const names = await list(dir);
    if (names.includes(`${session}.jsonl`)) files.push(join(dir, `${session}.jsonl`));
    if (names.includes(session)) {
      const subagents = join(dir, session, 'subagents');
      for (const name of await list(subagents)) {
        if (name.endsWith('.jsonl')) files.push(join(subagents, name));
      }
    }
  }
  return files;
}

async function transcriptLines(files: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const file of files) {
    try {
      lines.push(...(await readFile(file, 'utf8')).split('\n'));
    } catch {
      // Gone between the listing and the read: nothing to count.
    }
  }
  return lines;
}

export interface LogUsageInput {
  dataDir: string;
  projectsDir: string;
  source: UsageEntry['source'];
  tag: UsageTag;
  did: string;
  session: string | null;
  client?: string;
  job?: { id: string; name: string };
  now?: Date;
}

/** Appends one entry with the session's tokens since its previous entry, and returns it. */
export async function logUsage(input: LogUsageInput): Promise<UsageEntry> {
  const at = (input.now ?? new Date()).toISOString();
  const from =
    input.session === null ? null : lastEntryAt(await readUsageLog(input.dataDir), input.session);
  let usage: Record<string, ModelUsage> = {};
  if (input.session !== null) {
    const lines = await transcriptLines(await sessionTranscripts(input.projectsDir, input.session));
    usage = sumUsage(lines, { after: from, until: at });
  }
  const entry = usageEntrySchema.parse({
    at,
    from,
    source: input.source,
    tag: input.tag,
    did: input.did.replace(/\s+/g, ' ').trim(),
    session: input.session,
    ...(input.client === undefined ? {} : { client: input.client }),
    ...(input.job === undefined ? {} : { job: input.job }),
    usage,
  });
  await mkdir(input.dataDir, { recursive: true });
  // One small append per entry: concurrent writers don't interleave lines.
  await appendFile(usageLogPath(input.dataDir), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/** What an app run says about itself; the runner adds the session once the run has one. */
export interface AppUsage {
  tag: UsageTag;
  did: string;
  client?: string;
  job?: { id: string; name: string };
}

/**
 * Logs an app run's usage. Never throws: a run never fails because its usage could not be
 * logged, it only warns.
 */
export async function logAppUsage(
  options: {
    dataDir: string;
    home: string;
    env: Record<string, string | undefined>;
    logger: RunnerLogger;
  },
  usage: AppUsage,
  session: string | null,
): Promise<void> {
  try {
    await logUsage({
      dataDir: options.dataDir,
      projectsDir: claudeProjectsDir(options.home, options.env),
      source: 'app',
      session,
      ...usage,
    });
  } catch (err) {
    options.logger.warn({ err, tag: usage.tag }, 'could not log the usage of a run');
  }
}
