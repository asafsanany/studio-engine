import type { AnalyticsPeriod, AnalyticsResponse, LimitSnapshot } from './analytics.ts';
import { computeClaudeUseSection } from './analytics-claude-use.ts';
import { computeJobsSection } from './analytics-jobs.ts';
import { computeReviewsSection } from './analytics-reviews.ts';
import { inputPeriod } from './analytics-time.ts';
import { computeTypicalJobSection } from './analytics-typical-job.ts';
import type { Job } from './job.ts';
import type { JobStepRun } from './job-steps.ts';
import type { MoneyDelivery } from './money-compute.ts';
import type { ReviewNote } from './review-note.ts';
import type { UsageEntry } from './usage.ts';

// The Analytics page's numbers (Analytics plan), worked out from what the engine has recorded as a
// pure function: the same input always gives the same answer, in any time zone of the machine,
// because the time zone is an input. The server's route (routes/analytics.ts) only reads the
// inputs and hands them here.
//
// `computeAnalytics` calls one function per section of the answer, each in a file of its own, so
// the sections can be worked on side by side:
//
//   analytics-jobs.ts         the five tiles, the delivery calendar, footage per week
//   analytics-typical-job.ts  A typical job, step by step
//   analytics-reviews.ts      Approved first time, by week; What your notes are about
//   analytics-claude-use.ts   Busiest week, API cost per finished minute
//   analytics-budgets.ts      The two budgets: API credits and the Max plan
//
// Day and week maths (local time, weeks start on Sunday) is in analytics-time.ts.
//
// The answer is for one period. `month` (the default) compares the last 30 days with the 30 before
// and draws its series by calendar week; `week` compares the last 7 days with the 7 before and
// draws them by day (the sizes are in `ANALYTICS_SIZES`). Every section works out both the same
// way, in buckets that are weeks or days (`bucketStartsEnding` in analytics-time.ts).

/** A job as `computeAnalytics` reads it: the job as the page sees it, and the bookkeeping the page does not. */
export interface AnalyticsJob extends Job {
  /** When the latest edit attempt started; `null` for a job that never has. */
  startedAt: string | null;
  /** When the latest edit attempt ended (ready, failed or cancelled): a ready job's finish. */
  finishedAt: string | null;
  /** Seconds of video and audio in the job's inputs. */
  footageSec: number;
}

/** One timed run of one step of a job, with the job it belongs to (`StepRunRepository.listAll`). */
export type AnalyticsStepRun = JobStepRun & { jobId: string };

export interface ComputeAnalyticsInput {
  /** The current moment in milliseconds: the end of "the last 30 days" (or 7) and of this week. */
  now: number;
  /** What the answer is for: the last 30 days by week (`month`, the default) or the last 7 by day (`week`). */
  period?: AnalyticsPeriod;
  /** IANA time zone whose calendar decides what day and week a moment falls in (the machine's). */
  timeZone: string;
  /** Every job, archived ones too, in any order. */
  jobs: readonly AnalyticsJob[];
  /** Every timed step run of every job, oldest first. */
  stepRuns: readonly AnalyticsStepRun[];
  /** Every review note that was sent (`NoteRepository.listAllSent`), in any order. */
  sentNotes: readonly ReviewNote[];
  /** Every delivery, in any order. */
  deliveries: readonly MoneyDelivery[];
  /** Every line of usage.jsonl, oldest first. */
  usage: readonly UsageEntry[];
  /** The readings of Claude's rate limits, oldest first (limits.jsonl). */
  limits: readonly LimitSnapshot[];
  /** The topic of each sent note that has one, by note id (note-topics.json). */
  noteTopics: Readonly<Record<string, string>>;
}

/** Works out everything the Analytics page shows. Missing data is `null` in the answer, never 0. */
export function computeAnalytics(input: ComputeAnalyticsInput): AnalyticsResponse {
  return {
    generatedAt: new Date(input.now).toISOString(),
    timeZone: input.timeZone,
    period: inputPeriod(input),
    jobs: computeJobsSection(input),
    typicalJob: computeTypicalJobSection(input),
    reviews: computeReviewsSection(input),
    claudeUse: computeClaudeUseSection(input),
  };
}
