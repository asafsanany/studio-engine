import type { Job, JobPreview, ReviewNote } from '@studio/shared';
import { type ComponentProps, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type StoreApi, useStore } from 'zustand';
import { Dialog, DialogContent, DialogDescription } from '@/components/ui/dialog';
import {
  previewUrl,
  useAddNote,
  useAddVoiceNote,
  useDraftChatEnabled,
  useJobAction,
  useNotes,
} from '@/data';
import { ChatStage } from '@/features/job-chat/ChatStage';
import { JobChatPanel } from '@/features/job-chat/JobChatPanel';
import {
  isRunning,
  runningLabel,
  stageWaiting,
  waitingFooter,
} from '@/features/job-chat/job-chat-logic';
import { JOB_CHAT_TEXT } from '@/features/job-chat/job-chat-text';
import { useRunningCut } from '@/features/job-chat/use-running-cut';
import { CHAT_PANEL_WIDTH, reviewDialogLayout, reviewDialogLayoutOfFormats } from './dialog-layout';
import { CONTROLS_HEIGHT } from './fit-player';
import { useReviewFix } from './fix/use-review-fix';
import { FormatSwitch } from './formats/FormatSwitch';
import { formatsFooter, markerNotes, noteFormat } from './formats/format-logic';
import { useNoteMarks } from './formats/use-note-marks';
import { useReviewFormat } from './formats/use-review-format';
import { MusicNowPlaying } from './music/MusicNowPlaying';
import { musicFooter } from './music/music-text';
import { SwapPlayer } from './music/SwapPlayer';
import { useReviewMusic } from './music/use-review-music';
import { NoteDots } from './NoteDots';
import { NotesList } from './NotesList';
import { isNoteActive, sendBlockedByRecording, sendBlockedByTranscripts } from './notes-logic';
import type { PlayerReadyInfo, PreviewPlayerHandle } from './PreviewPlayer';
import { isTypingTarget, usePlayerShortcuts } from './player-shortcuts';
import { clampTime, formatPlayhead } from './player-state';
import { RecordingBox } from './RecordingBox';
import { ReviewComposer } from './ReviewComposer';
import { ReviewDialogHeader } from './ReviewDialogHeader';
import { ReviewFooter } from './ReviewFooter';
import { ReviewFooterActions } from './ReviewFooterActions';
import { ReviewNotesPanel } from './ReviewNotesPanel';
import { type ReviewDialogState, reviewDialogStore, reviewDraftOf } from './review-dialog';
import {
  escapeIsForFullscreen,
  escapeIsForPicker,
  reviewEscapeStep,
  reviewShortcutFor,
} from './review-keys';
import { submitReview } from './review-submit';
import { REVIEW_DIALOG_TEXT } from './review-text';
import { useEpisodeSeriesName } from './use-episode-series';
import { useFontPreview } from './use-font-preview';
import { usePausedLook } from './use-paused-look';
import { useReviewEffort } from './use-review-effort';
import { useReviewFixes } from './use-review-fixes';
import { useReviewTimer } from './use-review-timer';
import { useViewportSize } from './use-viewport-size';
import { useVoiceRecorder } from './use-voice-recorder';
import { stopVoicePlayback } from './voice-playback';

/** Used when a review job has no preview (it always should): a 9:16 frame and no length. */
const FALLBACK_PREVIEW: JobPreview = { durationSec: 0, width: 1080, height: 1920 };

interface ReviewDialogProps {
  /** The job shown: the live one, or the last one while the dialog fades out. */
  job: Job;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  /**
   * Where the composition loads from. Default `previewUrl(job.id, job.round, music?.rev, '', null,
   * fixes.rev)`: the music's `rev` is in it, so the player loads the cut again, at the same time and
   * playing if it was, when the music changes; the quick fixes' `rev` is in it too, and when a fix
   * lands the player goes to its note's moment and stops there. The dev gallery passes the sample.
   */
  src?: string;
  /** The store the drafts and submissions live in. Default: the app's; tests and the gallery pass their own. */
  store?: StoreApi<ReviewDialogState>;
}

