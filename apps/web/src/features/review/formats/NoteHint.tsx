import type { NoteHintLine, NoteHintTone } from '@studio/shared';
import { cn } from '@/lib/utils';

// The icons of the three kinds of hint, as the boards draw them (GNReview): a new take (a frame with
// a plus), the voice (a microphone) and an edit (a pen on a page).
const ICON_PATHS: Record<NoteHintTone, string> = {
  amber:
    'M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M8 12h8 M12 8v8',
  blue: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
  muted:
    'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.4 2.6a1 1 0 0 1 3 3L12.4 14.6l-4 1 1-4Z',
};

const TONE_CLASS: Record<NoteHintTone, string> = {
  amber: 'text-amber-400',
  blue: 'text-blue-300',
  muted: 'text-muted-foreground',
};

/**
 * The line under a note on a generated video that says what Send will probably do with it and what
 * it costs (boards GNReview, GNPhone): amber for a new take of a clip, blue for a voice line made
 * again, grey for an edit change. It is a hint: the revise run does the real sorting.
 */
export function NoteHint({ hint, phone = false }: { hint: NoteHintLine; phone?: boolean }) {
  return (
    <div
      data-slot="note-hint"
      data-tone={hint.tone}
      className={cn(
        'flex items-start gap-1.5 pr-1 text-xs text-pretty',
        TONE_CLASS[hint.tone],
        phone && 'text-[13px] leading-[1.43]',
      )}
    >
      <svg
        aria-hidden="true"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0"
      >
        <path d={ICON_PATHS[hint.tone]} />
      </svg>
      <span>{hint.text}</span>
    </div>
  );
}
