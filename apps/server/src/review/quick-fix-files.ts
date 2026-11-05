// Where a quick fix's files live, relative to the job folder (quick fixes plan, section 2; the layout
// is in packages/shared/src/domain/quick-fixes.ts). One folder per fix, `edit/review/fixes/<fixId>/`:
//
//   reply.json          the run's answer (`quickFixReplySchema`)
//   before.png          the note's moment before the fix   } what Compare serves
//   after.png           the same moment after the fix      } (FIX_COMPARE_FILES)
//   stills/before/      what `hyperframes snapshot` wrote for before.png ("at-<t>s.png")
//   stills/after/       ... for after.png
//   stills/frames/      the start and end of each element the run changed (for the run's own look)
//   before/             edit/preview/ as it was (QF3's clone for Undo), never touched here
//
// `hyperframes snapshot` takes a folder, not a file name, so the run writes into stills/ and the
// engine copies the two stills that matter to before.png and after.png once the run has ended
// (`collectCompareStills` in verify-quick-fix.ts), then removes stills/. Forward slashes, as in
// review-files.ts: these paths are printed in the prompt and the job log.

import { z } from 'zod';
import { REVIEW_DIR_PATH } from './review-files.js';

/** edit/review/fixes: every fix of the job, one folder each. */
export const FIXES_DIR_PATH = `${REVIEW_DIR_PATH}/fixes`;

/** The job folder's edit/preview/ and edit/project.md, the two places a fix may change besides its own folder. */
export const FIX_PREVIEW_PATH = 'edit/preview';
export const FIX_PROJECT_PATH = 'edit/project.md';

/** The name of the run's answer in the fix's folder. */
export const FIX_REPLY_FILE = 'reply.json';

/** The sub-folders of stills/ the three snapshot commands of the prompt write into. */
export const FIX_STILLS = {
  before: 'stills/before',
  after: 'stills/after',
  frames: 'stills/frames',
} as const;

/** `edit/review/fixes/<fixId>`, relative to the job folder. */
export function fixDirPath(fixId: string): string {
  return `${FIXES_DIR_PATH}/${fixId}`;
}

/** Decimals kept in the second a snapshot is asked for; the file `hyperframes snapshot` writes carries the same number. */
const AT_DECIMALS = 2;

/** A moment as the `--at` of `hyperframes snapshot` takes it: seconds, at most two decimals, no trailing zeros ("12", "1.5", "12.25"). */
export function snapshotAt(atSec: number): string {
  const safe = Number.isFinite(atSec) && atSec > 0 ? atSec : 0;
  return String(Number(safe.toFixed(AT_DECIMALS)));
}

/**
 * The file `hyperframes snapshot --at=<at> --keep -o <dir>` writes for that moment: `at-<seconds>s.png`
 * (checked with hyperframes 0.8.197: at-0s, at-1.5s, at-12.25s).
 */
export function snapshotFileName(atSec: number): string {
  return `at-${snapshotAt(atSec)}s.png`;
}

/**
 * The run's answer: `done: true` with one short sentence for the owner, or `done: false` with why it
 * could not be done in the composition. Anything else (a missing key, an empty sentence, not JSON)
 * is a bad reply.
 */
export const quickFixReplySchema = z.discriminatedUnion('done', [
  z.object({ done: z.literal(true), said: z.string().trim().min(1) }),
  z.object({ done: z.literal(false), why: z.string().trim().min(1) }),
]);
export type QuickFixReply = z.infer<typeof quickFixReplySchema>;
