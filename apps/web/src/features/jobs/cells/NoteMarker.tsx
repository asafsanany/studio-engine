import { MessageSquareText } from 'lucide-react';
import type { FontPickerCatalog } from '@/features/library-picker/font-picker';
import { NoteTokenText } from '@/features/library-picker/NoteTokenText';
import type { PickerItem } from '@/features/library-picker/picker-items';
import { HoverMarker } from './HoverMarker';

interface NoteMarkerProps {
  note: string;
  /**
   * The font library, when notes can name a font (`fontsInNotes`): a font token in the note is a
   * pill in the tooltip, as it is in Review. Left out, the tooltip is the note's text.
   */
  fonts?: FontPickerCatalog;
  /** With `fonts`: the LUTs and graphics a note can name (only while `lutsInEdits` is on). */
  items?: readonly PickerItem[];
}

/**
 * The mark that says a job has a note: a muted 14 px message icon right after the job's name.
 * Hovering or focusing it (it takes the keyboard's focus) shows the note itself in a tooltip, line
 * breaks kept, at most 280 px wide, reading in its own direction (`dir="auto"`: Hebrew, Latin or
 * mixed). A very long note is cut off at half the screen: the full text is in the dialog.
 */
export function NoteMarker({ note, fonts, items }: NoteMarkerProps) {
  return (
    <HoverMarker
      icon={MessageSquareText}
      label="Your note"
      tooltipDir="auto"
      tooltipClassName="max-h-[50vh] max-w-[280px] overflow-hidden leading-normal whitespace-pre-line"
    >
      {fonts === undefined ? note : <NoteTokenText text={note} items={items ?? []} fonts={fonts} />}
    </HoverMarker>
  );
}
