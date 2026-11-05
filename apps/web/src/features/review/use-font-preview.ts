import { useMemo, useRef } from 'react';
import { useFontPickerCatalog } from '@/features/library-picker/use-font-picker-catalog';
import { useLibraryItems } from '@/features/library-picker/use-library-items';
import { type FontPreviewPlan, fontPreviewPlan } from './font-preview';

interface UseFontPreviewOptions {
  /** The note box's text. */
  text: string;
  /**
   * The box is there to be read: false while a voice note has its place (the chips are gone with
   * it, so a font that cannot be taken out is not shown either).
   */
  active: boolean;
}

/**
 * The fonts the note box names for the captions and the titles, for the player to show (FN19; board
 * FOReview, chip and two). `null` while nothing is named, and always with `fontsInNotes` off: then
 * the font list is not even asked for, and the player gets nothing it did not get before. The plan
 * is the same object for as long as it asks for the same things, so typing the rest of the note does
 * not make the player redo its rules; taking a chip's token out gives a plan without that font (or
 * `null`) at once.
 */
export function useFontPreview({ text, active }: UseFontPreviewOptions): FontPreviewPlan | null {
  const { enabled, catalog } = useFontPickerCatalog(active);
  const { items } = useLibraryItems(active);
  const plan = useMemo(
    () => (enabled && active ? fontPreviewPlan(text, catalog, items) : null),
    [enabled, active, text, catalog, items],
  );
  const last = useRef<FontPreviewPlan | null>(null);
  if (plan?.key !== last.current?.key) last.current = plan;
  return last.current;
}
