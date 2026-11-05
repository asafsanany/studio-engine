import { NOTE_ATTACHMENTS, NOTE_MAX_LENGTH } from '@studio/shared';
import { ImageIcon, Loader2, Pause } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { Textarea } from '@/components/ui/textarea';
import { useSongsEnabled } from '@/data';
import { NoteAttachmentRow, PictureInput } from '@/features/jobs/cells/NoteAttachments';
import type { NoteDialogProps } from '@/features/jobs/cells/NoteDialog';
import { NOTE_DIALOG_TEXT, NoteDialog } from '@/features/jobs/cells/NoteDialog';
import { NoteDialogHost, type NoteDialogHostProps } from '@/features/jobs/cells/NoteDialogHost';
import { ATTACHMENTS_TEXT, takePastedPictures } from '@/features/jobs/note-attachments';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { ignoreMessageTaps, PHONE_SHEET_CLASSES } from './phone-sheet-shell';

const TEXT_ID = 'phone-note-text';
const ERROR_ID = 'phone-note-error';

/** The words of the phone's note sheet that the Mac's dialog does not have. */
export const PHONE_NOTE_TEXT = {
  addPhoto: 'Add photo',
} as const;

/**
 * "Note for the editor" as a bottom sheet (board SGPhone, left phone "The note sheet"): the Mac
 * dialog's rules, drawn for a thumb. It takes the dialog's props (`NoteDialogProps`), so
 * `NoteDialogHost` keeps the rules (holding an arriving or queued job while the person writes, Save
 * waiting for the pictures, Cancel throwing away what this opening added) and only what draws them
 * changes. Songs on is what puts it on the phone (`PhoneNoteDialogHost`).
 *
 * Top to bottom: the grabber, the title with the job's name and client under it, the text box (96
 * px, 16 px text so iOS does not zoom), a row for each attached picture (54 × 96 thumbnail, the
 * name, "The brief reads the song off it.", a 44 px ×), a full-width outline "Add photo" (44 px),
 * and the full-width primary Save (48 px). There is no Cancel: the grabber, a tap on the dimmed
 * page and Esc close it, and none of them while the note is on its way.
 *
 * "Add photo" is a file input with no `capture`, so iOS offers its Photo Library and Files (the
 * screenshot Yael sent on WhatsApp, saved to Photos). The pictures' state is the controller's
 * (`note-attachments.ts`), not this sheet's. The text box does not take the focus when the sheet
 * opens: the keyboard would cover Add photo and Save.
 */
export function PhoneNoteSheet({
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
  pictures = null,
}: NoteDialogProps) {
  const content = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const rows = pictures?.rows ?? [];
  const taking = rows.filter((row) => row.status !== 'failed').length;
  const canAddMore = taking < NOTE_ATTACHMENTS.maxFiles;

  return (
    <Sheet
      open={open}
      // Escape or a tap outside must not hide the sheet while the note is on its way.
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <SheetContent
        ref={content}
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        data-slot="phone-note-sheet"
        className={cn(PHONE_SHEET_CLASSES, '[-webkit-tap-highlight-color:transparent]')}
        // The focus starts on the sheet itself: no button is lit by the tap that opened it, and the
        // keyboard stays down until the person taps the box.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        // There is no trigger to give the focus back to (the note is asked for from the job sheet's list).
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={ignoreMessageTaps}
        // A pasted image is attached; text (and anything that is no image) goes to the box.
        onPaste={
          pictures === null || saving
            ? undefined
            : (event) => {
                takePastedPictures(event, pictures.onFiles);
              }
        }
      >
        <SheetGrabber
          onClose={() => {
            if (!saving) onOpenChange(false);
          }}
          className="pt-2"
        />
        <div className="flex flex-col gap-3.5 px-5 pt-3.5">
          <div className="flex flex-col gap-0.5">
            <SheetTitle className="text-[17px] leading-snug">{NOTE_DIALOG_TEXT.title}</SheetTitle>
            <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              <Bidi className="max-w-full">{jobName}</Bidi>
              <span aria-hidden="true">·</span>
              <Bidi className="max-w-full">{client}</Bidi>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={TEXT_ID} className="sr-only">
              {NOTE_DIALOG_TEXT.label}
            </label>
            <Textarea
              id={TEXT_ID}
              dir="auto"
              // Same unit as the server's limit: UTF-16 code units, which is what `maxLength` counts.
              maxLength={NOTE_MAX_LENGTH}
              placeholder={NOTE_DIALOG_TEXT.placeholder}
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              aria-describedby={error === null ? undefined : ERROR_ID}
              // 16 px (not the page's 14 px at md) so iOS Safari does not zoom in when it is tapped.
              className="h-24 min-h-24 resize-none rounded-[10px] bg-background px-3 py-2.5 text-base leading-[1.45] md:text-base [unicode-bidi:plaintext]"
            />
            {error !== null && (
              <p id={ERROR_ID} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>

          {rows.length > 0 && (
            // Scrolls past two rows; Add photo and Save below stay in reach.
            <ul
              aria-label={ATTACHMENTS_TEXT.attached}
              className="flex max-h-[min(236px,30dvh)] flex-col gap-2 overflow-y-auto overscroll-contain"
            >
              {rows.map((row) => (
                <NoteAttachmentRow
                  key={row.key}
                  row={row}
                  variant="phone"
                  disabled={saving}
                  onRemove={pictures?.onRemove ?? (() => {})}
                />
              ))}
            </ul>
          )}

          {pictures !== null && (
            <>
              {canAddMore && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => picker.current?.click()}
                  className="h-11 w-full rounded-[10px] text-[15px]"
                >
                  <ImageIcon aria-hidden="true" />
                  {PHONE_NOTE_TEXT.addPhoto}
                </Button>
              )}
              <PictureInput inputRef={picker} onFiles={pictures.onFiles} />
            </>
          )}

          {held && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Pause aria-hidden="true" className="size-3.5 shrink-0" />
              {NOTE_DIALOG_TEXT.held}
            </p>
          )}

          <Button
            type="button"
            disabled={saving}
            aria-busy={saving}
            onClick={onSave}
            className="h-12 w-full rounded-[10px] text-base font-semibold"
          >
            {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
            {NOTE_DIALOG_TEXT.save}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The phone's "Note for the editor": the bottom sheet while the Songs switch is on (it has the
 * pictures), and the Mac's dialog as it always was while it is off. Mounted once in the phone
 * shell (`PhoneJobSheetHost`). No picker in the box: the phone has none.
 */
export function PhoneNoteDialogHost(
  props: Omit<NoteDialogHostProps, 'view' | 'libraryPicker' | 'pictures'>,
) {
  const songs = useSongsEnabled();
  return (
    <NoteDialogHost {...props} libraryPicker={false} view={songs ? PhoneNoteSheet : NoteDialog} />
  );
}
