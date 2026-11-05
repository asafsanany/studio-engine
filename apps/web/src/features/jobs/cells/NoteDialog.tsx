import { NOTE_MAX_LENGTH } from '@studio/shared';
import { Loader2, Pause } from 'lucide-react';
import { type ComponentProps, type RefObject, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useFontsInNotesEnabled } from '@/data/fonts-query';
import { useLutsInEditsEnabled } from '@/data/luts-query';
import { useLibraryPicker } from '@/features/library-picker/use-library-picker';
import { escapeIsForPicker } from '@/features/review/review-keys';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { ATTACHMENTS_TEXT, hasInstagramReelLink, takePastedPictures } from '../note-attachments';
import { useFitDialogTop } from '../use-fit-dialog-top';
import { NoteAttachments, type NoteDialogPictures } from './NoteAttachments';

/**
 * The placeholder of the box when it has the picker: "…Type @ to point at a LUT or a graphic."
 * `pointAt` is what `@` points at (`LibraryPicker.pointAt`); with fonts in the notes it is "a font,
 * a LUT or a graphic" (or "a font" alone), the same words the Review box uses.
 */
export function noteDialogPlaceholder(pointAt: string): string {
  return `e.g. Keep it under 30 seconds. Type @ to point at ${pointAt}.`;
}

/** The words of the dialog (design canvas, Phase 1: "Note for the editor"). */
export const NOTE_DIALOG_TEXT = {
  title: 'Note for the editor',
  description:
    'The brief comes from the files in the job folder. Add anything else the edit should follow: your note wins over everything the client sent.',
  label: 'Note',
  placeholder: 'e.g. Keep it under 30 seconds. Use the second take of the intro.',
  /** With notes allowed to name a LUT or a graphic (`lutsInEdits`): the same, and how to point at one. */
  placeholderWithPicker: noteDialogPlaceholder('a LUT or a graphic'),
  /** Shown while the dialog itself is holding the job. */
  held: 'This job waits while you write. Saving puts it back in line.',
  cancel: 'Cancel',
  save: 'Save',
} as const;

const TEXT_ID = 'note-dialog-text';
const ERROR_ID = 'note-dialog-error';
/** Where the dialog sits while its box can open the picker: see `NoteDialog`. */
const PICKER_DIALOG_POSITION = 'sm:top-[288px] sm:translate-y-0';
/** The same 288 px, for `useFitDialogTop`. */
const PICKER_DIALOG_TOP_PX = 288;
const BOX_CLASS = 'max-h-[50vh] min-h-[168px] resize-y leading-normal [unicode-bidi:plaintext]';

/** What a view of the note dialog is given: the Mac's `NoteDialog`, or the phone's bottom sheet. */
export interface NoteDialogProps {
  open: boolean;
  /** The job the note is for, as it was when the dialog was asked for. */
  jobName: string;
  client: string;
  text: string;
  onTextChange: (text: string) => void;
  /** This dialog is holding the job: say that it waits, and that Save puts it back in line. */
  held: boolean;
  /** "Save" was pressed and the answer is not in: Save and Cancel are off and it cannot be closed. */
  saving: boolean;
  /** Why the last Save failed, in the server's words; `null` when it did not. */
  error: string | null;
  onSave: () => void;
  /** Cancel, Escape or a click outside (`false`). Not called while `saving`. */
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  /**
   * The box can point at a font, a LUT or a graphic with `@` (only while `fontsInNotes` or
   * `lutsInEdits` is on). The phone's sheet turns it off: the phone has no picker and no chips.
   * (The phone's bottom sheet, `PhoneNoteSheet`, has no box with a picker at all.)
   */
  libraryPicker?: boolean;
  /**
   * Pictures for the note (Songs, SG5): the drop zone and the rows under the box, and a paste of
   * an image or a drop of a file anywhere in the dialog attaches it. Left out, the dialog is as it
   * was (the switch is off). The phone's sheet (`PhoneNoteSheet`) draws the same pictures with its
   * own Add photo.
   */
  pictures?: NoteDialogPictures | null;
}

