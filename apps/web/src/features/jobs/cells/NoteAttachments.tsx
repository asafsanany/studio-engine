import { NOTE_ATTACHMENTS } from '@studio/shared';
import { ImageIcon, ImageOff, Loader2, Music, X } from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import {
  ATTACHMENTS_TEXT,
  type AttachmentRow,
  type AttachmentSource,
  attachmentLine,
} from '../note-attachments';

/** What the pictures part of the dialog is given (the host's, from the controller). */
export interface NoteDialogPictures {
  rows: readonly AttachmentRow[];
  /** Files are being dragged over the page: the drop zone and the dialog say where they land. */
  dragging: boolean;
  /** Pictures came in through Choose a file, a paste or a drop. */
  onFiles: (files: File[], source: AttachmentSource) => void;
  /** The × of a row. */
  onRemove: (key: string) => void;
}

interface NoteAttachmentsProps {
  pictures: NoteDialogPictures;
  /** The text holds a link to an Instagram reel: say what the editor does with it. */
  reelLink: boolean;
  /** Save is on its way: nothing can be added or taken off. */
  disabled: boolean;
}

/** Where a row is drawn: the Mac's dialog (72 × 128 thumbnails) or the phone's sheet (54 × 96). */
export type AttachmentRowVariant = 'mac' | 'phone';

/**
 * A picture's thumbnail: the picture, or, when the browser cannot show it (a HEIC in a browser that
 * does not read them), a quiet image icon. Always the shape of a phone screenshot: 72 × 128 on the
 * Mac, 54 × 96 on the phone.
 */
