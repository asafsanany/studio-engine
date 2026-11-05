import { canEditEffort, effortLabel, type Job, type TimeInput } from '@studio/shared';
import { Mic, Sparkles } from 'lucide-react';
import { Fragment } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuickFixesEnabled, useSentNotes } from '@/data';
import type { FontPickerCatalog } from '@/features/library-picker/font-picker';
import { NoteTokenText } from '@/features/library-picker/NoteTokenText';
import type { PickerItem } from '@/features/library-picker/picker-items';
import { useFontPickerCatalog } from '@/features/library-picker/use-font-picker-catalog';
import { useLibraryItems } from '@/features/library-picker/use-library-items';
import { formatsOf } from '@/features/review/formats/format-logic';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { type RowActions, useRowActionsContext } from '../jobs/cells/use-row-actions';
import { SKELETON_DELAY_MS, useDelayedFlag } from '../jobs/delayed-flag';
import { REVIEW_EFFORT_WORDS } from '../jobs/effort-options';
import { askForNote } from '../jobs/note-dialog';
import { effortMenuEntry, reviewEffortMenuEntry } from '../jobs/row-menu';
import {
  effortValue,
  noteRow,
  type SentNote,
  type SentRound,
  SHEET_NOTES_TEXT,
  sentRounds,
} from './sheet-notes';
import type { SheetVariant } from './sheet-variant';

/** A label, its value and (at the end) what can be done about it: 96 px, the rest, the button. */
const ROW = 'grid min-h-[30px] grid-cols-[96px_minmax(0,1fr)_auto] items-baseline gap-3';

/** The small ghost text button at the end of a row: "Add", "Edit", "Change". */
const ROW_BUTTON = 'h-[26px] px-2 text-muted-foreground';

/** The person's own words: wrap and keep their line breaks, each string in its own direction. */
const OWN_WORDS = 'overflow-visible whitespace-pre-wrap break-words text-clip';

interface NotesViewProps {
  job: Job;
  /** The notes they sent, round by round (none: that part is left out). */
  rounds: readonly SentRound[];
  /** They are still being fetched, and have been for a while: draw placeholders. */
  loading: boolean;
  /** "Add" / "Edit": opens the note dialog. */
  onAskNote: () => void;
  /** Saves the job's effort (`null` is Default); `null` when the sheet has no way to (no row actions). */
  onSetEffort: RowActions['setEffort'] | null;
  /**
   * Whether Quick fixes are on. Then a job in Review shows the level of its review rounds (Auto, or
   * Medium, High, Extra high) in the Effort row, and Change saves that one (`onSetReviewEffort`);
   * every other state keeps the edit's effort. Left out: off.
   */
  quickFixes?: boolean;
  /** Saves the job's review effort (`null` is Auto); `null` or left out when the sheet has no way to. */
  onSetReviewEffort?: RowActions['setReviewEffort'] | null;
  /**
   * The LUTs and graphics a note can name (`useLibraryItems`, only while `lutsInEdits` is on): the
   * note for the editor shows the tokens that point at one as chips. Left out: the note is its text.
   */
  libraryItems?: readonly PickerItem[];
  /**
   * The font library, when notes can name a font (`fontsInNotes`, `useFontPickerCatalog`): a font
   * token is a pill too, in the note for the editor and in the notes they sent, as in Review. Left
   * out, the notes are as they were. The phone's part ignores it (Fonts is desktop first).
   */
  fonts?: FontPickerCatalog;
  /**
   * `phone` draws the phone sheet's part (board MJobSheetHeld): the note for the editor in a box,
   * and the rounds of notes under it. The note and the effort are changed from the phone's list
   * (Add note…, Effort), so the row buttons are not here.
   */
  variant?: SheetVariant;
}

function NoOp() {}

/** What a note's words are read with: the LUTs and graphics a note can name, and the fonts. */
interface TokenSources {
  libraryItems?: readonly PickerItem[];
  fonts?: FontPickerCatalog;
}

/**
 * A note's words. With fonts in the notes a token that names a font (or a LUT or graphic) is a pill,
 * as in Review; without, the words are the text, as they always were.
 */
function NoteWords({ text, fonts, libraryItems }: { text: string } & TokenSources) {
  if (fonts === undefined) return <>{text}</>;
  return <NoteTokenText text={text} items={libraryItems ?? []} fonts={fonts} />;
}