interface NoteBoxProps {
  text: string;
  onTextChange: (text: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  error: string | null;
}

/** The box as it always was: a plain text area, no picker. */
function PlainNoteBox({ text, onTextChange, textarea, error }: NoteBoxProps) {
  return (
    <Textarea
      id={TEXT_ID}
      ref={textarea}
      dir="auto"
      rows={7}
      // Same unit as the server's limit: UTF-16 code units, which is what `maxLength` counts.
      maxLength={NOTE_MAX_LENGTH}
      placeholder={NOTE_DIALOG_TEXT.placeholder}
      value={text}
      onChange={(event) => onTextChange(event.target.value)}
      aria-describedby={error === null ? undefined : ERROR_ID}
      className={BOX_CLASS}
    />
  );
}

/**
 * The box with the @ picker (LUTs build 2, `lutsInEdits`; Fonts build 2, `fontsInNotes`): typing
 * `@` offers the LUTs and graphics and, with fonts in the notes, the fonts, and a "Uses" row of
 * chips sits under the box (the live preview is Review's only). A note for the editor has no time,
 * so a graphic is placed "where it fits" (`timeLabel` null). With both switches off the picker is
 * inert and this is the plain box, markup for markup.
 */
function PickerNoteBox({ text, onTextChange, textarea, error }: NoteBoxProps) {
  const picker = useLibraryPicker({ text, onTextChange, textareaRef: textarea, timeLabel: null });
  if (!picker.enabled) {
    return (
      <PlainNoteBox text={text} onTextChange={onTextChange} textarea={textarea} error={error} />
    );
  }
  return (
    <>
      <div className="relative">
        <Textarea
          id={TEXT_ID}
          ref={textarea}
          dir="auto"
          rows={7}
          maxLength={NOTE_MAX_LENGTH}
          placeholder={noteDialogPlaceholder(picker.pointAt)}
          value={text}
          onChange={(event) => picker.onChange(event.target.value)}
          onFocus={picker.onFocus}
          onBlur={picker.onBlur}
          // The open picker takes ↑ ↓ Enter Tab and Esc; every other key is the box's own.
          onKeyDown={(event) => {
            picker.onKeyDown(event);
          }}
          aria-describedby={error === null ? undefined : ERROR_ID}
          {...picker.aria}
          className={BOX_CLASS}
        />
        <div role="status" aria-live="polite" className="sr-only">
          {picker.status}
        </div>
        {picker.popover}
      </div>
      {picker.uses}
    </>
  );
}

/**
 * "Note for the editor": what the owner wants the edit to follow on top of the client's files. The
 * job's name and client sit under the title (each in its own direction: Hebrew, Latin or mixed), a
 * `dir="auto"` text box fills the dialog and has the focus when it opens, and, when the dialog is
 * holding the job, a muted line says that the job waits until Save.
 *
 * With `pictures` (Songs) the pictures of the note sit under the box (`NoteAttachments`).
 *
 * Presentational: `NoteDialogHost` owns the requests and the state.
 */
export function NoteDialog({
  open,
  jobName,
  client,
  text,
  onTextChange,
  held,
  saving,
  error,
  onSave,
  onOpenChange,
  onCloseAutoFocus,
  libraryPicker = true,
  pictures = null,
}: NoteDialogProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  // The box has the picker while notes can name a LUT or a graphic, or a font. Both hooks run on
  // every render (a hook behind `||` would run a different number of times as the answers arrive).
  const lutsInEdits = useLutsInEditsEnabled();
  const fontsInNotes = useFontsInNotesEnabled();
  const pickerOn = (lutsInEdits || fontsInNotes) && libraryPicker;
  // With pictures the dialog grows by a thumbnail's height: its top then moves up to keep Save in view.
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useFitDialogTop(content, pickerOn && pictures !== null, PICKER_DIALOG_TOP_PX);

  return (
    <Dialog
      open={open}
      // Escape or a click outside must not hide the dialog while the note is on its way.
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent
        ref={setContent}
        // The board has no close button: Cancel is the way out.
        showCloseButton={false}
        // The board's dialog reads at a 1.5 line height (the page's is 1.43): about 4 px taller.
        // With the picker on, the dialog sits 288 px from the top, not centred: the picker opens
        // above the box and is 413 px tall, and the box is 140 px below the dialog's top, so the
        // picker then ends 15 px below the top of the window, however tall the window is.
        className={cn('leading-normal sm:max-w-[520px]', pickerOn && PICKER_DIALOG_POSITION)}
        onOpenAutoFocus={(event) => {
          // The text box, with the caret after the note that is already there.
          event.preventDefault();
          const box = textarea.current;
          if (box === null) return;
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }}
        // The @ picker, when open, takes this Esc to close itself; the dialog stays.
        onEscapeKeyDown={(event) => {
          if (escapeIsForPicker(document.activeElement)) event.preventDefault();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        // A pasted image is attached; text (and anything that is no image) goes to the box.
        onPaste={
          pictures === null || saving
            ? undefined
            : (event) => {
                takePastedPictures(event, pictures.onFiles);
              }
        }
      >
        {pictures?.dragging && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg border-2 border-dashed border-ring bg-background/80 text-sm font-medium"
          >
            {ATTACHMENTS_TEXT.dropOverlay}
          </div>
        )}
        <DialogHeader className="gap-1.5">
          <DialogTitle className="leading-[1.4]">{NOTE_DIALOG_TEXT.title}</DialogTitle>
          <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
            <Bidi className="max-w-full font-medium text-foreground">{jobName}</Bidi>
            <span aria-hidden="true">·</span>
            <Bidi className="max-w-full">{client}</Bidi>
          </div>
          <DialogDescription className="leading-normal">
            {NOTE_DIALOG_TEXT.description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={TEXT_ID} className="sr-only">
            {NOTE_DIALOG_TEXT.label}
          </label>
          {libraryPicker ? (
            <PickerNoteBox
              text={text}
              onTextChange={onTextChange}
              textarea={textarea}
              error={error}
            />
          ) : (
            <PlainNoteBox
              text={text}
              onTextChange={onTextChange}
              textarea={textarea}
              error={error}
            />
          )}
          {error !== null && (
            <p id={ERROR_ID} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        {pictures !== null && (
          <NoteAttachments
            pictures={pictures}
            reelLink={hasInstagramReelLink(text)}
            disabled={saving}
          />
        )}

        {held && (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Pause aria-hidden="true" className="size-3.5 shrink-0" />
            {NOTE_DIALOG_TEXT.held}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {NOTE_DIALOG_TEXT.cancel}
          </Button>
          <Button disabled={saving} aria-busy={saving} onClick={onSave}>
            {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
            {NOTE_DIALOG_TEXT.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
