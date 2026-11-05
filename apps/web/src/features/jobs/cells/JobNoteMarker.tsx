import { useFontPickerCatalog } from '@/features/library-picker/use-font-picker-catalog';
import { useLibraryItems } from '@/features/library-picker/use-library-items';
import { NoteMarker } from './NoteMarker';

/**
 * The note marker of a job that has a note (the Jobs list). While notes can name a font
 * (`fontsInNotes`) the tooltip shows a font token as a pill, as Review does; with the switch off
 * nothing is asked and the tooltip is the note's text, as it was. Only a job with a note asks: the
 * font list is the one query the Fonts page shares.
 */
export function JobNoteMarker({ note }: { note: string }) {
  const fonts = useFontPickerCatalog();
  // The LUTs and graphics only matter next to the fonts (a LUT token is a pill then too): asked only then.
  const library = useLibraryItems(fonts.enabled);
  return (
    <NoteMarker
      note={note}
      fonts={fonts.enabled ? fonts.catalog : undefined}
      items={library.enabled ? library.items : undefined}
    />
  );
}
