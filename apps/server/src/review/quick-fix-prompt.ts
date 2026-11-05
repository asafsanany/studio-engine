// The prompt of a quick fix run (apps/server/prompts/quick-fix.md). The run changes one note's worth
// of the live composition in edit/preview/; see claude-quick-fix.ts for how it is started.
//
// Variables (`{{name}}`): client and job (the names), time (the note's moment as m:ss.s, for
// The owner's words), at (the same moment in seconds, for `hyperframes snapshot --at=`), note (their words,
// on one line), round (the round the note will be stamped with, for project.md's heading) and
// fixDir (edit/review/fixes/<fixId>, where the run writes its stills and reply.json). The partial
// `{{> composition-rules}}` is the two composition rules preview-finish.md shares with it. The
// unattended notes are in quick-fix.md itself: the shared unattended.md talks about the video-use
// skill, which this run does not load.

import { formatNoteTime } from '@studio/shared';
import { oneLine, PROMPTS_DIR, readTemplate, renderTemplate } from '../pipeline/prompts.js';
import { fixDirPath, snapshotAt } from './quick-fix-files.js';

export interface QuickFixPromptVars {
  client: string;
  job: string;
  /** The note's moment on the preview's timeline, in seconds. */
  atSec: number;
  /** The note, word for word (a voice note's transcript). */
  note: string;
  /** The round the note will be stamped with: `job.round + 1`. */
  round: number;
  fixId: string;
}

const SAFE_FIX_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** The prompt for one quick fix. */
export async function buildQuickFixPrompt(
  vars: QuickFixPromptVars,
  dir: string = PROMPTS_DIR,
): Promise<string> {
  if (!Number.isInteger(vars.round) || vars.round < 1) {
    throw new Error('A quick fix prompt needs the round of the note (1 or more)');
  }
  // A uuid in practice; it goes into paths and commands of the prompt, so nothing else gets through.
  if (!SAFE_FIX_ID.test(vars.fixId)) throw new Error('A quick fix prompt needs a safe fix id');
  const values: Record<string, string> = {
    client: oneLine(vars.client),
    job: oneLine(vars.job),
    time: formatNoteTime(vars.atSec),
    at: snapshotAt(vars.atSec),
    note: oneLine(vars.note),
    round: String(vars.round),
    fixDir: fixDirPath(vars.fixId),
  };
  const partials = { 'composition-rules': await readTemplate(dir, 'composition-rules') };
  const template = await readTemplate(dir, 'quick-fix');
  return `${renderTemplate(template, values, partials)
    .replace(/[ \t]+$/gm, '')
    .trim()}\n`;
}
