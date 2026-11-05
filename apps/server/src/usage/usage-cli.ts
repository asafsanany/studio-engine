// `pnpm usage`: a Claude Code session tags its own usage (CLAUDE.md › Usage tags).
//
//   pnpm usage <tag> "<what it did>"   logs the session's tokens since its previous line, under <tag>
//   pnpm usage --list                  the tags a session can use, and what each covers
//   pnpm usage --stop-hook             the Stop hook (.claude/settings.json): reminds a session whose
//                                      turn ended without a line; reads the hook's JSON on stdin
//
// The session is $CLAUDE_CODE_SESSION_ID (set in every Claude Code shell), or --session <id>.
// The log is <dataDir>/usage.jsonl (usage-log.ts).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  APP_USAGE_TAGS,
  lastEntryAt,
  SESSION_USAGE_TAGS,
  sessionUsageTagSchema,
  USAGE_TAG_INFO,
  type UsageEntry,
} from '@studio/shared';
import { loadConfig } from '../config.js';
import { lastPromptAt } from './transcript-usage.js';
import { claudeProjectsDir, logUsage, readUsageLog } from './usage-log.js';

const USAGE = 'Usage: pnpm usage <tag> "<what it did>"   (pnpm usage --list shows the tags)';

export function tagList(): string {
  return SESSION_USAGE_TAGS.map((tag) => `  ${tag.padEnd(14)}${USAGE_TAG_INFO[tag].means}`).join(
    '\n',
  );
}

/** What the Stop hook tells a session whose turn logged nothing. */
export const STOP_REASON = `Log this turn's usage before you stop (CLAUDE.md › Usage tags): pnpm usage <tag> "<what you did>". Tags: ${SESSION_USAGE_TAGS.join(', ')}.`;

/**
 * The Stop hook's verdict: the reason to keep the session going, or null to let it stop. It only
 * asks once per turn (`stop_hook_active`), and lets anything it cannot read stop.
 */
export async function stopHookReason(input: unknown, dataDir: string): Promise<string | null> {
  if (typeof input !== 'object' || input === null) return null;
  const hook = input as Record<string, unknown>;
  const session = hook.session_id;
  const transcript = hook.transcript_path;
  if (hook.stop_hook_active === true) return null;
  if (typeof session !== 'string' || typeof transcript !== 'string') return null;

  let lines: string[];
  try {
    lines = (await readFile(transcript, 'utf8')).split('\n');
  } catch {
    return null;
  }
  const prompt = lastPromptAt(lines);
  if (prompt === null) return null;
  const last = lastEntryAt(await readUsageLog(dataDir), session);
  return last !== null && Date.parse(last) >= Date.parse(prompt) ? null : STOP_REASON;
}

function totalTokens(entry: UsageEntry): { calls: number; tokens: number } {
  let calls = 0;
  let tokens = 0;
  for (const model of Object.values(entry.usage)) {
    calls += model.requests;
    tokens += model.input + model.output + model.cacheRead + model.cacheWrite;
  }
  return { calls, tokens };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  // `pnpm … -- --list` reaches here as `-- --list`: drop the separator.
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      list: { type: 'boolean' },
      'stop-hook': { type: 'boolean' },
      session: { type: 'string' },
    },
  });

  if (values.list === true) {
    console.log(`Tags for a session:\n${tagList()}`);
    return 0;
  }

  if (values['stop-hook'] === true) {
    try {
      const reason = await stopHookReason(JSON.parse(await readStdin()), loadConfig().dataDir);
      if (reason !== null) console.log(JSON.stringify({ decision: 'block', reason }));
    } catch {
      // Never keep a session from stopping because the hook broke.
    }
    return 0;
  }

  const [tag, ...words] = positionals;
  const did = words.join(' ').trim();
  if (tag === undefined || did === '') {
    console.error(`${USAGE}\n\nTags for a session:\n${tagList()}`);
    return 1;
  }
  const parsed = sessionUsageTagSchema.safeParse(tag);
  if (!parsed.success) {
    const why = (APP_USAGE_TAGS as readonly string[]).includes(tag)
      ? `"${tag}" is a tag the app gives its own runs.`
      : `"${tag}" is not a tag.`;
    console.error(`${why} Tags for a session:\n${tagList()}`);
    return 1;
  }
  const session = values.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (session === undefined || session === '') {
    console.error(
      'No Claude session: run this from a Claude Code session, or pass --session <id>.',
    );
    return 1;
  }

  const entry = await logUsage({
    dataDir: loadConfig().dataDir,
    projectsDir: claudeProjectsDir(homedir(), process.env),
    source: 'session',
    tag: parsed.data,
    did,
    session,
  });
  const { calls, tokens } = totalTokens(entry);
  const since = entry.from === null ? 'the session began' : `the last line (${entry.from})`;
  console.log(
    `Logged ${entry.tag}: ${entry.did} (${calls} API calls, ${tokens.toLocaleString('en-US')} tokens since ${since})`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
