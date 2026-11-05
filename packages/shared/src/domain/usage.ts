import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';

/**
 * Usage tags: what each bit of Claude use was for, so the Analytics page can show where usage
 * went. The app tags its own runs; every Claude Code session on this repo tags itself with
 * `pnpm usage <tag> "<what it did>"` (CLAUDE.md › Usage tags). Both land in
 * `<dataDir>/usage.jsonl`, one `UsageEntry` per line.
 */

/** Tags the app gives its own runs. Sessions never use these. */
export const APP_USAGE_TAGS = [
  'edit',
  'revise',
  'render',
  'style-read',
  'style-learn',
  'series',
  'series-read',
  'transcribe',
  'note-topics',
  'graphic',
  'music',
  'fix-route',
  'quick-fix',
  'generate',
] as const;

/** Tags a Claude Code session picks for itself. */
export const SESSION_USAGE_TAGS = [
  'development',
  'design',
  'planning',
  'qa',
  'orchestration',
  'process',
  'research',
  'personal',
] as const;

export const USAGE_TAGS = [...APP_USAGE_TAGS, ...SESSION_USAGE_TAGS] as const;
export const usageTagSchema = z.enum(USAGE_TAGS);
export type UsageTag = z.infer<typeof usageTagSchema>;
export const sessionUsageTagSchema = z.enum(SESSION_USAGE_TAGS);
export type SessionUsageTag = z.infer<typeof sessionUsageTagSchema>;
export type AppUsageTag = (typeof APP_USAGE_TAGS)[number];

/** How the Analytics page rolls the tags up. */
export const USAGE_GROUPS = ['Client work', 'Building the app', 'Design', 'Other'] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

/** Each tag's group, and what it covers in one plain line. */
export const USAGE_TAG_INFO = {
  edit: { group: 'Client work', means: 'The first edit of a job, its Brief included' },
  revise: { group: 'Client work', means: 'A re-edit after review notes' },
  render: { group: 'Client work', means: 'The final render after Approve' },
  'style-read': { group: 'Client work', means: "Reading files dropped into a client's style" },
  'style-learn': { group: 'Client work', means: "Learning a client's style from a finished job" },
  series: { group: 'Client work', means: 'Start a series, or Use as the series format' },
  'series-read': { group: 'Client work', means: "Reading a series' format files" },
  transcribe: { group: 'Client work', means: 'Turning review voice notes into text' },
  'note-topics': { group: 'Other', means: 'Grouping review notes into topics for Analytics' },
  graphic: { group: 'Client work', means: 'Making or changing a graphic in the Graphics library' },
  music: { group: 'Client work', means: 'Making music for a video with ElevenLabs' },
  'fix-route': {
    group: 'Client work',
    means: 'Sorting a review note with the difficulty index',
  },
  'quick-fix': { group: 'Client work', means: 'Fixing a review note live in Review' },
  generate: {
    group: 'Client work',
    means: 'Planning and making the shots of a video with no footage',
  },
  development: {
    group: 'Building the app',
    means: 'Building or fixing Studio Engine, bugs included',
  },
  design: { group: 'Design', means: 'Canvas boards, mockups and option menus' },
  planning: { group: 'Building the app', means: 'Plane items, plan pages and architecture' },
  qa: { group: 'Building the app', means: 'Acceptance runs, design QA and code reviews' },
  orchestration: {
    group: 'Building the app',
    means: 'Checking finished work, merging it and bumping the version',
  },
  process: { group: 'Building the app', means: 'CLAUDE.md, working rules and tooling' },
  research: { group: 'Other', means: 'One-off questions and looking things up' },
  personal: { group: 'Other', means: "Anything that isn't Studio Engine" },
} as const satisfies Record<UsageTag, { group: UsageGroup; means: string }>;

const tokens = z.number().int().nonnegative();

/** One model's tokens over an entry's window. `requests` counts API calls. */
export const modelUsageSchema = z.object({
  requests: tokens,
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: tokens,
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

/**
 * One line of usage.jsonl. An entry owns the session's usage from `from` (the session's
 * previous entry, or its start when null) up to `at`. A session with two purposes logs each one
 * when it is done with it, so its usage splits between the tags by time.
 */
export const usageEntrySchema = z.object({
  /** When it was logged: the end of its window. */
  at: isoTimestampSchema,
  /** The session's previous entry, or null for its first. */
  from: isoTimestampSchema.nullable(),
  /** `app`: a run the app started; `session`: a Claude Code session tagging itself. */
  source: z.enum(['app', 'session']),
  tag: usageTagSchema,
  /** What it did, in one plain line. */
  did: z.string().min(1),
  /** The Claude session, or null when no Claude ran (`transcribe`). */
  session: z.string().min(1).nullable(),
  /** The client an app run worked for. */
  client: z.string().min(1).optional(),
  /** The job an app run worked on. */
  job: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  /** Tokens by model, from the session's transcripts (its subagents included). */
  usage: z.record(z.string(), modelUsageSchema),
});
export type UsageEntry = z.infer<typeof usageEntrySchema>;

/** The entries of usage.jsonl, oldest first. Lines that are not valid entries are skipped. */
export function parseUsageLog(text: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = usageEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // A torn or hand-edited line: skip it.
    }
  }
  return entries;
}

/** When `session` last logged usage, or null if it never did. */
export function lastEntryAt(entries: readonly UsageEntry[], session: string): string | null {
  let last: string | null = null;
  for (const entry of entries) {
    if (entry.session !== session) continue;
    if (last === null || Date.parse(entry.at) > Date.parse(last)) last = entry.at;
  }
  return last;
}
