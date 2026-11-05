import { type FontFamilySummary, faceName } from '@studio/shared';
import { toast } from 'sonner';
import { fontsText } from './font-import-text';

/** The toast id of the import's message: a second import replaces the first one's. */
export const FONT_IMPORT_TOAST_ID = 'fonts-imported';

export interface FontImportToast {
  tone: 'success' | 'error';
  title: string;
  /** The second sentence: how to use a font, only while notes can name one (`fontsInNotes`). */
  description?: string;
}

/**
 * What to write in a note to use the family: its heaviest weight's face name ("Karantina Bold"),
 * or the family's name alone when that is Regular ("Bebas Neue").
 */
export function heaviestFaceName(family: Pick<FontFamilySummary, 'name' | 'weights'>): string {
  const weight = family.weights.reduce((most, one) => Math.max(most, one), 0);
  return faceName(family.name, weight === 0 ? 400 : weight, false);
}

/**
 * The words of the toast after an import (board FOPage, "Imported"): "Imported 2 fonts" with "Write
 * @Karantina Bold in a note to use one." under it while notes can name a font; "Imported 1 font. 1
 * could not be added." when some failed (their reasons stay in the dialog); and an error when none
 * went in. The example is the family the page opens (the first the engine answered with), as in
 * the board, where the toast names the family that is open beside it.
 */
export function fontImportToast(
  imported: readonly Pick<FontFamilySummary, 'name' | 'weights'>[],
  failedCount: number,
  fontsInNotes: boolean,
): FontImportToast {
  if (imported.length === 0) {
    return { tone: 'error', title: `${fontsText(failedCount)} could not be added.` };
  }
  if (failedCount > 0) {
    return {
      tone: 'success',
      title: `Imported ${fontsText(imported.length)}. ${failedCount} could not be added.`,
    };
  }
  const example = imported[0];
  return {
    tone: 'success',
    title: `Imported ${fontsText(imported.length)}`,
    ...(fontsInNotes &&
      example !== undefined && {
        description: `Write @${heaviestFaceName(example)} in a note to use one.`,
      }),
  };
}

/** Shows the toast of an import. */
export function announceFontsImported(
  imported: readonly Pick<FontFamilySummary, 'name' | 'weights'>[],
  failedCount: number,
  fontsInNotes: boolean,
): void {
  const { tone, title, description } = fontImportToast(imported, failedCount, fontsInNotes);
  const options = { id: FONT_IMPORT_TOAST_ID, description };
  if (tone === 'error') toast.error(title, options);
  else toast.success(title, options);
}
