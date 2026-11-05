import type { ReviewNote } from '@studio/shared';
import { Layers2, type LucideIcon, Mic, Palette, Trash2 } from 'lucide-react';
import { memo, type ReactNode, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FontPickerCatalog } from '@/features/library-picker/font-picker';
import { NoteTokenText, SentNoteLines } from '@/features/library-picker/NoteTokenText';
import type { PickerItem } from '@/features/library-picker/picker-items';
import { cn } from '@/lib/utils';
import type { NoteFixLine } from './fix-lines';
import type { NoteMark } from './formats/format-logic';
import { NoteHint } from './formats/NoteHint';
import { NoteFixLineView } from './NoteFixLine';
import { goToLabel, noteTime } from './notes-logic';
import { NOTES_TEXT } from './review-text';
import { useNoteToggles } from './use-note-toggles';
import { VoiceNoteBody } from './VoiceNoteBody';

interface NoteCardProps {
  note: ReviewNote;
  jobId: string;
  /** The job's client, named in the "Add to style" line. */
  client: string;
  /**
   * The series the job is an episode of, named in the "Series" line; `null` for any other job (and
   * while series are off), where the card has the one "Add to style" toggle it always had.
   */
  seriesName: string | null;
  hovered: boolean;
  active: boolean;
  onHover: (noteId: string | null) => void;
  /** The time chip: seek there, pause and select the note. */
  onGo: (note: ReviewNote) => void;
  onDelete: (note: ReviewNote) => void;
  /** Registers the card for `scrollIntoView` (a hovered dot brings its note into view). */
  cardRef: (noteId: string, element: HTMLElement | null) => void;
  /** A voice note starts playing: the dialog pauses the video. Stable, for the memo. */
  onPlayVoice: () => void;
  /**
   * On the phone (board MReviewNotes) the card has 32 px buttons for a finger, no tooltips (there is
   * no hover) and no hover tint. Default: the Mac's.
   */
  variant?: 'mac' | 'phone';
  /**
   * The LUTs and graphics a note can name (`lutsInEdits` on). Each `@luts/…` / `@graphics/…` token
   * of a text note that points at one of them shows as a chip, with a dim line under the note
   * saying what the next edit does with it. Omitted (the switch is off, and the phone's cards):
   * the text is shown as it always was. Keep it a stable array, for the memo.
   */
  libraryItems?: readonly PickerItem[];
  /**
   * The font library, when notes can name a font (`fontsInNotes` on). Then `@Heebo Bold` in a text
   * note shows as a chip too (with the other kinds, after a hyphen as well), and the dim line says
   * which text the next edit sets in it. Omitted: as before. Keep it stable, for the memo.
   */
  fontCatalog?: FontPickerCatalog;
  /**
   * Quick fixes (`quickFixes` on): the line under the note that answers it ("Reading the note…",
   * "Fixing it now · …", "Fixed in 38 s. …" with Undo, "Goes with Send · …") and what it means for
   * the delete button. `null`: Quick fixes are on and this note has no line. Omitted: they are off,
   * and the card is as it always was. Keep it stable, for the memo.
   */
  fixLine?: NoteFixLine | null;
  /** Undo was pressed on a fixed note's line (the fix's id). Stable, for the memo. */
  onUndo?: (fixId: string) => void;
  /** An Undo is on its way. */
  undoing?: boolean;
  /**
   * Generated videos: the format the note was written on, printed after its time ("0:32 1:1"), and
   * the line that says what Send will probably do with it and what it costs. Omitted: the card is
   * as it always was. Keep it stable, for the memo.
   */
  mark?: NoteMark;
}

/** No LUTs or graphics: fonts alone can be named. */
const NO_ITEMS: readonly PickerItem[] = [];

function noop(): void {}