/** One note they sent: its time chip, the voice line and the words, the tags under them. */
function SentNoteView({ note, ...sources }: { note: SentNote } & TokenSources) {
  return (
    <div
      data-slot="sent-note"
      data-note-id={note.id}
      className="grid grid-cols-[minmax(44px,auto)_minmax(0,1fr)] items-start gap-2.5"
    >
      <span
        data-slot="sent-note-time"
        className="h-5 justify-self-start rounded-[5px] border border-white/[0.08] bg-zinc-900 px-1.5 text-xs leading-5 whitespace-nowrap text-blue-300 tabular-nums"
      >
        {note.time}
        {note.formatLabel === undefined ? null : (
          <span data-slot="sent-note-format"> {note.formatLabel}</span>
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {note.voice !== null && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Mic aria-hidden="true" className="size-[13px]" />
            {note.voice.label}
          </span>
        )}
        {note.text !== null && (
          <Bidi className={cn(OWN_WORDS, 'text-zinc-200')}>
            <NoteWords text={note.text} {...sources} />
          </Bidi>
        )}
        {note.voice?.transcript.kind === 'text' && (
          <Bidi className={cn(OWN_WORDS, 'text-zinc-200')}>{note.voice.transcript.text}</Bidi>
        )}
        {note.voice?.transcript.kind === 'pending' && (
          <span className="text-muted-foreground">{SHEET_NOTES_TEXT.transcribing}</span>
        )}
        {note.voice?.transcript.kind === 'none' && (
          <span className="text-muted-foreground">{SHEET_NOTES_TEXT.noTranscript}</span>
        )}
        {note.marks.length > 0 && (
          <span className="flex gap-1">
            {note.marks.map((mark) => (
              <Badge
                key={mark}
                variant="outline"
                className="h-[18px] rounded-[5px] border-white/[0.12] px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
              >
                {mark}
              </Badge>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/** Where a round of notes goes while it loads. */
function RoundsSkeleton() {
  return (
    <div
      data-slot="sent-notes-skeleton"
      aria-hidden="true"
      className="mt-2.5 flex flex-col gap-2 border-t border-white/[0.06] pt-3"
    >
      <Skeleton className="h-4 w-44" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-4/5" />
    </div>
  );
}

/** The rounds of notes they sent, oldest first, or the placeholders while they load. */
function SentRounds({
  rounds,
  loading,
  ...sources
}: { rounds: readonly SentRound[]; loading: boolean } & TokenSources) {
  return (
    <>
      {rounds.map((round) => (
        <div
          key={round.round}
          data-slot="sent-round"
          className="mt-2.5 flex flex-col gap-2 border-t border-white/[0.06] pt-3"
        >
          <p className="text-[13px] text-muted-foreground">{round.title}</p>
          {round.notes.map((sent) => (
            <SentNoteView key={sent.id} note={sent} {...sources} />
          ))}
        </div>
      ))}
      {loading && rounds.length === 0 && <RoundsSkeleton />}
    </>
  );
}

/**
 * The phone's part: the note for the editor in a box, if the job has one, and the rounds of notes
 * under it. Nothing at all for a job with neither, as the boards show.
 */
function PhoneNotes({ job, rounds, loading }: Pick<NotesViewProps, 'job' | 'rounds' | 'loading'>) {
  const note = noteRow(job);
  if (note.text === null && rounds.length === 0 && !loading) return null;
  return (
    <section
      aria-label={SHEET_NOTES_TEXT.heading}
      data-slot="job-sheet-notes"
      className="flex flex-col"
    >
      {note.text !== null && (
        <div
          data-slot="note-box"
          className="flex flex-col gap-1 rounded-lg border border-white/10 px-3 py-2.5"
        >
          <span className="text-xs text-muted-foreground">Note for the editor</span>
          <Bidi className={OWN_WORDS}>{note.text}</Bidi>
        </div>
      )}
      <SentRounds rounds={rounds} loading={loading} />
    </section>
  );
}

/**
 * The part itself, with everything it needs given: a function of its props, so the tests can read
 * its markup and call its handlers. `JobSheetNotes` gives it the live ones.
 */
export function NotesView({
  job,
  rounds,
  loading,
  onAskNote,
  onSetEffort,
  quickFixes = false,
  onSetReviewEffort = null,
  libraryItems,
  fonts,
  variant = 'mac',
}: NotesViewProps) {
  if (variant === 'phone') return <PhoneNotes job={job} rounds={rounds} loading={loading} />;
  const note = noteRow(job);
  // With Quick fixes on, a job in Review has the level of its review rounds, not its edit's.
  const reviewLevel = quickFixes && job.state === 'review';
  const effort = reviewLevel
    ? reviewEffortMenuEntry(job, onSetReviewEffort ?? NoOp)
    : effortMenuEntry(job, onSetEffort ?? NoOp);
  const effortLocked = !reviewLevel && !canEditEffort(job);
  const canSetEffort = reviewLevel ? onSetReviewEffort !== null : onSetEffort !== null;

  return (
    <section
      aria-label={SHEET_NOTES_TEXT.heading}
      data-slot="job-sheet-notes"
      className="flex flex-col gap-0.5"
    >
      <h3 className="mb-1.5 text-[13px] font-medium text-muted-foreground">
        {SHEET_NOTES_TEXT.heading}
      </h3>

      <div data-slot="note-row" className={ROW}>
        <span className="text-muted-foreground">{SHEET_NOTES_TEXT.forTheEditor}</span>
        <Bidi className={cn(OWN_WORDS, note.text === null && 'text-zinc-500')}>
          {note.text === null ? (
            SHEET_NOTES_TEXT.noNote
          ) : libraryItems === undefined && fonts === undefined ? (
            note.text
          ) : (
            <NoteTokenText text={note.text} items={libraryItems ?? []} fonts={fonts} />
          )}
        </Bidi>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!note.canChange}
          className={ROW_BUTTON}
          onClick={onAskNote}
        >
          {note.action}
        </Button>
      </div>

      <div data-slot="effort-row" className={ROW}>
        <span className="text-muted-foreground">{SHEET_NOTES_TEXT.effort}</span>
        {reviewLevel ? (
          <span data-slot="review-effort" className="inline-flex items-baseline gap-1.5">
            {job.reviewEffort === null && (
              <Sparkles aria-hidden="true" className="size-3.5 self-center" />
            )}
            {job.reviewEffort === null ? REVIEW_EFFORT_WORDS.auto : effortLabel(job.reviewEffort)}
          </span>
        ) : (
          <span>{effortValue(job.effort)}</span>
        )}
        {effortLocked ? (
          <span className="pr-2 text-xs text-zinc-500">{SHEET_NOTES_TEXT.usedForThisRun}</span>
        ) : (
          canSetEffort && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="xs" className={ROW_BUTTON}>
                  {SHEET_NOTES_TEXT.change}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-62">
                <DropdownMenuRadioGroup value={effort.value} onValueChange={effort.onValueChange}>
                  {effort.options.map((option) => (
                    <Fragment key={option.id}>
                      <DropdownMenuRadioItem value={option.id}>
                        <span>{option.label}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{option.hint}</span>
                      </DropdownMenuRadioItem>
                      {option.separatorAfter === true && <DropdownMenuSeparator />}
                    </Fragment>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        )}
      </div>

      <SentRounds rounds={rounds} loading={loading} libraryItems={libraryItems} fonts={fonts} />
    </section>
  );
}

/**
 * What `JobSheetNotes` shows and does, from the job: the review notes they sent (the sent-notes
 * query, `['sent-notes', id]`, asked only once a round was sent; a failed or slow load leaves the
 * rounds out, the skeleton waits 250 ms),
 * "Add" / "Edit" (the note dialog, which holds an arriving or queued job while they write) and
 * "Change" (the sheet's `RowActionsContext`, the row's own way to save the effort).
 *
 * `timeZone` and `now` are for the tests (default: this machine's zone and clock), like the other
 * time formatters; a round sent on an earlier day says the day, not the time.
 */
export function useJobSheetNotes(job: Job, timeZone?: string, now?: TimeInput): NotesViewProps {
  const actions = useRowActionsContext();
  const clock = useNow();
  // A job that has sent no round has no sent notes: nothing is asked of the engine for it.
  const query = useSentNotes(job.id, { enabled: job.round > 0 });
  const quickFixes = useQuickFixesEnabled();
  const showSkeleton = useDelayedFlag(query.isLoading, SKELETON_DELAY_MS);
  return {
    job,
    rounds: sentRounds(query.data?.notes, now ?? clock, timeZone, formatsOf(job)),
    loading: showSkeleton,
    onAskNote: () => askForNote(job),
    onSetEffort: actions === null ? null : actions.setEffort,
    quickFixes,
    onSetReviewEffort: actions === null ? null : actions.setReviewEffort,
  };
}

/**
 * The sheet's "Notes" part: The owner's note for the editor (Add, Edit), the effort level (Change,
 * until the edit starts) and the review notes they sent, round by round: time in the video, the voice
 * transcript, the Style and Series marks. Design: canvas page "Job sheet", board JSSheet (Notes)
 * and JSStatesB (Ready to review · round 2).
 */
export function JobSheetNotes({
  job,
  timeZone,
  now,
  variant,
}: {
  job: Job;
  timeZone?: string;
  now?: TimeInput;
  variant?: SheetVariant;
}) {
  const view = useJobSheetNotes(job, timeZone, now);
  // The phone has no picker and no chips (and asks the library for nothing).
  const library = useLibraryItems(variant !== 'phone');
  // Fonts in the notes (`fontsInNotes`): the font list is asked only then, and not for the phone.
  const fonts = useFontPickerCatalog(variant !== 'phone');
  return (
    <NotesView
      {...view}
      libraryItems={library.enabled ? library.items : undefined}
      fonts={fonts.enabled ? fonts.catalog : undefined}
      variant={variant}
    />
  );
}
