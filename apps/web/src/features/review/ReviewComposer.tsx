import { REVIEW_NOTE_MAX_LENGTH } from '@studio/shared';
import { Loader2, MessageSquarePlus, Mic } from 'lucide-react';
import { type Ref, useCallback, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LibraryFrame } from '@/features/library-picker/library-frame';
import { pickerPlaceholder } from '@/features/library-picker/picker-items';
import { useLibraryPicker } from '@/features/library-picker/use-library-picker';
import { FORMAT_TEXT } from './formats/format-logic';
import { composerKeyAction } from './notes-logic';
import { COMPOSER_TEXT } from './review-text';

interface ReviewComposerProps {
  /** "0:03": where the note will be pinned (`formatPlayhead` of the playhead). */
  timeLabel: string;
  draft: string;
  onDraftChange: (text: string) => void;
  /** Enter or Comment, with a non-blank draft. */
  onAdd: () => void;
  /** The textarea got focus: the dialog pauses the video. */
  onFocus: () => void;
  /** The note is on its way: Comment shows a spinner, Enter waits. */
  adding: boolean;
  /** Why the last add failed, in the server's words. */
  error: string | null;
  composerRef: Ref<HTMLTextAreaElement>;
  /** Record (W11). Record is disabled while this is undefined. */
  onRecord?: () => void;
  /** The picture the @ picker shows LUTs on: the paused frame of the video (LU11). Default: the LUTs page's test frame. */
  frame?: LibraryFrame;
  /** Generated videos: the label of the format the note is written on ("9:16"), on a job with two formats. Default: none. */
  formatLabel?: string;
}

/** The board's composer buttons: 32 px, 12 px at the sides, 8 px between the icon and the label (shadcn's small button has 10 and 6). */
const COMPOSER_BUTTON = 'gap-2 has-[>svg]:px-3';

/**
 * The composer under the notes list (board P3Review): "New note at m:ss" follows the playhead, a
 * textarea in its own text direction, then Record on the left and Comment on the right. Focusing
 * the textarea pauses the video; Enter adds the note, Shift+Enter is a new line. Escape is not
 * handled here: the dialog's own Esc moves focus out of the box first. With notes allowed to name
 * LUTs and graphics (`lutsInEdits`) or fonts (`fontsInNotes`), typing `@` opens the picker
 * (library-picker/), whose keys come first and whose Esc closes only the picker, and the "Uses" row
 * sits under the box.
 */
export function ReviewComposer({
  timeLabel,
  draft,
  onDraftChange,
  onAdd,
  onFocus,
  adding,
  error,
  composerRef,
  onRecord,
  frame,
  formatLabel,
}: ReviewComposerProps) {
  const id = useId();
  const errorId = useId();
  // The picker needs the box too (to give it the focus back), and so does the dialog.
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const setBox = useCallback(
    (element: HTMLTextAreaElement | null) => {
      boxRef.current = element;
      if (typeof composerRef === 'function') composerRef(element);
      else if (composerRef) composerRef.current = element;
    },
    [composerRef],
  );
  // `@` in the box adds a LUT or a graphic (LUTs build 2). With the switch off it does nothing,
  // and the box is exactly what it was.
  const picker = useLibraryPicker({
    text: draft,
    onTextChange: onDraftChange,
    textareaRef: boxRef,
    timeLabel,
    frame,
  });

  const box = (
    <Textarea
      id={id}
      ref={setBox}
      dir="auto"
      rows={3}
      maxLength={REVIEW_NOTE_MAX_LENGTH}
      placeholder={picker.enabled ? pickerPlaceholder(picker.pointAt) : COMPOSER_TEXT.placeholder}
      value={draft}
      onChange={(event) => picker.onChange(event.target.value)}
      onFocus={() => {
        picker.onFocus();
        onFocus();
      }}
      onBlur={picker.onBlur}
      onKeyDown={(event) => {
        // The open picker takes ↑ ↓ Enter Tab and Esc; the rest are the box's own.
        if (picker.onKeyDown(event)) return;
        const action = composerKeyAction({
          key: event.key,
          shiftKey: event.shiftKey,
          // keyCode 229 is the key press that confirms an IME composition in browsers that
          // report the composition as over by the time keydown arrives.
          isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
        });
        if (action !== 'add') return;
        event.preventDefault();
        if (!adding) onAdd();
      }}
      aria-describedby={error ? errorId : undefined}
      {...picker.aria}
      className="min-h-0 resize-none px-2.5 py-2 leading-normal [unicode-bidi:plaintext]"
    />
  );

  return (
    <div data-slot="review-composer" className="flex shrink-0 flex-col gap-2 border-t p-3">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {COMPOSER_TEXT.label}{' '}
        <span className="font-medium text-foreground tabular-nums">{timeLabel}</span>
        {formatLabel === undefined ? null : (
          <>
            {' '}
            {FORMAT_TEXT.composerOn}{' '}
            <span className="font-medium text-foreground tabular-nums">{formatLabel}</span>
          </>
        )}
      </label>
      {picker.enabled ? (
        <div className="relative">
          {box}
          <div role="status" aria-live="polite" className="sr-only">
            {picker.status}
          </div>
          {picker.popover}
        </div>
      ) : (
        box
      )}
      {picker.uses}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={onRecord === undefined}
              className={COMPOSER_BUTTON}
              onClick={onRecord}
            >
              <Mic />
              {COMPOSER_TEXT.record}
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{COMPOSER_TEXT.recordTip}</TooltipContent>
        </Tooltip>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="sm"
              disabled={draft.trim() === '' || adding}
              aria-busy={adding}
              className={COMPOSER_BUTTON}
              onClick={onAdd}
            >
              {adding ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <MessageSquarePlus />
              )}
              {COMPOSER_TEXT.comment}
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{COMPOSER_TEXT.commentTip}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
