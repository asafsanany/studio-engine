import type { LutSummary } from '@studio/shared';
import { toast } from 'sonner';
import { lutsText } from './lut-import-text';

/** The toast id of the import's message: a second import replaces the first one's. */
export const LUT_IMPORT_TOAST_ID = 'luts-imported';

export interface LutImportToast {
  tone: 'success' | 'error';
  title: string;
  /** The second sentence: how to use the LUT, only while notes can name one (`lutsInEdits`). */
  description?: string;
}

/**
 * The words of the toast after an import (board LUStates 6): "Imported 2 LUTs" with "Write
 * @luts/name in a note to use one." under it while notes can name a LUT; "Imported 1 LUT. 1 could
 * not be added." when some failed (their reasons stay in the dialog); and an error when none went in.
 */
export function lutImportToast(
  imported: readonly Pick<LutSummary, 'slug'>[],
  failedCount: number,
  lutsInEdits: boolean,
): LutImportToast {
  if (imported.length === 0) {
    return { tone: 'error', title: `${lutsText(failedCount)} could not be added.` };
  }
  if (failedCount > 0) {
    return {
      tone: 'success',
      title: `Imported ${lutsText(imported.length)}. ${failedCount} could not be added.`,
    };
  }
  const first = imported[0];
  return {
    tone: 'success',
    title: `Imported ${lutsText(imported.length)}`,
    ...(lutsInEdits &&
      first !== undefined && {
        description: `Write @luts/${first.slug} in a note to use one.`,
      }),
  };
}

/** Shows the toast of an import. */
export function announceLutsImported(
  imported: readonly Pick<LutSummary, 'slug'>[],
  failedCount: number,
  lutsInEdits: boolean,
): void {
  const { tone, title, description } = lutImportToast(imported, failedCount, lutsInEdits);
  const options = { id: LUT_IMPORT_TOAST_ID, description };
  if (tone === 'error') toast.error(title, options);
  else toast.success(title, options);
}