/**
 * The review dialog (board P3Review): a job's live preview in the player on the left, exactly as
 * wide as the video; the 360 px notes panel on the right; a 60 px header and a 64 px footer. The
 * dialog is the largest that fits the window (see `reviewDialogLayout`).
 *
 * - Notes: the panel lists the job's unsent notes by time, and the composer under it adds a note at
 *   the playhead. Each note is a blue dot on the player's timeline; hovering a dot lights up its
 *   card, hovering a card grows its dot, and clicking either seeks there and pauses.
 * - The footer offers one action: "Send N notes" with notes. With none it is only a line that says
 *   where Approve is: the row's right-click menu, never inside the job (the owner, 31 Oct). Send keeps
 *   the dialog open while it runs, then closes it with a toast; a refusal shows its reason in the
 *   footer.
 * - Quick fixes (when on, `useReviewFixes`): each note has a line under it that answers it ("Reading
 *   the note…", "Fixing it now · …", "Fixed in 38 s. …" with Undo, "Goes with Send · …"), and the
 *   footer says what will happen: a note being read or a fix under way holds Send and the Effort
 *   button; only fixed notes leave the line that says to approve; notes that wait say Auto's plan.
 *   Off: none of it.
 *
 * - Voice notes: Record (or R) pauses the video, leaves full screen, stops any voice note that is
 *   playing and pins the note at the playhead; the composer becomes the red recording box until
 *   Stop and add (or R) uploads it, or Cancel (or Esc) drops it. Closing the dialog drops a
 *   recording and lets the microphone go. A voice note's card plays it back; only one plays at a
 *   time, playing one pauses the video, and playing the video stops it. Send waits while a note is
 *   still being transcribed, and while one is being recorded or added (it would close the dialog
 *   and throw the recording away); Approve waits while one is being recorded or added.
 * - Keyboard: once the player is ready its shortcuts work while anything in the dialog has focus
 *   (before that, Space presses the focused button, such as Try again); C focuses the composer.
 *   Esc leaves the note box, then cancels a recording, then (left to the browser) exits full
 *   screen, then closes the dialog.
 * - Focus starts on the dialog itself, so no tooltip pops open on the first button and the
 *   shortcuts work right away.
 * - The player loads lazily; a same-size placeholder holds its place meanwhile.
 * - The time the dialog is open, with the tab visible and the owner there (playing the video or recording
 *   a voice note counts), is counted for the Money page (`useReviewTimer`), and sent every 15 s, on
 *   close and just before Send notes or Approve.
 *
 * - Draft & chat (when on): the notes column is the job's chat (440 px, `JobChatPanel`) with the
 *   notes that wait for Send at its end and the composer under it, and the dialog stays open while
 *   the job waits in line or runs. Then there is nothing to send yet: the player plays the cut the
 *   run changes (its saved version, `useRunningCut`; before cut 1 the player's place says so,
 *   `ChatStage`), the header says what runs, the note box waits and the footer says when Send and
 *   Approve open. Send and Approve leave it open, so the round or the
 *   render streams into the same chat. Off: none of it, Review is as before.
 *
 * The host keys the dialog by the store's session, so every opening is a fresh component.
 */
