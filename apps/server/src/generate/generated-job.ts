// Whether a job is a generated video, and what a run on it needs to know about the money (Generated
// videos, GN6). The truth about the job is its brief: `production: generate` in edit/brief.json,
// written by the Brief step. The edit run's `generated` partial, the revise run's `generate-revise`
// partial and the quick-fix router's guard all read it from here, so a footage job (no such key)
// is never touched by any of them.
//
// Both readers never throw: a job whose brief or spend file is missing or does not parse is simply
// not a generated job / has spent nothing. The money itself is enforced by make-shots.mjs from
// spend.json (it refuses a take over the budget), so a wrong reading here can only make the
// prompt's "left" number wrong, never let a run overspend.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_GENERATE_BUDGET_USD,
  GENERATE_FILES,
  type GenerateState,
  generateBudgetFor,
} from '@studio/shared';
import { type GenerateRepository, toGenerateState } from '../db/generate-repository.js';
import { spendOf } from './generate-progress.js';

/** What the brief says about a generated job. */
export interface GeneratedJobBrief {
  /** The budget the brief names for this one job ("budget $5"), or `null`: the configured one applies. */
  readonly budgetUsd: number | null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The brief of a generated job (edit/brief.json says `production: generate`), or `null` for any
 * other job: footage, a brief that does not say, no brief, a file that does not parse.
 */
export async function readGeneratedJob(jobDir: string): Promise<GeneratedJobBrief | null> {
  const brief = await readJson(join(jobDir, 'edit', 'brief.json'));
  if (typeof brief !== 'object' || brief === null) return null;
  const { production, budgetUsd } = brief as { production?: unknown; budgetUsd?: unknown };
  if (production !== 'generate') return null;
  return { budgetUsd: typeof budgetUsd === 'number' && budgetUsd > 0 ? budgetUsd : null };
}

/**
 * Higgsfield dollars spent on the job so far: the entries of edit/generate/spend.json that were not
 * refunded (never its `total` field, as everywhere else). 0 when there is no such file yet.
 */
export async function readSpentUsd(jobDir: string): Promise<number> {
  const spent = spendOf(await readJson(join(jobDir, 'edit', GENERATE_FILES.spend)));
  return spent ?? 0;
}

/**
 * The job's budget in dollars: the brief's own, else the configured one (else the default of the
 * switch, for a config that does not carry it).
 */
export function budgetOfGeneratedJob(
  brief: GeneratedJobBrief,
  configUsd: number | undefined,
): number {
  return generateBudgetFor(brief.budgetUsd, configUsd ?? DEFAULT_GENERATE_BUDGET_USD);
}

/** A budget as the number a command line takes: 3, 4.5, 12.25 (the same as the Generate prompt's). */
export function budgetNumberText(usd: number): string {
  return String(Math.round(usd * 100) / 100);
}

/**
 * Puts what spend.json says, and the budget the brief names, into the job's Generate row after a run
 * that may have made new takes or read a new note (a review round, C67, C77): Review's "left of the
 * $3" and the sheet's "$N of $3" read the row, and the row is otherwise only kept up to date while
 * the Generate step runs. A note like "budget $4" is the brief's budget: when it names one and the
 * row says another, the row follows. Does nothing for a job without a row (not generated) or when
 * the row already says it. Tells `onChanged` with the new state. Never throws: it is a display, and
 * the money itself is enforced by the script.
 */
export async function syncGeneratedSpend(
  repo: Pick<GenerateRepository, 'get' | 'update'>,
  jobId: string,
  jobDir: string,
  onChanged: (jobId: string, state: GenerateState) => void,
): Promise<void> {
  try {
    const row = repo.get(jobId);
    if (row === null) return;
    const spent = await readSpentUsd(jobDir);
    const budget = (await readGeneratedJob(jobDir))?.budgetUsd ?? null;
    const spendChanged = Math.abs(spent - row.spendUsd) >= 0.0005;
    const budgetChanged = budget !== null && Math.abs(budget - row.budgetUsd) >= 0.0005;
    if (!spendChanged && !budgetChanged) return;
    const next = repo.update(jobId, {
      ...(spendChanged ? { spendUsd: spent } : {}),
      ...(budgetChanged && budget !== null ? { budgetUsd: budget } : {}),
    });
    if (next !== null) onChanged(jobId, toGenerateState(next));
  } catch {
    // A row or a file that cannot be read leaves the display as it was.
  }
}
