import type { Job, JobPreview, ReviewNote } from '@studio/shared';
import { X } from 'lucide-react';
import { type ComponentProps, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { type StoreApi, useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  previewPosterUrl,
  previewUrl,
  useAddNote,
  useAddVoiceNote,
  useDraftChatEnabled,
  useJobAction,
  useJobFeed,
  useNotes,
} from '@/data';
import { JobChat } from '@/features/job-chat/JobChat';
import { JOB_CHAT_TEXT } from '@/features/job-chat/job-chat-text';
import { ShareIconButton } from '@/features/phone/PhoneShareVideo';
import { shareTargetFor } from '@/features/phone/share-video';
import { useShareVideo } from '@/features/phone/use-share-video';
import { useReviewFix } from '@/features/review/fix/use-review-fix';
import { FormatSwitch } from '@/features/review/formats/FormatSwitch';
import { formatsRenderText, markerNotes, noteFormat } from '@/features/review/formats/format-logic';
import { useNoteMarks } from '@/features/review/formats/use-note-marks';
import { useReviewFormat } from '@/features/review/formats/use-review-format';
import { musicFooter } from '@/features/review/music/music-text';
import { PhoneMusicSheet } from '@/features/review/music/PhoneMusicSheet';
import { SwapPlayer } from '@/features/review/music/SwapPlayer';
import { useReviewMusic } from '@/features/review/music/use-review-music';
import { NoteDots } from '@/features/review/NoteDots';
import { NotesList } from '@/features/review/NotesList';
import {
  isNoteActive,
  sendBlockedByRecording,
  sendBlockedByTranscripts,
} from '@/features/review/notes-logic';
import type { PlayerReadyInfo, PreviewPlayerHandle } from '@/features/review/PreviewPlayer';
import { formatPlayhead } from '@/features/review/player-state';
import { type ReviewDialogState, reviewDialogStore } from '@/features/review/review-dialog';
import { submitReview } from '@/features/review/review-submit';
import { REVIEW_DIALOG_TEXT } from '@/features/review/review-text';
import { useEpisodeSeriesName } from '@/features/review/use-episode-series';
import { useReviewEffort } from '@/features/review/use-review-effort';
import { useReviewFixes } from '@/features/review/use-review-fixes';
import { useReviewTimer } from '@/features/review/use-review-timer';
import { useViewportSize } from '@/features/review/use-viewport-size';
import { useVoiceRecorder } from '@/features/review/use-voice-recorder';
import { stopVoicePlayback } from '@/features/review/voice-playback';
import { useSeriesText } from '@/features/series/SeriesMark';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { PhoneComposer } from './PhoneComposer';
import { PhoneEffortSheet } from './PhoneEffortSheet';
import { PhonePlayerControls } from './PhonePlayerControls';
import { PhoneRecordingBar } from './PhoneRecordingBar';
import { PhoneReviewFooter } from './PhoneReviewFooter';
import {
  CONTROLS_ROW_HEIGHT,
  type PhoneDone,
  phoneFooter,
  phoneReviewMode,
  phoneStageLayout,
  pinTime,
  TIMELINE_HEIGHT,
} from './phone-review';
import { useKeyboardFrame } from './use-keyboard-frame';
import { phonePreviewSrc, usePreviewVideo } from './use-preview-video';
import { useRecordingWhenHidden } from './use-recording-when-hidden';

/** Used when a review job has no preview (it always should): a 9:16 frame and no length. */
const FALLBACK_PREVIEW: JobPreview = { durationSec: 0, width: 1080, height: 1920 };

/** The header (48 px) and the footer's one button row (60 px): what a first guess at the stage leaves out. */
const HEADER_HEIGHT = 48;
const FOOTER_HEIGHT = 60;

interface PhoneReviewProps {
  /** The job shown: the live one, or the last one while the review fades out. */
  job: Job;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  /**
   * Where the composition loads from. Default `previewUrl(job.id, <the round it opened on>,
   * music?.rev)`: the music's `rev` is in it, so the player loads the cut again, at the same time
   * and playing if it was, when the music changes.
   */
  src?: string;
  /** The store the submission lives in. Default: the app's; tests pass their own. */
  store?: StoreApi<ReviewDialogState>;
  /** What was sent; `null` until then. Its footer is the done line and Close. */
  done: PhoneDone | null;
  /** Send went through: the host keeps the review open and remembers what happened. */
  onSubmitted: (done: PhoneDone) => void;
}

/**
 * Review on the phone (boards MReview, MReviewNotes, MReviewWrite, MReviewRec, MReviewEffort,
 * MReviewDone): the Mac's review dialog laid out for a narrow screen. It is a full-screen dialog, so it stacks over the job sheet
 * it may be opened from, and the page behind it does not scroll. Top to bottom:
 *
 * - the header (48 px): the job, "client · Live preview" (an episode: "client · Episode 3 of <series> ·
 *   Live preview"), Close;
 * - the player: the 9:16 live preview fills the stage and nothing is ever drawn over it. Under
 *   it a 32 px timeline (time · track with the notes' blue dots · length) and a 52 px row: Play,
 *   then Notes N, Record and Write. A tap on a dot opens the notes at that note;
 * - the notes, when the Notes button is on: the list slides up and the video shrinks to 260 px
 *   above it. The cards are the Mac's (`NoteCard`) with 32 px buttons;
 * - the footer, one action at a time: Effort ▾ and Send N notes with notes (Effort opens a bottom
 *   sheet), and after Send the done line with Close. With no notes it is only a line saying where
 *   Approve is: the row's sheet, by press and hold (the owner, 31 Oct: never inside the job).
 * - Write pauses the video, opens the notes, and puts the note box ("New note at 0:27", Cancel,
 *   Comment) in the footer's place with the keyboard up; the video is 200 px above the list. iPhone
 *   Safari lays the page out as if the keyboard weren't there, so while it is up the review is
 *   pinned to what `visualViewport` says is visible: the note box sits on top of the keyboard, and
 *   the header, the row of buttons and the list step aside so the paused frame keeps its 200 px
 *   or more.
 * - Record pauses the video, pins the note at the playhead (a red pin on the timeline) and puts the
 *   red "Recording 0:07 · pinned at 0:21" bar with Cancel and Stop and add in the footer's place.
 *   iPhone Safari asks for the microphone on that first tap (a refusal is said in one line) and
 *   records audio/mp4, which the engine takes. Stop and add opens the notes, where the voice note
 *   says "Transcribing…" until the engine's transcript arrives. When the screen locks or another
 *   app comes up, a recording stops and is added the same way. Closing the review drops it.
 * - The video can't start while a note is written or recorded: the frame stays where it goes.
 *
 * Everything it decides is the Mac's: the notes and their rules (`notes-logic`), the player, the
 * footer (`reviewFooter`, or with Quick fixes on `fixFooter` through `useReviewFixes`: the lines under
 * the notes and the footer's words are the Mac's too), the recorder (`useVoiceRecorder`), the submit
 * (`submitReview`) and the Effort choices.
 *
 * Must sit inside a `TooltipProvider` (the notes' cards). The host keys it by the store's session.
 */
export function PhoneReview({
  job,
  open,
  onOpenChange,
  onCloseAutoFocus,
  src: srcProp,
  store = reviewDialogStore,
  done,
  onSubmitted,
}: PhoneReviewProps) {
  const preview = job.preview ?? FALLBACK_PREVIEW;
  // A job with two formats (Generated videos): a switch over the player picks the format it loads
  // and the new notes are written on. null for any other job, which is exactly as before.
  const reviewFormat = useReviewFormat(job);
  const onMainFormat = reviewFormat === null || reviewFormat.stamp === null;
  /** The size of the composition on show: the main preview's, or the extra format's own. */
  const shownSize =
    reviewFormat === null || reviewFormat.stamp === null ? preview : reviewFormat.shown;
  // The round is fixed for this opening (the host keys the review by it): once Send goes through
  // the job's round moves on, and the player under the done line must keep the cut that was
  // reviewed. The music's `rev` is not fixed: when it changes the player loads the cut again with
  // the new soundtrack (SwapPlayer), until Send or Approve has gone through.
  const [round] = useState(() => job.round);
  // The first frame as a still until Play: an iPhone loads no video before a tap (a sample has none).
  const [poster] = useState(() =>
    srcProp === undefined ? previewPosterUrl(job.id, round) : undefined,
  );
  const { width: viewportWidth, height: viewportHeight } = useViewportSize();

  const contentRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PreviewPlayerHandle>(null);

  // ---- Notes: the list, the dots and the footer. ----

  const notesQuery = useNotes(job.id, { enabled: job.state === 'review' });
  // Draft & chat (when on): the notes panel is the job's chat, the notes that wait at its end.
  const chat = useDraftChatEnabled();
  const chatFeed = useJobFeed(job.id, { enabled: chat && open });
  const seriesName = useEpisodeSeriesName(job);
  const seriesText = useSeriesText(job);
  const submitting = useStore(store, (state) => state.submitting);
  const submitError = useStore(store, (state) => state.submitError);
  // While a Send is on its way, once it went through and while the review fades out, the notes stay
  // as they were: the server takes the sent notes out of the list, and the list must not flash
  // "No notes yet" (nor the footer "Approve") on the way.
  const frozen = !open || submitting !== null || done !== null;
  const frozenNotes = useRef(notesQuery.data);
  if (!frozen) frozenNotes.current = notesQuery.data;
  const notes = frozen ? frozenNotes.current : notesQuery.data;
  const reviewMusic = useReviewMusic(job.id, frozen);
  // Quick fixes (when on): the line under each note, the notes that wait for Send, the footer's
  // words and Undo. Holds still with the notes once Send or Approve is on its way.
  const quick = useReviewFixes(job, notes, frozen);
  // The job's quick fixes: their `rev` is in the player's address (and the MP4 is asked for again
  // when it changes), and when a fix lands the player goes to its note's moment and stops there.
  const reviewFix = useReviewFix({ job, notes, hold: frozen });
  // The phone plays the small MP4 the engine renders of the preview (the live composition lags
  // here). A sample (`src` given) stays live; a failed render falls back to the live preview. A new
  // music `rev` asks for the MP4 again: while the engine renders it with the new music.mp3 the live
  // preview plays (so what's picked is what's heard), then the player swaps to the new MP4.
  const video = usePreviewVideo(
    job.id,
    srcProp === undefined && open,
    reviewMusic.rev,
    reviewFix.rev,
  );
  // The small MP4 is the main format's only: an extra format plays its live composition.
  const asVideo = srcProp === undefined && video.state === 'ready' && onMainFormat;
  const waitingForVideo = srcProp === undefined && video.state === 'making' && onMainFormat;
  // The header's icon shares the preview MP4 (U16) once the engine has made it: it is small, so it
  // is fetched as soon as it is ready and the tap only opens the share sheet.
  const previewShare = useShareVideo(
    asVideo
      ? shareTargetFor(job, 'preview', {
          round,
          musicRev: video.readyRev,
          fixRev: video.readyFixRev,
        })
      : null,
    { eager: true, asks: false },
  );
  const src = onMainFormat
    ? phonePreviewSrc({
        jobId: job.id,
        round,
        src: srcProp,
        musicRev: reviewMusic.rev,
        fixRev: reviewFix.rev,
        video,
      })
    : (srcProp ??
      previewUrl(job.id, round, reviewMusic.rev, '', null, reviewFix.rev, reviewFormat?.previewId));
  // Each note's format stamp and hint line, and which notes the shown format's timeline marks.
  const noteMarks = useNoteMarks(job, notes, reviewFormat?.formats, 'phone');
  const dotNotes = markerNotes(notes, reviewFormat?.formats, reviewFormat?.shown, noteMarks.scopes);

  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [readyDurationSec, setReadyDurationSec] = useState<number | null>(null);
  const durationSec = readyDurationSec ?? preview.durationSec;
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  /** The note cards, by note id, for `scrollIntoView`. */
  const noteCards = useRef(new Map<string, HTMLElement>());
  const sendNotes = useJobAction('send_notes');
  // The Effort sheet: the edit's level, or with Quick fixes on the review rounds' (Auto by default).
  const { value: effort, auto: quickFixes, onChange: changeEffort } = useReviewEffort(job);
  const addNote = useAddNote(job.id);
  /** Write: the note box is open, with what is typed in it (Cancel drops it, as does closing). */
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const keyboard = useKeyboardFrame(composerOpen);
  const addVoice = useAddVoiceNote(job.id);
  // A voice note is written on the format that was on show when Record was pressed.
  const recordFormat = useRef<string | null>(null);
  const { recorder, snapshot: rec } = useVoiceRecorder((upload) =>
    addVoice.mutateAsync(
      recordFormat.current === null ? upload : { ...upload, format: recordFormat.current },
    ),
  );
  /** A voice note is being started or recorded. */
  const recording = rec.phase === 'starting' || rec.phase === 'recording';
  /** Where the red pin sits on the timeline: from Record until the note is added (not after a failed upload). */
  const recordingAtSec = recording || rec.phase === 'saving' ? rec.pinnedSec : null;
  // The time spent here is counted for the Money page, as on the Mac (nothing about it is shown).
  // Playing the video and recording a voice note both count as being there.
  const reviewTimer = useReviewTimer({
    jobId: job.id,
    open,
    playing,
    recording,
    contentRef,
  });

  const isActive = (note: ReviewNote) =>
    isNoteActive(note, { selectedId: selectedNoteId, playing, currentSec });

  // A time chip or a dot: go there, stop, and mark the note. A note written on the other format
  // takes the player to that format too.
  const selectFormat = reviewFormat?.select;
  const noteFormats = reviewFormat?.formats;
  const goToNote = useCallback(
    (note: ReviewNote) => {
      if (selectFormat !== undefined && noteFormats !== undefined) {
        selectFormat(noteFormat(note, noteFormats));
      }
      playerRef.current?.seek(note.atSec);
      playerRef.current?.pause();
      setSelectedNoteId(note.id);
    },
    [selectFormat, noteFormats],
  );

  // A dot also opens the notes, at its note.
  const openNoteAt = useCallback(
    (note: ReviewNote) => {
      goToNote(note);
      setNotesOpen(true);
    },
    [goToNote],
  );

  // The card of the marked note comes into view when the list is open.
  useEffect(() => {
    if (!notesOpen || selectedNoteId === null) return;
    noteCards.current.get(selectedNoteId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [notesOpen, selectedNoteId]);

  const cardRef = useCallback((id: string, element: HTMLElement | null) => {
    if (element === null) noteCards.current.delete(id);
    else noteCards.current.set(id, element);
  }, []);

  // A deleted note is no longer selected.
  const forgetNote = useCallback((id: string) => {
    setSelectedNoteId((current) => (current === id ? null : current));
  }, []);

  // A voice note starts playing: the video stops (the other way round is in onPlayingChange).
  const pauseForVoice = useCallback(() => playerRef.current?.pause(), []);

  // A closed review stays mounted while it fades out: closing drops a recording (the microphone
  // goes off) and stops a playing voice note.
  useEffect(() => {
    if (!open) {
      recorder.release();
      stopVoicePlayback();
    }
  }, [open, recorder]);
  useEffect(() => () => stopVoicePlayback(), []);

  // ---- Write and Record. ----

  /** Where a note made now goes: the playhead, within the video. */
  const playheadPin = () => pinTime(playerRef.current?.getCurrentTime() ?? currentSec, durationSec);

  // Write: the video pauses, the notes open, and the note box gets the focus. iPhone Safari brings
  // up the keyboard only for a focus inside the tap, so the box is drawn now and focused at once.
  function startWrite() {
    playerRef.current?.pause();
    stopVoicePlayback();
    recorder.clearError();
    flushSync(() => {
      setComposerOpen(true);
      setNotesOpen(true);
    });
    composerRef.current?.focus();
  }

  function cancelWrite() {
    setComposerOpen(false);
    setDraft('');
    addNote.reset();
  }

  function addTypedNote() {
    const text = draft.trim();
    if (text === '' || addNote.isPending) return;
    addNote.mutate(
      {
        atSec: playheadPin(),
        text,
        ...(reviewFormat === null ? {} : { format: reviewFormat.stamp }),
      },
      {
        onSuccess: () => {
          setDraft('');
          setComposerOpen(false);
        },
      },
    );
  }

  // Record: the video pauses, a playing voice note stops, and the note is pinned at the playhead.
  // The microphone is asked for now, inside the tap (never before), so iPhone Safari's prompt comes
  // from it.
  function startRecording() {
    playerRef.current?.pause();
    stopVoicePlayback();
    recorder.clearError();
    setComposerOpen(false);
    recordFormat.current = reviewFormat?.stamp ?? null;
    void recorder.start(playheadPin());
  }

  // Stop and add (also when the page is hidden): the recording uploads, and the notes open, where
  // the voice note waits for its transcript.
  const stopRecording = useCallback(() => {
    recorder.stop();
    setNotesOpen(true);
  }, [recorder]);
  useRecordingWhenHidden(recorder, stopRecording);

  // ---- The footer. ----

  const footer = phoneFooter({
    footer: musicFooter(
      quick.footer({
        notes,
        writing: composerOpen || addNote.isPending || rec.phase !== 'idle',
        submitting,
        sendDisabledReason: sendBlockedByRecording(rec) ?? sendBlockedByTranscripts(notes),
      }),
      reviewMusic.music,
    ),
    effort,
    auto: quickFixes,
    done,
  });

  // Send is the footer's one action: Approve is in the row's sheet only (press and hold the row).
  function send() {
    playerRef.current?.pause();
    // Once the job leaves Review the engine takes no more of its time: send what is counted first.
    reviewTimer.flush();
    // Taken now: a successful Send empties the notes cache. They are the notes "Send N notes"
    // counts: with Quick fixes on, those that wait (the fixed ones are already done).
    const sending = quick.waiting;
    const counts = {
      notes: sending?.length ?? 0,
      styled: sending?.filter((note) => note.addToStyle).length ?? 0,
    };
    void submitReview('send_notes', job.id, counts, {
      store,
      run: (jobId) => sendNotes.mutateAsync(jobId),
      stayOpen: true,
      onSubmitted: () => onSubmitted({ action: 'send_notes', ...counts, effort, auto: quickFixes }),
    });
  }

  function handlePlayerReady(info: PlayerReadyInfo) {
    setReadyDurationSec(info.durationSec);
  }

  // Once Send or Approve went through the notes list closes and the video takes the room (board
  // MReviewDone); it also steps aside while the keyboard is up.
  const finished = done !== null;
  const mode = phoneReviewMode({
    writing: composerOpen,
    recorderPhase: rec.phase,
    finished,
    keyboardOpen: keyboard.keyboardOpen,
  });
  const notesShown = notesOpen && mode.showNotes;
  const layout = phoneStageLayout({
    notesOpen: notesShown,
    writing: mode.bottom === 'write',
    keyboardOpen: keyboard.keyboardOpen,
  });
  /** Why the microphone could not start (refused, missing), in one line, until the next Write or Record. */
  const micError = rec.phase === 'idle' && mode.bottom === 'footer' && !finished ? rec.error : null;
  const guessedStageHeight = Math.max(
    160,
    viewportHeight - HEADER_HEIGHT - TIMELINE_HEIGHT - CONTROLS_ROW_HEIGHT - FOOTER_HEIGHT,
  );

  // The player's place while its chunk loads, and while the music's first answer is on its way (the
  // player waits for it, so it loads once, with the music's `rev`).
  const playerPlaceholder = (
    <div
      data-slot="preview-player-placeholder"
      aria-hidden="true"
      className={cn('flex flex-col bg-black', layout.column)}
    >
      <div className={cn('bg-black', layout.stage)} />
      <div className="h-[84px] shrink-0 bg-background" />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        data-slot="phone-review"
        data-notes={notesShown ? 'open' : 'shut'}
        data-bottom={mode.bottom}
        data-keyboard={keyboard.keyboardOpen ? 'up' : 'down'}
        tabIndex={-1}
        showCloseButton={false}
        className="inset-0 z-50 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 pt-safe pr-safe pl-safe shadow-none transition-none [-webkit-tap-highlight-color:transparent] data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none"
        // While the keyboard is up the review is the part of the page it leaves visible. It moves
        // at once (transition-none above): easing after Safari's own scroll would trail it.
        style={
          keyboard.box === null
            ? undefined
            : { top: keyboard.box.top, height: keyboard.box.height, bottom: 'auto' }
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <header
          data-slot="phone-review-header"
          className={cn(
            'flex h-12 shrink-0 items-center gap-2 border-b border-white/10 pr-1 pl-4',
            !mode.showHeader && 'hidden',
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate text-[15px] leading-5 font-semibold">
              <Bidi>{job.name}</Bidi>
            </DialogTitle>
            <span className="flex items-center gap-1.5 text-xs leading-4 whitespace-nowrap text-muted-foreground">
              <Bidi className="min-w-0 truncate">{job.client}</Bidi>
              {seriesText !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    data-slot="phone-review-series"
                    dir="auto"
                    className="[unicode-bidi:plaintext]"
                  >
                    {seriesText.lead}
                    {seriesText.name !== null && <bdi>{seriesText.name}</bdi>}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span
                aria-hidden="true"
                className="size-1.5 flex-none rounded-full bg-status-ready"
              />
              {asVideo ? REVIEW_DIALOG_TEXT.videoPreview : REVIEW_DIALOG_TEXT.livePreview}
            </span>
          </div>
          {previewShare.target !== null && (
            <ShareIconButton
              flow={previewShare.flow}
              target={previewShare.target}
              onShare={previewShare.share}
            />
          )}
          <PhoneMusicSheet jobId={job.id} />
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={REVIEW_DIALOG_TEXT.close}
              className="size-11 flex-none text-muted-foreground dark:hover:bg-accent"
            >
              <X aria-hidden="true" className="size-5" />
            </Button>
          </DialogClose>
        </header>
        <DialogDescription className="sr-only">{REVIEW_DIALOG_TEXT.description}</DialogDescription>

        {reviewFormat !== null && mode.showHeader && done === null ? (
          <div
            data-slot="phone-review-format"
            className="flex shrink-0 justify-center bg-black pt-2.5 pb-1"
          >
            <FormatSwitch
              variant="phone"
              formats={reviewFormat.formats}
              value={reviewFormat.shown}
              onChange={reviewFormat.select}
            />
          </div>
        ) : null}

        {waitingForVideo ? (
          <div
            data-slot="preview-video-making"
            role="status"
            className={cn('flex flex-col bg-black', layout.column)}
          >
            <div
              className={cn(
                'flex items-center justify-center px-8 text-center text-sm text-muted-foreground',
                layout.stage,
              )}
            >
              {REVIEW_DIALOG_TEXT.makingPreviewVideo}
            </div>
            <div className="h-[84px] shrink-0 bg-background" />
          </div>
        ) : (
          <Suspense fallback={playerPlaceholder}>
            {reviewMusic.settling ? (
              playerPlaceholder
            ) : (
              <SwapPlayer
                ref={playerRef}
                src={src}
                videoWidth={shownSize.width}
                videoHeight={shownSize.height}
                durationSec={preview.durationSec > 0 ? preview.durationSec : undefined}
                maxWidth={viewportWidth}
                maxHeight={guessedStageHeight}
                fitToStage
                poster={onMainFormat ? poster : undefined}
                asVideo={asVideo}
                fixPill={reviewFix.pill}
                landOn={reviewFix.landOn}
                playLocked={mode.playLocked}
                className={layout.column}
                stageClassName={layout.stage}
                onReady={handlePlayerReady}
                onTimeUpdate={setCurrentSec}
                onPlayingChange={(next) => {
                  setPlaying(next);
                  if (next) {
                    setSelectedNoteId(null);
                    stopVoicePlayback();
                  }
                }}
                timelineOverlay={
                  dotNotes.length > 0 || recordingAtSec !== null ? (
                    <NoteDots
                      variant="phone"
                      notes={dotNotes}
                      durationSec={durationSec}
                      hoveredId={null}
                      isActive={isActive}
                      onHover={() => {}}
                      onSelect={openNoteAt}
                      recordingAtSec={recordingAtSec}
                    />
                  ) : undefined
                }
                renderControls={(controls) => (
                  <PhonePlayerControls
                    controls={controls}
                    noteCount={notes?.length ?? 0}
                    notesOpen={notesShown}
                    showButtons={mode.showButtons}
                    writing={composerOpen}
                    playLocked={mode.playLocked}
                    onToggleNotes={() => setNotesOpen((current) => !current)}
                    onRecord={startRecording}
                    onWrite={startWrite}
                  />
                )}
              />
            )}
          </Suspense>
        )}

        {notesShown && (
          <div
            data-slot="phone-review-notes"
            className="flex min-h-0 flex-1 flex-col border-t border-white/10 duration-200 ease-in-out animate-in fade-in-0 slide-in-from-bottom-6"
          >
            {chat ? (
              <JobChat
                jobId={job.id}
                items={chatFeed.data?.items ?? []}
                className="p-3"
                after={
                  notes !== undefined && notes.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <span className="self-end text-xs text-zinc-500">
                        {JOB_CHAT_TEXT.notSent}
                      </span>
                      <NotesList
                        variant="phone"
                        embedded
                        jobId={job.id}
                        client={job.client}
                        seriesName={seriesName}
                        notes={notes}
                        loading={notesQuery.isPending && notesQuery.fetchStatus === 'fetching'}
                        failed={notesQuery.isError && notes === undefined}
                        onRetry={() => void notesQuery.refetch()}
                        hoveredId={null}
                        isActive={isActive}
                        onHover={() => {}}
                        onGo={goToNote}
                        onDeleted={forgetNote}
                        cardRef={cardRef}
                        onPlayVoice={pauseForVoice}
                        fixLines={quick.lines}
                        onUndo={quick.undo}
                        undoing={quick.undoing}
                        marks={noteMarks.marks}
                      />
                    </div>
                  ) : undefined
                }
              />
            ) : (
              <NotesList
                variant="phone"
                jobId={job.id}
                client={job.client}
                seriesName={seriesName}
                notes={notes}
                loading={notesQuery.isPending && notesQuery.fetchStatus === 'fetching'}
                failed={notesQuery.isError && notes === undefined}
                onRetry={() => void notesQuery.refetch()}
                hoveredId={null}
                isActive={isActive}
                onHover={() => {}}
                onGo={goToNote}
                onDeleted={forgetNote}
                cardRef={cardRef}
                onPlayVoice={pauseForVoice}
                fixLines={quick.lines}
                onUndo={quick.undo}
                undoing={quick.undoing}
                marks={noteMarks.marks}
              />
            )}
          </div>
        )}

        {micError !== null && (
          <p
            role="alert"
            data-slot="phone-review-mic-error"
            className="shrink-0 border-t border-white/10 px-4 pt-2.5 text-sm text-destructive"
          >
            {micError}
          </p>
        )}

        {mode.bottom === 'write' ? (
          <PhoneComposer
            timeLabel={formatPlayhead(currentSec, durationSec)}
            draft={draft}
            onDraftChange={(text) => {
              setDraft(text);
              if (addNote.error) addNote.reset();
            }}
            onAdd={addTypedNote}
            onCancel={cancelWrite}
            onFocus={() => playerRef.current?.pause()}
            adding={addNote.isPending}
            error={addNote.error?.message ?? null}
            composerRef={composerRef}
            keyboardOpen={keyboard.keyboardOpen}
            formatLabel={reviewFormat?.shown.label}
          />
        ) : mode.bottom === 'record' ? (
          <PhoneRecordingBar
            snapshot={rec}
            onCancel={recorder.cancel}
            onStop={stopRecording}
            onRetry={() => void recorder.retry()}
            onDiscard={recorder.discard}
          />
        ) : (
          <PhoneReviewFooter
            view={footer}
            effort={effort}
            auto={quickFixes}
            error={submitError}
            // The footer's line says why the music makes Approve wait; this one, what it renders.
            hint={
              footer.kind === 'approve' && reviewFormat !== null
                ? `Approve renders ${formatsRenderText(reviewFormat.formats)}.`
                : null
            }
            ruled={notesShown && micError === null}
            onSend={send}
            onOpenEffort={() => {
              playerRef.current?.pause();
              setEffortOpen(true);
            }}
            onClose={() => onOpenChange(false)}
          />
        )}

        <PhoneEffortSheet
          open={effortOpen}
          onOpenChange={setEffortOpen}
          effort={effort}
          onChange={changeEffort}
          auto={quickFixes}
        />
      </DialogContent>
    </Dialog>
  );
}
