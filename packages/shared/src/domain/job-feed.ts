import { z } from 'zod';
import { reviewNoteSchema } from './review-note.ts';
import type { StepId } from './steps.ts';

// Draft & chat (DR1): the job's chat, built by the engine from the job log
// (`<logsDir>/jobs/<id>.log`, every line a run wrote). Nothing is asked of Claude for it: the items
// are what the runs said, ran and looked at, in order. `GET /api/jobs/:id/feed` answers
// `JobFeedResponse`; its pictures are at `GET /api/jobs/:id/feed/img/:name`.

/**
 * The runs a feed shows, each opening with a divider: the Brief run (a job with no footage, or one
 * from before Draft & chat), the Generate step, the Draft (the edit run), a review round (a revise
 * run), a quick fix in Review and the render after Approve.
 */
export const FEED_RUN_KINDS = ['brief', 'generate', 'draft', 'round', 'fix', 'render'] as const;
export const feedRunKindSchema = z.enum(FEED_RUN_KINDS);
export type FeedRunKind = z.infer<typeof feedRunKindSchema>;

/** How a run ended, as the log's end marker says (`RunEndOutcome` on the server). */
export const FEED_RUN_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'stopped',
  'timed_out',
] as const;
export const feedRunOutcomeSchema = z.enum(FEED_RUN_OUTCOMES);
export type FeedRunOutcome = z.infer<typeof feedRunOutcomeSchema>;

/** One command of a `tools` item: what Claude ran, in its own plain words where it gave some. */
export const feedToolSchema = z.object({
  /** The tool use's id from the stream. */
  id: z.string().min(1),
  /** Bash, Read, Write, Edit, Skill… */
  tool: z.string().min(1),
  /** What it did, in plain words: a command's own description, else "Read edit/project.md"… */
  label: z.string().min(1),
  /** The command itself, or the path, when there is one; shown when the fold is opened. */
  detail: z.string().nullable(),
  state: z.enum(['running', 'done', 'failed']),
});
export type FeedTool = z.infer<typeof feedToolSchema>;

/** One picture Claude opened, saved from the log so a later round cannot change it. */
export const feedImageSchema = z.object({
  /** The file name under the feed's pictures: `GET /api/jobs/:id/feed/img/<name>`. */
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  /** What it is, from its path: "Cut sheet", "Frames and sound wave · 11.0–21.9 s"… */
  label: z.string().min(1),
  /** What Claude opened, relative to the job folder when it is inside it. */
  path: z.string().nullable(),
  /** A wide picture (video-use's frames-and-sound-wave view, a contact sheet): shown full width. */
  wide: z.boolean(),
});
export type FeedImage = z.infer<typeof feedImageSchema>;

/** One range of the cut list (video-use's edl.json). */
export const feedCutSchema = z.object({
  source: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  /** The beat it plays (HOOK, PROBLEM, OFFER…), when the plan names one. */
  beat: z.string().nullable(),
  /** What is said in it. */
  quote: z.string().nullable(),
  reason: z.string().nullable(),
});
export type FeedCut = z.infer<typeof feedCutSchema>;

/** The cards: a file the run wrote or read that says something on its own. */
export const feedCardSchema = z.discriminatedUnion('type', [
  /** What it understood from the folder: edit/brief.json. */
  z.object({
    type: z.literal('brief'),
    summary: z.string().nullable(),
    /** A few short facts: the length, the canvas, the captions, the tone… */
    facts: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
  /** The transcript video-use packs (edit/takes_packed.md). */
  z.object({ type: z.literal('transcript'), text: z.string() }),
  /** The plan: edit/project.md's strategy. */
  z.object({ type: z.literal('plan'), text: z.string() }),
  /** The cut list: edit/edl.json. */
  z.object({
    type: z.literal('cuts'),
    cuts: z.array(feedCutSchema),
    totalSec: z.number().nonnegative(),
  }),
  /** Loudness, as ffmpeg's ebur128 summary reported it. */
  z.object({
    type: z.literal('loudness'),
    integratedLufs: z.number().nullable(),
    truePeakDb: z.number().nullable(),
    rangeLu: z.number().nullable(),
  }),
]);
export type FeedCard = z.infer<typeof feedCardSchema>;
export type FeedCardType = FeedCard['type'];

const itemBase = {
  /** Stable across rebuilds: made from the log line it started on. */
  id: z.string().min(1),
  /** When it happened (the line's own time, or the run's when the line has none). */
  at: z.string().nullable(),
};

export const jobFeedItemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...itemBase,
    kind: z.literal('run'),
    run: feedRunKindSchema,
    /** A review round's number (1, 2…); null for every other run. */
    round: z.number().int().positive().nullable(),
    /** start, resume or retry. */
    mode: z.string().nullable(),
    endedAt: z.string().nullable(),
    outcome: feedRunOutcomeSchema.nullable(),
    /** The error the run ended with, in the engine's words. */
    error: z.string().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    /** A round's notes, as they were sent; empty for every other run. */
    notes: z.array(reviewNoteSchema),
  }),
  z.object({ ...itemBase, kind: z.literal('text'), text: z.string().min(1) }),
  z.object({ ...itemBase, kind: z.literal('tools'), tools: z.array(feedToolSchema).min(1) }),
  z.object({ ...itemBase, kind: z.literal('images'), images: z.array(feedImageSchema).min(1) }),
  z.object({ ...itemBase, kind: z.literal('card'), card: feedCardSchema }),
]);
export type JobFeedItem = z.infer<typeof jobFeedItemSchema>;
export type JobFeedItemKind = JobFeedItem['kind'];
export type FeedRunItem = Extract<JobFeedItem, { kind: 'run' }>;

/**
 * `GET /api/jobs/:id/feed`: the job's chat. `rev` grows whenever the log does, so a poll that
 * brings back the same `rev` has nothing new.
 */
export const jobFeedResponseSchema = z.object({
  jobId: z.string().min(1),
  rev: z.number().int().nonnegative(),
  items: z.array(jobFeedItemSchema),
});
export type JobFeedResponse = z.infer<typeof jobFeedResponseSchema>;

/** The words of the feed's errors. */
export const FEED_MESSAGES = {
  off: 'Draft & chat is off.',
  noPicture: 'That picture is not in the chat.',
} as const;

/**
 * The Draft's stages, as the chat's progress box shows them: video-use's own, not the engine's
 * eight steps. Each covers the steps listed (Render is after the Draft).
 */
export const DRAFT_STAGES = [
  { id: 'instructions', label: 'Instructions', steps: [1] },
  { id: 'footage', label: 'Footage', steps: [2, 3] },
  { id: 'plan', label: 'Plan', steps: [4] },
  { id: 'cut', label: 'Cut', steps: [5] },
  { id: 'preview', label: 'Preview', steps: [6] },
  { id: 'check', label: 'Check', steps: [7] },
] as const satisfies readonly { id: string; label: string; steps: readonly StepId[] }[];
export type DraftStageId = (typeof DRAFT_STAGES)[number]['id'];

/** The Draft stage a step belongs to; null for Render (8), which comes after the Draft. */
export function draftStageOf(step: StepId | null): DraftStageId | null {
  if (step === null) return null;
  return (
    DRAFT_STAGES.find((stage) => (stage.steps as readonly number[]).includes(step))?.id ?? null
  );
}
