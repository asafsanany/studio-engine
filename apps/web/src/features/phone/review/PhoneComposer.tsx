import { REVIEW_NOTE_MAX_LENGTH } from '@studio/shared';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { type Ref, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FORMAT_TEXT } from '@/features/review/formats/format-logic';
import { COMPOSER_TEXT, VOICE_TEXT } from '@/features/review/review-text';
import { cn } from '@/lib/utils';

interface PhoneComposerProps {
  /** "0:27": where the note will be pinned (`formatPlayhead` of the playhead). */
  timeLabel: string;
  draft: string;
  onDraftChange: (text: string) => void;
  /** Comment, with a non-blank draft. */
  onAdd: () => void;
  onCancel: () => void;
  /** The box got focus: the review pauses the video. */
  onFocus: () => void;
  /** The note is on its way: Comment shows a spinner and waits. */
  adding: boolean;
  /** Why the last add failed, in the server's words. */
  error: string | null;
  composerRef: Ref<HTMLTextAreaElement>;
  /** The keyboard is up and covers the home indicator: no room is kept for it. */
  keyboardOpen: boolean;
  /** Generated videos: the label of the format the note is written on ("9:16"), on a job with two formats. Default: none. */
  formatLabel?: string;
}

/**
 * Keeps the focus in the box when a button is pressed, so the keyboard stays up until the button
 * has done its work: if it went down first, everything above it would move under the finger.
 */
function keepFocus(event: React.MouseEvent) {
  event.preventDefault();
}

/**
 * The phone's note box (board MReviewWrite): "New note at 0:27", a 16 px box (iPhone Safari zooms
 * into anything smaller) in its own text direction, then Cancel and Comment, 44 px each. It sits
 * under the notes list, and on top of the keyboard while that is up (the review follows
 * `visualViewport`). Return is a new line, as on any phone keyboard (there is no Shift+Return to
 * keep one); Comment adds the note.
 */
export function PhoneComposer({
  timeLabel,
  draft,
  onDraftChange,
  onAdd,
  onCancel,
  onFocus,
  adding,
  error,
  composerRef,
  keyboardOpen,
  formatLabel,
}: PhoneComposerProps) {
  const id = useId();
  const errorId = useId();
  return (
    <div
      data-slot="phone-composer"
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-t border-white/10 bg-background px-4 pt-2.5',
        // The board's 188 px, with the home indicator's room under it unless the keyboard covers it.
        keyboardOpen
          ? 'min-h-[188px] pb-3'
          : 'min-h-[calc(188px+var(--safe-bottom))] pb-[calc(0.75rem+var(--safe-bottom))]',
      )}
    >
      <label htmlFor={id} className="text-xs leading-[1.43] text-muted-foreground">
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
      <Textarea
        id={id}
        ref={composerRef}
        dir="auto"
        rows={3}
        maxLength={REVIEW_NOTE_MAX_LENGTH}
        placeholder={COMPOSER_TEXT.placeholder}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onFocus={onFocus}
        aria-describedby={error ? errorId : undefined}
        className="h-[84px] min-h-0 resize-none rounded-md px-2.5 py-2 text-base leading-[1.4] [unicode-bidi:plaintext] md:text-base"
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-0.5 flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 flex-1 px-0 text-[15px] has-[>svg]:px-0"
          onMouseDown={keepFocus}
          onClick={onCancel}
        >
          {VOICE_TEXT.cancel}
        </Button>
        <Button
          type="button"
          disabled={draft.trim() === '' || adding}
          aria-busy={adding}
          className="h-11 flex-1 px-0 text-[15px] has-[>svg]:px-0"
          onMouseDown={keepFocus}
          onClick={onAdd}
        >
          {adding ? <Loader2 aria-hidden="true" className="animate-spin" /> : <MessageSquarePlus />}
          {COMPOSER_TEXT.comment}
        </Button>
      </div>
    </div>
  );
}