/** A control's tooltip on the Mac; on the phone there is no hover, so the control stands alone. */
function Tip({ phone, tip, children }: { phone: boolean; tip: string; children: ReactNode }) {
  if (phone) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent sideOffset={6}>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** One of the card's two-state toggles: outline when off, filled when on. */
function NoteToggle({
  icon: Icon,
  on,
  label,
  tip,
  phone,
  onToggle,
}: {
  icon: LucideIcon;
  on: boolean;
  label: string;
  tip: string;
  phone: boolean;
  onToggle: () => void;
}) {
  return (
    <Tip phone={phone} tip={tip}>
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-pressed={on}
        className={cn(
          'gap-[5px] rounded-sm has-[>svg]:px-2',
          phone && 'h-8 has-[>svg]:px-[9px]',
          on
            ? 'border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background dark:border-foreground dark:bg-foreground dark:hover:bg-foreground/90'
            : 'text-muted-foreground hover:text-foreground dark:bg-transparent',
        )}
        onClick={onToggle}
      >
        <Icon />
        {label}
      </Button>
    </Tip>
  );
}

/** A line under the note that says where it goes when the notes are sent. */
function NoteLine({
  icon: Icon,
  text,
  name,
  phone,
}: {
  icon: LucideIcon;
  text: string;
  name: string;
  phone: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 border-t border-white/[0.08] pt-1.5 pr-1 text-xs text-muted-foreground',
        // Board MReviewNotes: 2 px under the text above, 6 px at the right, the page's 1.43 line.
        phone && 'mt-0.5 pr-1.5 leading-[1.43]',
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span>
        {text} <bdi className="text-foreground">{name}</bdi>
      </span>
    </div>
  );
}

/**
 * One note of the review dialog's list (board P3Review): its time, a "Voice note" tag, the "Add to
 * style" toggle, delete, and the note's text. A note on an episode of a series (board SeriesNotes)
 * has two short toggles instead: "Series" (also change every later episode) and "Style". On the
 * phone (board MReviewSeries) the two keep their short labels when on, and are told apart by their
 * fill. Memoised, with stable callbacks and boolean props, so the list doesn't re-render ten times
 * a second while the video plays.
 *
 * A text note's text is word for word, in its own text direction. A voice note shows its player,
 * waveform and transcript instead (`VoiceNoteBody`).
 */
function NoteCardView({
  note,
  jobId,
  client,
  seriesName,
  hovered,
  active,
  onHover,
  onGo,
  onDelete,
  cardRef,
  onPlayVoice,
  variant = 'mac',
  libraryItems,
  fontCatalog,
  fixLine,
  onUndo,
  undoing = false,
  mark,
}: NoteCardProps) {
  const phone = variant === 'phone';
  const running = fixLine?.kind === 'running';
  const deleteMode = fixLine?.deleteMode ?? 'ok';
  // Registers the card for scrolling, and forgets it when the card goes away.
  const register = useCallback(
    (element: HTMLElement | null) => {
      cardRef(note.id, element);
      return () => cardRef(note.id, null);
    },
    [cardRef, note.id],
  );
  const toggles = useNoteToggles(jobId, note, seriesName !== null);

  return (
    <article
      ref={register}
      data-slot="review-note"
      data-note-id={note.id}
      data-kind={note.kind}
      data-state={active ? 'active' : hovered ? 'hovered' : 'idle'}
      className={cn(
        'flex shrink-0 flex-col gap-1.5 rounded-md border pt-2 pr-2 pb-2.5 pl-3 transition-colors ease-in-out',
        // The border takes 300 ms to turn blue while a fix runs and to settle after it (board QFReview).
        fixLine ? 'duration-300' : 'duration-150',
        phone && 'gap-1 pt-1.5 pr-1.5 pl-2.5',
        active
          ? 'border-white/35 bg-white/[0.06]'
          : hovered
            ? 'border-[#3B82F6]/50 bg-[#3B82F6]/[0.08]'
            : running
              ? 'border-[#3B82F6]/45 bg-white/[0.02]'
              : 'border-border bg-white/[0.02]',
      )}
      onMouseEnter={phone ? undefined : () => onHover(note.id)}
      onMouseLeave={phone ? undefined : () => onHover(null)}
    >
      <div className={cn('flex items-center', seriesName === null ? 'gap-2' : 'gap-1.5')}>
        <button
          type="button"
          aria-label={
            mark?.formatLabel
              ? `${goToLabel(note.atSec)} on ${mark.formatLabel}`
              : goToLabel(note.atSec)
          }
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm bg-secondary text-xs font-medium tabular-nums text-foreground outline-none transition-colors ease-in-out hover:bg-accent/80 focus-visible:ring-[3px] focus-visible:ring-ring/35',
            phone ? 'h-8 px-[9px] text-[13px]' : 'h-[22px] px-[7px]',
          )}
          onClick={() => onGo(note)}
        >
          <span className="size-1.5 rounded-full bg-[#3B82F6]" />
          {noteTime(note.atSec)}
          {mark?.formatLabel ? <span>{mark.formatLabel}</span> : null}
        </button>
        {note.kind === 'voice' ? (
          seriesName === null || phone ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Mic aria-hidden="true" className="size-3" />
              {NOTES_TEXT.voiceTag}
            </span>
          ) : (
            // Two toggles and the delete button leave no room for the words in 360 px.
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center text-muted-foreground">
                  <Mic aria-hidden="true" className="size-3" />
                  <span className="sr-only">{NOTES_TEXT.voiceTag}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{NOTES_TEXT.voiceTag}</TooltipContent>
            </Tooltip>
          )
        ) : null}
        <span className="flex-1" />
        {seriesName === null ? null : (
          <NoteToggle
            icon={Layers2}
            on={toggles.series}
            // The phone's toggle keeps its short label and is filled when on (board MReviewSeries).
            label={toggles.series && !phone ? NOTES_TEXT.inSeries : NOTES_TEXT.series}
            tip={toggles.series ? NOTES_TEXT.inSeriesTip : NOTES_TEXT.addToSeriesTip}
            phone={phone}
            onToggle={toggles.toggleSeries}
          />
        )}
        <NoteToggle
          icon={Palette}
          on={toggles.style}
          label={
            toggles.style && !(phone && seriesName !== null)
              ? NOTES_TEXT.inStyle
              : seriesName === null
                ? NOTES_TEXT.addToStyle
                : NOTES_TEXT.episodeStyle
          }
          tip={
            toggles.style
              ? NOTES_TEXT.inStyleTip
              : seriesName === null
                ? NOTES_TEXT.addToStyleTip
                : NOTES_TEXT.episodeStyleTip
          }
          phone={phone}
          onToggle={toggles.toggleStyle}
        />
        {/* Only the newest fix can be deleted (it is undone first), and not while its fix runs. */}
        {deleteMode === 'hidden' ? null : (
          <Tip phone={phone} tip={NOTES_TEXT.deleteNote}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={NOTES_TEXT.deleteNote}
              disabled={deleteMode === 'disabled'}
              className={cn('rounded-sm text-muted-foreground', phone ? 'size-9' : 'size-7')}
              onClick={() => onDelete(note)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </Tip>
        )}
      </div>

      {note.kind === 'text' ? (
        <p
          dir="auto"
          className={cn(
            'pr-1 break-words whitespace-pre-wrap text-foreground [unicode-bidi:plaintext]',
            phone && 'text-[15px]',
          )}
        >
          {libraryItems === undefined && fontCatalog === undefined ? (
            note.text
          ) : (
            <NoteTokenText
              text={note.text ?? ''}
              items={libraryItems ?? NO_ITEMS}
              fonts={fontCatalog}
            />
          )}
        </p>
      ) : null}
      {note.kind === 'text' && (libraryItems !== undefined || fontCatalog !== undefined) ? (
        <SentNoteLines
          text={note.text ?? ''}
          items={libraryItems ?? NO_ITEMS}
          timeLabel={noteTime(note.atSec)}
          fonts={fontCatalog}
        />
      ) : null}
      {note.kind === 'voice' ? (
        <VoiceNoteBody
          note={note}
          jobId={jobId}
          onPlay={onPlayVoice}
          variant={phone ? 'phone' : 'mac'}
        />
      ) : null}

      {mark?.hint ? <NoteHint hint={mark.hint} phone={phone} /> : null}

      {fixLine === undefined ? null : (
        <NoteFixLineView line={fixLine} phone={phone} onUndo={onUndo ?? noop} undoing={undoing} />
      )}

      {toggles.series && seriesName !== null ? (
        <NoteLine
          icon={Layers2}
          text={phone ? NOTES_TEXT.seriesLinePhone : NOTES_TEXT.seriesLine}
          name={seriesName}
          phone={phone}
        />
      ) : null}
      {toggles.style ? (
        <NoteLine icon={Palette} text={NOTES_TEXT.styleLine} name={client} phone={phone} />
      ) : null}
    </article>
  );
}

export const NoteCard = memo(NoteCardView);