function Thumbnail({
  url,
  compact,
  variant,
}: {
  url: string | null;
  compact: boolean;
  variant: AttachmentRowVariant;
}) {
  // The address that failed, not a flag: a picture whose address changes (a HEIC kept as a JPEG)
  // gets another try.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const showing = url !== null && url !== brokenUrl && !compact;
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-muted',
        variant === 'phone' ? 'w-[54px]' : 'w-[72px]',
        compact ? 'h-12' : variant === 'phone' ? 'h-24' : 'h-32',
      )}
    >
      {showing ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setBrokenUrl(url)}
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-muted-foreground">
          {compact ? (
            <ImageOff aria-hidden="true" className="size-5" />
          ) : (
            <ImageIcon aria-hidden="true" className="size-6" />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One attached picture. On the Mac (board SGNote): a 72 × 128 thumbnail, the name, "Screenshot ·
 * 1.2 MB · pasted", what the brief does with it, and a ghost ×. On the phone (board SGPhone): a
 * 54 × 96 thumbnail, the name, "The brief reads the song off it.", and a 44 px ×. Either way a
 * small spinner covers the thumbnail while the picture is sent, and a picture that did not attach
 * says why in place of the words.
 */
export function NoteAttachmentRow({
  row,
  disabled,
  onRemove,
  variant = 'mac',
}: {
  row: AttachmentRow;
  disabled: boolean;
  onRemove: (key: string) => void;
  variant?: AttachmentRowVariant;
}) {
  const failed = row.status === 'failed';
  const uploading = row.status === 'uploading';
  const phone = variant === 'phone';
  return (
    <li
      className={cn(
        'grid items-center gap-3 border p-2',
        phone
          ? 'grid-cols-[54px_minmax(0,1fr)_44px] rounded-[10px]'
          : 'grid-cols-[72px_minmax(0,1fr)_auto] rounded-lg',
      )}
      data-status={row.status}
    >
      <div className="relative">
        <Thumbnail url={row.previewUrl} compact={failed} variant={variant} />
        {uploading && (
          <div
            role="status"
            className="absolute inset-0 grid place-items-center rounded-md bg-background/60"
          >
            <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
            <span className="sr-only">{ATTACHMENTS_TEXT.uploading}</span>
          </div>
        )}
      </div>
      <span className="flex min-w-0 flex-col gap-0.5">
        <Bidi className="truncate font-medium">{row.name}</Bidi>
        {failed ? (
          <span role="alert" className="text-[13px] text-destructive">
            {row.error}
          </span>
        ) : phone ? (
          <span className="text-[13px] text-pretty text-muted-foreground">
            {ATTACHMENTS_TEXT.readsShort}
          </span>
        ) : (
          <>
            <span className="text-[13px] text-muted-foreground">{attachmentLine(row)}</span>
            <span className="mt-1.5 text-[13px] text-pretty text-muted-foreground">
              {ATTACHMENTS_TEXT.reads}
            </span>
          </>
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={`Remove ${row.name}`}
        onClick={() => onRemove(row.key)}
        className={cn(
          'text-muted-foreground',
          phone ? 'size-11 rounded-[10px]' : 'size-7 self-start',
        )}
      >
        <X aria-hidden="true" className={phone ? 'size-4' : 'size-3.5'} />
      </Button>
    </li>
  );
}

/**
 * The file input behind "Choose a file" (Mac) and "Add photo" (phone): pictures only, several at a
 * time, no `capture` (so a phone offers its Photo Library and Files, not only the camera). Hidden;
 * the button that opens it calls `inputRef.current?.click()`.
 */
export function PictureInput({
  inputRef,
  onFiles,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: File[], source: AttachmentSource) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const chosen = Array.from(event.target.files ?? []);
        // The same file can be chosen again after it was taken off.
        event.target.value = '';
        if (chosen.length > 0) onFiles(chosen, 'chosen');
      }}
    />
  );
}

/**
 * The pictures of "Note for the editor" (Songs, SG5; design canvas page "Songs", board SGNote), under
 * the text box:
 *
 *   - a line that says what the editor does with an Instagram reel link in the text;
 *   - the pictures attached, one row each: a 72 × 128 thumbnail (a small spinner on it while it is
 *     sent), the name, "Screenshot · 1.2 MB · pasted", what the brief does with it, and a ghost ×;
 *     a picture that could not be attached says why in its row;
 *   - while there is none, the drop zone: "Drop a screenshot here or paste one (⌘V). Links go in the
 *     note." with Choose a file. With some, a quiet "Add another" next to "Attached" (until six).
 *
 * Paste and drop are the dialog's (`NoteDialog`, the host): they work anywhere in it. This is only
 * what shows, and the file picker.
 */
export function NoteAttachments({ pictures, reelLink, disabled }: NoteAttachmentsProps) {
  const { rows, dragging, onFiles, onRemove } = pictures;
  const input = useRef<HTMLInputElement>(null);
  const taking = rows.filter((row) => row.status !== 'failed').length;
  const canAddMore = taking < NOTE_ATTACHMENTS.maxFiles;

  const choose = () => input.current?.click();

  return (
    <>
      {reelLink && (
        <div className="-mt-1.5 grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5">
          <Music aria-hidden="true" className="mt-px size-4 text-muted-foreground" />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium">{ATTACHMENTS_TEXT.linkTitle}</span>
            <span className="text-[13px] text-muted-foreground">{ATTACHMENTS_TEXT.link}</span>
          </span>
        </div>
      )}

      {rows.length > 0 && (
        <section aria-label={ATTACHMENTS_TEXT.attached} className="flex flex-col gap-2">
          <div className="flex h-6 items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-muted-foreground">
              {ATTACHMENTS_TEXT.attached}
            </span>
            {canAddMore && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={choose}
                className="text-muted-foreground"
              >
                {ATTACHMENTS_TEXT.addAnother}
              </Button>
            )}
          </div>
          {/* The list scrolls when the window has no room for every row: the rest of the dialog (Save) stays in view. */}
          <ul className="flex max-h-[max(9rem,calc(100dvh-36rem))] flex-col gap-2 overflow-y-auto overscroll-contain">
            {rows.map((row) => (
              <NoteAttachmentRow key={row.key} row={row} disabled={disabled} onRemove={onRemove} />
            ))}
          </ul>
        </section>
      )}

      {rows.length === 0 && (
        <div
          className={cn(
            'flex items-center gap-3 rounded-lg border border-dashed px-3.5 py-3 transition-colors duration-200 ease-in-out',
            dragging && 'border-ring bg-accent/50',
          )}
        >
          <ImageIcon aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />
          <span className="flex-1 text-[13px] text-pretty text-muted-foreground">
            {ATTACHMENTS_TEXT.drop}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={choose}
            className="text-[13px]"
          >
            {ATTACHMENTS_TEXT.choose}
          </Button>
        </div>
      )}

      <PictureInput inputRef={input} onFiles={onFiles} />
    </>
  );
}
