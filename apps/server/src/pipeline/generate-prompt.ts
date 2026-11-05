// The prompt of the Generate run (Generated videos, GN5): apps/server/prompts/generate.md.
//
// GN5 shipped a short placeholder; GN12 replaced it with the real prompt: generate.md and the parts
// beside it, generate-checks.md (how a clip take is checked) and generate-use.md (what exists is
// kept, what each exit code means, when "Blocked:" is the answer). What the engine gives the
// template:
//
//   variables   {{client}} {{job}}          the job's names
//               {{voiceScript}}             absolute path of make-voice.mjs
//               {{shotsScript}}             absolute path of make-shots.mjs
//               {{editDir}}                 absolute path of the job's edit/ folder (the scripts take it)
//               {{budget}} {{spent}} {{left}}   dollars as text ("$5", "$1.65", "$3.35")
//               {{budgetNumber}}            the budget as the number --budget takes ("5", "4.5")
//               {{creditRate}}              what a Higgsfield plan credit is worth in dollars ("0.056")
//               {{budgetCredits}} {{leftCredits}}   the budget and what is left as plan credits ("89", "59")
//               {{formats}}                 the sizes asked for ("9:16 and 1:1"), "9:16" for one
//   partials    {{> generate-existing}}     what an earlier try already made (`describeExisting`);
//                                           empty on a first try, which takes its line with it
//               {{> generate-<name>}}       every other apps/server/prompts/generate-<name>.md is a
//                                           partial of the same name, rendered with these variables
//
// Variables and partials are computed in code and handed in as values, so a `{{` in a client's name
// or in a text is never read as a template (see prompts.ts).

import { readdir } from 'node:fs/promises';
import {
  budgetLeftUsd,
  budgetUsdText,
  DEFAULT_GENERATE_USD_PER_CREDIT,
  formatRatioText,
  generateCreditsFor,
  spendUsdText,
} from '@studio/shared';
import {
  oneLine,
  PROMPTS_DIR,
  type PromptPartial,
  readTemplate,
  renderTemplate,
} from './prompts.js';

export interface GeneratePromptVars {
  client: string;
  job: string;
  /** Absolute path of make-voice.mjs. */
  voiceScript: string;
  /** Absolute path of make-shots.mjs. */
  shotsScript: string;
  /** Absolute path of the job's edit/ folder. */
  editDir: string;
  /** The job's budget in dollars. */
  budgetUsd: number;
  /** Dollars spent on Higgsfield so far (spend.json). */
  spentUsd: number;
  /** What one Higgsfield plan credit is worth in dollars (`Config.generateUsdPerCredit`); the default when unset. */
  usdPerCredit?: number;
  /** The brief's canvases (`1080x1920`), main first; empty or one is one size. */
  formats?: readonly string[] | null;
  /** What an earlier try made (`describeExisting`); empty for a first try. */
  existing?: string;
}

/** The sizes the prompt names: "9:16 and 1:1", or the one size, or "9:16" when the brief names none. */
export function formatsText(formats: readonly string[] | null | undefined): string {
  const ratios = (formats ?? []).map(formatRatioText);
  if (ratios.length === 0) return '9:16';
  if (ratios.length === 1) return ratios[0] as string;
  return `${ratios.slice(0, -1).join(', ')} and ${ratios.at(-1)}`;
}

/** A budget as the number a command line takes: 3, 4.5, 12.25. */
export function budgetNumber(usd: number): string {
  return String(Math.round(usd * 100) / 100);
}

/** The name of the file of every partial beside generate.md: `generate-checks.md` is `generate-checks`. */
async function partialNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => /^generate-[a-z0-9-]+\.md$/.test(name))
      .map((name) => name.slice(0, -'.md'.length))
      .filter((name) => name !== 'generate-existing')
      .sort();
  } catch {
    return [];
  }
}

/** The prompt of the Generate run. */
export async function buildGeneratePrompt(
  vars: GeneratePromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  const budget = { spendUsd: vars.spentUsd, budgetUsd: vars.budgetUsd };
  const rate = vars.usdPerCredit ?? DEFAULT_GENERATE_USD_PER_CREDIT;
  const values: Record<string, string> = {
    client: oneLine(vars.client),
    job: oneLine(vars.job),
    voiceScript: vars.voiceScript,
    shotsScript: vars.shotsScript,
    editDir: vars.editDir,
    budget: budgetUsdText(vars.budgetUsd),
    spent: spendUsdText(vars.spentUsd),
    left: budgetUsdText(budgetLeftUsd(budget)),
    budgetNumber: budgetNumber(vars.budgetUsd),
    creditRate: String(rate),
    budgetCredits: String(generateCreditsFor(vars.budgetUsd, rate)),
    leftCredits: String(generateCreditsFor(budgetLeftUsd(budget), rate)),
    formats: formatsText(vars.formats),
  };
  const partials: Record<string, PromptPartial> = {
    'generate-existing': { raw: vars.existing ?? '' },
  };
  for (const name of await partialNames(dir)) partials[name] = await readTemplate(dir, name);
  const template = await readTemplate(dir, 'generate');
  return `${renderTemplate(template, values, partials)
    .replace(/[ \t]+$/gm, '')
    .trim()}\n`;
}
