import type { ReviewNote } from '@studio/shared';
import { toast } from 'sonner';
import { usePatchNote } from '@/data';
import { NOTES_TEXT } from './review-text';

/** What a note card's two toggles show, and what they do. */
export interface NoteToggles {
  /** "Add to style" is on. */
  style: boolean;
  /** "Series" is on. Always false on a card that has no Series toggle. */
  series: boolean;
  toggleStyle: () => void;
  toggleSeries: () => void;
}

/**
 * The state and the actions of a note card's toggles (PATCH `addToStyle` and `addToSeries`). A
 * toggle answers at once: while its PATCH is on its way it shows what was asked for, and a refusal
 * puts it back with a toast carrying the server's reason. Each toggle has its own mutation, so
 * one can be on its way while the other is clicked.
 *
 * `inSeries` is whether the card has the Series toggle (the job is an episode of a series that
 * is known); without it a stale `addToSeries` on the note shows as off and is never sent.
 */
export function useNoteToggles(
  jobId: string,
  note: Pick<ReviewNote, 'id' | 'addToStyle' | 'addToSeries'>,
  inSeries: boolean,
): NoteToggles {
  const patchStyle = usePatchNote(jobId);
  const patchSeries = usePatchNote(jobId);
  const style = patchStyle.isPending
    ? patchStyle.variables?.patch.addToStyle === true
    : note.addToStyle;
  const series =
    inSeries &&
    (patchSeries.isPending ? patchSeries.variables?.patch.addToSeries === true : note.addToSeries);

  return {
    style,
    series,
    toggleStyle() {
      patchStyle
        .mutateAsync({ noteId: note.id, patch: { addToStyle: !style } })
        .catch((error: Error) =>
          toast.error(NOTES_TEXT.styleFailed, { description: error.message }),
        );
    },
    toggleSeries() {
      patchSeries
        .mutateAsync({ noteId: note.id, patch: { addToSeries: !series } })
        .catch((error: Error) =>
          toast.error(NOTES_TEXT.seriesFailed, { description: error.message }),
        );
    },
  };
}