export function ReviewDialog({
  job,
  open,
  onOpenChange,
  onCloseAutoFocus,
  src: srcProp,
  store = reviewDialogStore,
}: ReviewDialogProps) {
  const preview = job.preview ?? FALLBACK_PREVIEW;
  // Draft & chat: the dialog is the job's chat, and it is open while the job runs too.
  const chat = useDraftChatEnabled();
  const running = chat && isRunning(job);
  // A job with two formats (Generated videos): the switch in the header picks the format the player
  // loads and the new notes are written on. null for any other job, which is exactly as before.
  const reviewFormat = useReviewFormat(job);
  /** The size of the composition on show: the main preview's, or the extra format's own. */
  const shownSize =
    reviewFormat === null || reviewFormat.stamp === null ? preview : reviewFormat.shown;

  const { width: viewportWidth, height: viewportHeight } = useViewportSize();
  const layout =
    reviewFormat === null
      ? reviewDialogLayout({
          viewportWidth,
          viewportHeight,
          videoWidth: preview.width,
          videoHeight: preview.height,
          ...(chat ? { panelWidth: CHAT_PANEL_WIDTH } : {}),
        })
      : reviewDialogLayoutOfFormats({
          viewportWidth,
          viewportHeight,
          videos: reviewFormat.formats.map((format, index) => (index === 0 ? preview : format)),
          ...(chat ? { panelWidth: CHAT_PANEL_WIDTH } : {}),
        });
  // While the job runs, the player plays the cut the run changes: its saved version, which the run
  // does not touch. `runPlay` is that cut, or null (not running, or no cut yet).
  const runCut = useRunningCut(job, running && open);
  const runPlay = running ? runCut.play : null;

  const contentRef = useRef<HTMLDivElement>(null);
  /** The player's handle, set when it mounts: what W10 and W11 call. */
  const playerRef = useRef<PreviewPlayerHandle>(null);
  /**
   * The same handle, but only while the player is ready: what the dialog's shortcuts drive. The
   * shortcut handlers act (and swallow Space on keyup over any button) as soon as their ref holds
   * something, and the handle exists from mount; so they get this one, which stays null until the
   * player is ready. Until then Space still presses a focused button, such as Try again.
   */
  const shortcutRef = useRef<PreviewPlayerHandle | null>(null);
  /** The composer's textarea. */
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** When full screen last ended, for the Esc that some browsers deliver after it. */
  const fullscreenExitAt = useRef<number | null>(null);

  const shortcuts = usePlayerShortcuts(shortcutRef);

  // ---- Notes: the list, the dots, the composer and the footer. ----

  const notesQuery = useNotes(job.id, { enabled: job.state === 'review' });
  const seriesName = useEpisodeSeriesName(job);
  const submitting = useStore(store, (state) => state.submitting);
  // While a Send is on its way, and while the dialog fades out, the notes stay as they were. The
  // server's note events take the sent notes out of the list (and the answer to Send empties it)
  // before the dialog is gone, and the panel must not flash "No notes yet" and "Approve" on the way.
  const frozen = !open || submitting !== null;
  const frozenNotes = useRef(notesQuery.data);
  if (!frozen) frozenNotes.current = notesQuery.data;
  const notes = frozen ? frozenNotes.current : notesQuery.data;
  // The job's music (Soundtrack): its `rev` is in the preview's URL, so the player follows it. Once
  // Send or Approve is on its way, or the dialog is closing, it holds still.
  const reviewMusic = useReviewMusic(job.id, frozen);
  // Quick fixes (when on): the line under each note, the notes that wait for Send, the footer's
  // words and Undo. Holds still with the notes once Send or Approve is on its way.
  const quick = useReviewFixes(job, notes, frozen);
  // The job's quick fixes (Quick fixes): their `rev` is in the preview's URL too, so the player loads
  // the changed cut when a fix lands, and goes to the note's moment and stops there (`reviewFix.landOn`).
  // It holds still on the same terms as the music.
  const reviewFix = useReviewFix({ job, notes, hold: frozen });
  const src =
    srcProp ??
    runPlay?.src ??
    previewUrl(
      job.id,
      job.round,
      reviewMusic.rev,
      '',
      null,
      reviewFix.rev,
      reviewFormat?.previewId ?? null,
    );
  // Each note's format stamp and hint line, and which notes the shown format's timeline marks.
  const noteMarks = useNoteMarks(job, notes, reviewFormat?.formats);
  const dotNotes = markerNotes(notes, reviewFormat?.formats, reviewFormat?.shown, noteMarks.scopes);

  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [readyDurationSec, setReadyDurationSec] = useState<number | null>(null);
  const durationSec = readyDurationSec ?? preview.durationSec;
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  /** The note cards, by note id, for `scrollIntoView`. */
  const noteCards = useRef(new Map<string, HTMLElement>());
  const draft = useStore(store, (state) => reviewDraftOf(state, job.id));
  const submitError = useStore(store, (state) => state.submitError);
  const addNote = useAddNote(job.id);
  const sendNotes = useJobAction('send_notes');
  // The Effort button: the edit's level, or with Quick fixes on the review rounds' (Auto by default).
  const reviewEffort = useReviewEffort(job);
  const addVoice = useAddVoiceNote(job.id);
  // A voice note is written on the format that was on show when Record was pressed.
  const recordFormat = useRef<string | null>(null);
  const { recorder, snapshot: rec } = useVoiceRecorder((upload) =>
    addVoice.mutateAsync(
      recordFormat.current === null ? upload : { ...upload, format: recordFormat.current },
    ),
  );
  /** A voice note is being started or recorded: Esc cancels it. */
  const recording = rec.phase === 'starting' || rec.phase === 'recording';
  // The time spent here is counted and sent to the engine (Phase 4 · M3); nothing about it is shown.
  // Playing the video and recording a voice note both count as being there.
  const reviewTimer = useReviewTimer({ jobId: job.id, open, playing, recording, contentRef });
  /** Anything but idle: the microphone, the upload or a failed upload is in the composer's place. */
  const recorderBusy = rec.phase !== 'idle';
  /** Where the red pin sits on the timeline: from Record until the note is added (not after a failed upload). */
  const recordingAtSec = recording || rec.phase === 'saving' ? rec.pinnedSec : null;
  // The look on the paused frame (LUTs build 2): while the note box names a LUT and the video is
  // paused, the player shows that frame with the look, and the @ picker previews LUTs on it. Both
  // are inert while lutsInEdits is off.
  const [writing, setWriting] = useState(false);
  const pausedLook = usePausedLook({
    jobId: job.id,
    round: job.round,
    musicRev: reviewMusic.rev,
    text: draft,
    currentSec,
    durationSec,
    playing,
    ready: readyDurationSec !== null,
    busy: recorderBusy,
    writing,
  });
  // The fonts the note box names, shown on the captions and the titles (FN19; fontsInNotes). Inert,
  // and nothing asked, while the switch is off.
  const fontPreview = useFontPreview({ text: draft, active: !recorderBusy });

  // A time chip or a dot: go there, stop, and mark the note. A note written on the other format
  // takes the player to that format too (the switch follows it).
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

  // A dot under the pointer lights up its card and brings it into view.
  const hoverFromDot = useCallback((id: string | null) => {
    setHoveredNoteId(id);
    if (id !== null) {
      noteCards.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, []);

  const cardRef = useCallback((id: string, element: HTMLElement | null) => {
    if (element === null) noteCards.current.delete(id);
    else noteCards.current.set(id, element);
  }, []);

  // A deleted note is no longer hovered or selected.
  const forgetNote = useCallback((id: string) => {
    setHoveredNoteId((current) => (current === id ? null : current));
    setSelectedNoteId((current) => (current === id ? null : current));
  }, []);

  const isActive = (note: ReviewNote) =>
    isNoteActive(note, { selectedId: selectedNoteId, playing, currentSec });

  function addTypedNote() {
    const text = draft.trim();
    if (text === '' || addNote.isPending) return;
    const at = playerRef.current?.getCurrentTime() ?? currentSec;
    const atSec = durationSec > 0 ? clampTime(at, durationSec) : Math.max(0, at);
    addNote.mutate(
      { atSec, text, ...(reviewFormat === null ? {} : { format: reviewFormat.stamp }) },
      { onSuccess: () => store.getState().setDraft(job.id, '') },
    );
  }

  function changeDraft(text: string) {
    store.getState().setDraft(job.id, text);
    if (addNote.error) addNote.reset();
    recorder.clearError();
  }

  // Record: the video pauses and leaves full screen (the recording box and the tooltips need the
  // page), a playing voice note stops, and the note is pinned where the playhead is now.
  function startRecording() {
    const player = playerRef.current;
    if (player?.isFullscreen()) player.toggleFullscreen();
    player?.pause();
    stopVoicePlayback();
    recorder.clearError();
    const at = player?.getCurrentTime() ?? currentSec;
    recordFormat.current = reviewFormat?.stamp ?? null;
    void recorder.start(durationSec > 0 ? clampTime(at, durationSec) : Math.max(0, at));
  }

  // A voice note starts playing: the video stops (the other way round is in onPlayingChange).
  const pauseForVoice = useCallback(() => playerRef.current?.pause(), []);

  // The closed dialog stays mounted while it fades out, so the unmount alone is too late: closing
  // drops a recording (the microphone goes off) and stops a playing voice note.
  useEffect(() => {
    if (!open) {
      recorder.release();
      stopVoicePlayback();
    }
  }, [open, recorder]);
  useEffect(() => () => stopVoicePlayback(), []);

  // The footer says Approve renders both formats, and on a generated video what the new takes cost.
  const footer = formatsFooter(
    musicFooter(
      quick.footer({
        notes,
        writing: draft.trim() !== '' || addNote.isPending || recorderBusy,
        submitting,
        sendDisabledReason: sendBlockedByRecording(rec) ?? sendBlockedByTranscripts(notes),
      }),
      reviewMusic.music,
    ),
    {
      formats: reviewFormat?.formats,
      sendCount: quick.waiting?.length ?? notes?.length ?? 0,
      takesUsd: noteMarks.takesUsd,
      generate: job.generate ?? undefined,
    },
  );

  // Send is the footer's one action: Approve is in the row's right-click menu only (the owner, 31 Oct).
  function send() {
    // Once the job leaves Review the engine takes no more of its time: send what is counted first.
    reviewTimer.flush();
    // The counts are taken now: a successful Send empties the notes cache. They are the notes
    // "Send N notes" counts: with Quick fixes on, those that wait (the fixed ones are already done).
    const sending = quick.waiting;
    const counts = {
      notes: sending?.length ?? 0,
      styled: sending?.filter((note) => note.addToStyle).length ?? 0,
    };
    void submitReview('send_notes', job.id, counts, {
      store,
      run: (jobId) => sendNotes.mutateAsync(jobId),
      notify: (message) => toast.success(message),
      // The chat stays open: the round, or the render, streams into it.
      ...(chat ? { stayOpen: true } : {}),
    });
  }

  useEffect(() => {
    function onFullscreenChange() {
      if (document.fullscreenElement === null) fullscreenExitAt.current = Date.now();
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  function handlePlayerReady(info: PlayerReadyInfo) {
    shortcutRef.current = playerRef.current;
    setReadyDurationSec(info.durationSec);
  }

  function handlePlayerError() {
    // Try again reloads the player; the next ready sets the shortcuts again.
    shortcutRef.current = null;
  }

  // Radix listens for Escape on the document, in the capture phase, before any element sees it: the
  // order of the spec lives here, and preventDefault keeps the dialog open.
  function onEscapeKeyDown(event: KeyboardEvent) {
    // The @ picker, when open, takes this Esc to close itself; the note box keeps the focus.
    if (escapeIsForPicker(document.activeElement)) {
      event.preventDefault();
      return;
    }
    const step = reviewEscapeStep({
      typing: isTypingTarget(document.activeElement),
      recording,
      fullscreen: escapeIsForFullscreen(
        document.fullscreenElement,
        fullscreenExitAt.current,
        Date.now(),
      ),
    });
    if (step === 'close') return; // Radix closes through onOpenChange.
    event.preventDefault();
    // 'exit-fullscreen': the browser leaves full screen by itself.
    if (step === 'leave-note-box') contentRef.current?.focus();
    if (step === 'cancel-recording') recorder.cancel();
  }

  // The dialog's own keys, after the player's capture handlers have had theirs.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const shortcut = reviewShortcutFor(event);
    if (shortcut === null) return;
    event.preventDefault();
    if (shortcut === 'focus-composer') {
      if (playerRef.current?.isFullscreen()) playerRef.current.toggleFullscreen();
      composerRef.current?.focus();
    }
    if (shortcut === 'toggle-recording') {
      // R starts a recording, or stops and adds the one that is running; at any other moment it
      // does nothing. The recorder knows the moment better than this render does.
      const phase = recorder.getSnapshot().phase;
      if (phase === 'idle') startRecording();
      else if (phase === 'recording') recorder.stop();
    }
  }

  // The notes that wait for Send: the notes column's list, or (`embedded`) the chat's end.
  const notesList = (embedded: boolean) => (
    <NotesList
      embedded={embedded}
      jobId={job.id}
      client={job.client}
      seriesName={seriesName}
      notes={notes}
      loading={notesQuery.isPending && notesQuery.fetchStatus === 'fetching'}
      failed={notesQuery.isError && notes === undefined}
      onRetry={() => void notesQuery.refetch()}
      hoveredId={hoveredNoteId}
      isActive={isActive}
      onHover={setHoveredNoteId}
      onGo={goToNote}
      onDeleted={forgetNote}
      cardRef={cardRef}
      onPlayVoice={pauseForVoice}
      fixLines={quick.lines}
      onUndo={quick.undo}
      undoing={quick.undoing}
      marks={noteMarks.marks}
    />
  );
  // The note box, or the recording box while a voice note is on its way.
  const composer =
    rec.phase === 'idle' ? (
      <ReviewComposer
        timeLabel={formatPlayhead(currentSec, durationSec)}
        draft={draft}
        onDraftChange={changeDraft}
        onAdd={addTypedNote}
        onFocus={() => {
          setWriting(true);
          playerRef.current?.pause();
        }}
        adding={addNote.isPending}
        error={addNote.error?.message ?? rec.error}
        composerRef={composerRef}
        onRecord={startRecording}
        frame={pausedLook.frame}
        formatLabel={reviewFormat?.shown.label}
      />
    ) : (
      <RecordingBox
        snapshot={rec}
        onCancel={recorder.cancel}
        onStop={recorder.stop}
        onRetry={() => void recorder.retry()}
        onDiscard={recorder.discard}
      />
    );

  // The player's place while its chunk loads, and while the music's first answer is on its way (the
  // player waits for it, so it loads once, with the music's `rev`).
  const playerPlaceholder = (
    <div
      data-slot="preview-player-placeholder"
      aria-hidden="true"
      className="shrink-0 bg-black"
      style={{ width: layout.video.width, height: layout.video.height + CONTROLS_HEIGHT }}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        data-review-dialog=""
        tabIndex={-1}
        showCloseButton={false}
        className="flex max-w-none flex-col gap-0 overflow-hidden p-0 leading-normal sm:max-w-none"
        style={{ width: layout.width, height: layout.height }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onEscapeKeyDown={onEscapeKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
        {...shortcuts}
        onKeyDown={onKeyDown}
      >
        <ReviewDialogHeader
          job={job}
          running={running ? runningLabel(job) : null}
          musicRev={reviewMusic.rev}
          exportFormat={
            reviewFormat === null
              ? undefined
              : { id: reviewFormat.stamp, label: reviewFormat.shown.label }
          }
          formatSwitch={
            reviewFormat === null ? undefined : (
              <FormatSwitch
                formats={reviewFormat.formats}
                value={reviewFormat.shown}
                onChange={reviewFormat.select}
              />
            )
          }
        />
        <DialogDescription className="sr-only">{REVIEW_DIALOG_TEXT.description}</DialogDescription>
        <div className="flex min-h-0 flex-1">
          {running && runPlay === null ? (
            <ChatStage
              width={layout.video.width}
              height={layout.video.height + CONTROLS_HEIGHT}
              waiting={stageWaiting(job, runCut.loading)}
            />
          ) : (
            <Suspense fallback={playerPlaceholder}>
              {reviewMusic.settling ? (
                playerPlaceholder
              ) : (
                <SwapPlayer
                  ref={playerRef}
                  src={src}
                  videoWidth={(runPlay ?? shownSize).width}
                  videoHeight={(runPlay ?? shownSize).height}
                  durationSec={(runPlay ?? preview).durationSec || undefined}
                  maxWidth={layout.maxVideoWidth}
                  maxHeight={layout.maxVideoHeight}
                  columnWidth={reviewFormat === null ? undefined : layout.video.width}
                  stageHeight={reviewFormat === null ? undefined : layout.video.height}
                  controlsTrailing={<MusicNowPlaying music={reviewMusic.music} />}
                  overlay={pausedLook.overlay}
                  fontPreview={fontPreview}
                  fixPill={reviewFix.pill}
                  landOn={reviewFix.landOn}
                  onReady={handlePlayerReady}
                  onError={handlePlayerError}
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
                        notes={dotNotes}
                        durationSec={durationSec}
                        hoveredId={hoveredNoteId}
                        isActive={isActive}
                        onHover={hoverFromDot}
                        onSelect={goToNote}
                        recordingAtSec={recordingAtSec}
                      />
                    ) : undefined
                  }
                />
              )}
            </Suspense>
          )}
          {chat ? (
            <JobChatPanel
              job={job}
              open={open}
              notes={
                notes !== undefined && notes.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <span className="self-end text-xs text-zinc-500">{JOB_CHAT_TEXT.notSent}</span>
                    {notesList(true)}
                  </div>
                ) : undefined
              }
              composer={
                running ? (
                  <p
                    data-slot="chat-composer-waits"
                    className="m-0 shrink-0 border-t px-4 py-3 text-[13px] text-muted-foreground"
                  >
                    {JOB_CHAT_TEXT.notesWait}
                  </p>
                ) : (
                  composer
                )
              }
            />
          ) : (
            <ReviewNotesPanel count={notes?.length ?? 0}>
              {notesList(false)}
              {composer}
            </ReviewNotesPanel>
          )}
        </div>
        <ReviewFooter>
          {running ? (
            <p data-slot="chat-footer-waits" className="m-0 text-[13px] text-muted-foreground">
              {waitingFooter(job)}
            </p>
          ) : (
            <ReviewFooterActions
              view={footer}
              error={submitError}
              onSend={send}
              effort={reviewEffort}
            />
          )}
        </ReviewFooter>
      </DialogContent>
    </Dialog>
  );
}
