// The review service (Phase 3 · W5): every rule about the owner's review notes, the transcription of their
// voice notes, and the two actions that end a review round -- Send notes and Approve. The routes
// (routes/notes.ts and the two actions of routes/jobs.ts) only do HTTP; they call this.
//
//   notes      add a text note, add a voice note (the recording is saved under edit/review/voice/
//              and transcribed by itself), edit, delete, serve the recording -- all only while the
//              job is in Review. With quick fixes on and the job on Auto, a note is also handed to
//              the router (note-routing.ts) when it is added, when its text changes and when a
//              voice note's transcript is done
//              A note with a quick fix (QF3, fix-service.ts) keeps its words: new text for a fixed
//              note, or while its fix runs, is 409 (a queued fix is cancelled instead); deleting a
//              note cancels its queued fix, is 409 while it runs, and undoes the newest fix first
//   Send       writes edit/review/round-N.md, then in one transaction moves the job to `queued`
//              (SEND_NOTES) and stamps the unsent notes with the round; the Add to style and Add to
//              series hooks run after, and the job's route publishes it and wakes the worker.
//              Quick fixes (QF4): a note fixed in Review is still unsent; the round file lists it
//              under "Already changed in Review (keep these)", and Send needs at least one waiting
//              (unfixed) note. With Auto it waits for the router to read the waiting notes and saves
//              the revise run's tier (`job.reviseTier`) in the same transaction. Afterwards the
//              round's fix files are cleared
//   Approve    refuses while a waiting (unfixed) note is unsent, else moves the job to `queued`
//              (APPROVE). The notes fixed in Review are stamped sent with round `job.round + 1`
//              (the job's round stays), go through the same Add to style and Add to series hooks,
//              and the round's fix files are cleared
//
// Note events (`note.upsert`, `note.remove`) are published here, after the write is committed.

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AddNoteRequest,
  biggestTier,
  FIX_MESSAGES,
  type FixTier,
  InvalidTransition,
  isFixedNote,
  type Job,
  type PatchNoteRequest,
  REVIEW_NOTE_MAX_LENGTH,
  type ReviewNote,
  type ReviseTier,
  renderRoundFile,
  SERIES_MESSAGES,
  type VoiceNoteType,
} from '@studio/shared';
import {
  JobNotFoundError,
  type JobRepository,
  type NoteRepository,
  type StudioDb,
  type TranscriptOutcome,
} from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { TranscriptionError, type VoiceTranscriber } from '../pipeline/voice-transcriber.js';
import { transcriptPathFor } from '../pipeline/voice-transcript.js';
import { resolveInside } from '../routes/download.js';
import { NO_NOTE_ROUTING, type NoteRouting } from './note-routing.js';
import {
  roundFilePath,
  VOICE_DIR_PATH,
  voiceAudioPath,
  voiceContentType,
  writeFileAtomic,
} from './review-files.js';

/** A note request or review action the rules refuse; the API answers `status` with the message. */
export class ReviewError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422;

  constructor(status: 400 | 404 | 409 | 413 | 422, message: string) {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
  }
}

export const REVIEW_MESSAGES = {
  notInReview: 'Notes can only be changed while the job is in Review.',
  noteBody: 'Send the note as JSON: { "atSec": seconds, "text": "the note" }.',
  patchBody: 'Send the change as JSON: { "text": "the note" } or { "addToStyle": true }.',
  noteEmpty: 'The note is empty.',
  noteTooLong: `A note can be at most ${REVIEW_NOTE_MAX_LENGTH} characters.`,
  voiceTextFixed: "A voice note's text is its transcript and can't be changed.",
  voiceForm: 'Send the voice note as form data: audio, atSec and audioSec.',
  voiceType: 'A voice note must be audio/webm or audio/mp4.',
  voiceEmpty: 'The voice note is empty.',
  voiceTooLong: 'A voice note can be at most 5 minutes long.',
  voiceTooLarge: 'A voice note can be at most 25 MB.',
  noAudio: 'This note has no audio.',
  audioMissing: "The voice note's audio file is missing.",
  noNotesToSend: 'There are no notes to send.',
  waitForTranscripts: 'Wait for the voice notes to be transcribed.',
  notesChanged: 'The notes changed while they were being sent. Try again.',
  sendOrDeleteFirst: 'Send or delete your notes first.',
  /** 422, a note marked Series on a job that is in no series. (While series are off: SERIES_MESSAGES.off.) */
  notInSeries: 'Only a note on a job in a series can go into the series.',
  /** 409, going back to an earlier cut while every unsent note is a fix made in Review (Send would say there is nothing to send). */
  approveOrUndoFirst: 'Approve or undo your fixes first.',
  /** 400, a note written on a format the job does not have (Generated videos). */
  badFormat: 'This job has no such format.',
} as const;

export function noteNotFoundMessage(noteId: string): string {
  return `Note ${noteId} not found`;
}

/** What Send does with the sent notes marked Add to style (W7). It must not wait for the Read pass. */
export interface StyleNotesHook {
  /** `job` is the job after SEND_NOTES (job.round = the round just sent); `notes` are only the sent notes with addToStyle. */
  append(job: Job, notes: readonly ReviewNote[]): Promise<void>;
}

/** The default until W7: nothing goes into the style. */
export const NO_STYLE_NOTES: StyleNotesHook = { append: async () => {} };

/**
 * What Send does with the sent notes marked Series (Series plan §6): a file in the series folder
 * that waits for the episode's approval (C26). It must not fail the Send.
 */
export interface SeriesNotesHook {
  /** Whether series are on (`SeriesService.enabled`): a note can be marked Series only while they are. */
  readonly enabled: boolean;
  /** `job` is the job after SEND_NOTES (job.round = the round just sent); `notes` are only the sent notes with addToSeries. */
  append(job: Job, notes: readonly ReviewNote[]): Promise<void>;
}

/** The default: series are off, and nothing goes into one. */
export const NO_SERIES_NOTES: SeriesNotesHook = { enabled: false, append: async () => {} };

/**
 * What the quick fixes (fix-service.ts) have to say about a note before its text changes or it is
 * deleted (QF3). Both answer the 409 text when the note may not be touched, else `null`; a fix
 * that is only queued for the note is cancelled on the way, and a fixed note's newest fix is undone.
 * Also what Send and Approve ask of them (QF4): what the fix of a note said, and the round's fix
 * files removed once the round is over. A review service given these rules is one with the Quick
 * fixes switch on.
 */
export interface NoteFixRules {
  beforeEdit(note: ReviewNote): string | null;
  beforeDelete(note: ReviewNote): Promise<string | null>;
  /** What the fix of a fixed note told the owner ("The captions are Heebo Bold now."), or `null`. */
  said(note: ReviewNote): string | null;
  /** Removes the job's fix files after Send or Approve (`FixService.clearRound`: only files, never rows). It must not throw. */
  clearRound(jobId: string): Promise<void>;
}

export interface VoiceNoteInput {
  audio: Uint8Array;
  type: VoiceNoteType;
  atSec: number;
  audioSec: number;
  /** The format of the preview it was recorded on (Generated videos): the id of one of the job's formats. Left out: the main one. */
  format?: string | null;
}

export interface ReviewServiceOptions {
  /** For the Send and Approve transactions. */
  db: StudioDb;
  jobs: JobRepository;
  notes: NoteRepository;
  /** Publishes note.upsert / note.remove; listens for job.remove. */
  bus: EventBus;
  /** A job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** The engine stops it, not the service. */
  transcriber: Pick<VoiceTranscriber, 'enqueue'>;
  /** Default {@link NO_STYLE_NOTES}. */
  styleNotes?: StyleNotesHook;
  /** Default {@link NO_SERIES_NOTES}. */
  seriesNotes?: SeriesNotesHook;
  /** Default {@link SILENT_LOGGER}. */
  logger?: RunnerLogger;
  /** Called when a voice note has its text, for the usage log (`transcribe`). Default: nothing. */
  onTranscribed?: (note: ReviewNote, job: Job) => void;
  /**
   * Why Approve and Send notes must wait for this job, or `null` (Soundtrack: a version of the music
   * is being made or a pick is under way, so the render or the revise run would not get the music
   * that is picked). Asked inside their transactions, so it must not wait: answer from memory.
   * Default: never.
   */
  reviewBlock?: (job: Job) => string | null;
  /** Called after a Send, with the job and the notes just sent (Analytics groups them into topics). Never fails the Send. Default: nothing. */
  onSent?: (job: Job, notes: readonly ReviewNote[]) => void;
  /** Reads each note with the difficulty index while the job is on Auto (quick fixes, QF1). The engine stops it, not the service. Default {@link NO_NOTE_ROUTING}. */
  routing?: NoteRouting;
  /** What the quick fixes say about changing or deleting a note that has one (QF3). The engine stops it, not the service. Default: nothing (no note has a fix). */
  fixes?: NoteFixRules;
  /** `sentAt` of the sent notes. Default `() => new Date()`. */
  clock?: () => Date;
  /** Note ids. Default `randomUUID`; tests pass n1, n2, … */
  newId?: () => string;
}

export interface ReviewService {
  /** The job, if it is in review. Throws JobNotFoundError, or ReviewError 409 notInReview. Every note route calls it first. */
  requireReview(jobId: string): Job;
  listNotes(jobId: string): ReviewNote[];
  addTextNote(jobId: string, input: AddNoteRequest): ReviewNote;
  addVoiceNote(jobId: string, input: VoiceNoteInput): Promise<ReviewNote>;
  updateNote(jobId: string, noteId: string, patch: PatchNoteRequest): ReviewNote;
  deleteNote(jobId: string, noteId: string): Promise<void>;
  /** The recording to serve: its real path (resolveInside) and Content-Type. */
  noteAudio(jobId: string, noteId: string): Promise<{ path: string; contentType: VoiceNoteType }>;
  sendNotes(jobId: string): Promise<Job>;
  /** Moves a job in review to its render run. Throws what Send throws for a state that forbids it; 409 while a waiting note is unsent. */
  approve(jobId: string): Promise<Job>;
  /** Boot: enqueues every pending voice note of a job that still exists. */
  resumeTranscriptions(): void;
  /** Shutdown: stops listening to the bus; no new transcription starts. */
  stop(): void;
}

/** A transcription that is queued or running, so it can be stopped. */
interface RunningTranscription {
  jobId: string;
  controller: AbortController;
}

export function createReviewService(options: ReviewServiceOptions): ReviewService {
  const {
    db,
    jobs,
    notes,
    bus,
    inboxPath,
    transcriber,
    styleNotes = NO_STYLE_NOTES,
    seriesNotes = NO_SERIES_NOTES,
    logger = SILENT_LOGGER,
    onTranscribed = () => {},
    onSent = () => {},
    routing = NO_NOTE_ROUTING,
    fixes,
    reviewBlock,
    clock = () => new Date(),
    newId = randomUUID,
  } = options;

  const running = new Map<string, RunningTranscription>();
  /** Jobs whose Send is under way: a second Send of the same job waits its turn. */
  const sends = new Map<string, Promise<void>>();
  let stopped = false;

  const jobDirOf = (job: Job): string => join(inboxPath, job.relPath);

  /**
   * The format a note is stored with (Generated videos): the id of an extra format the job has, and
   * `null` for the main format (also what a request without one, and a job with one format, mean).
   * A format the job does not have is refused: the page that sent it is out of date.
   */
  function noteFormatOf(job: Job, requested: string | null | undefined): string | null {
    if (requested === undefined || requested === null) return null;
    const formats = job.formats;
    if (formats === undefined) return null;
    if (formats[0]?.id === requested) return null;
    if (!formats.some((format) => format.id === requested)) {
      throw new ReviewError(400, REVIEW_MESSAGES.badFormat);
    }
    return requested;
  }

  function publishUpsert(note: ReviewNote): void {
    bus.publish({ type: 'note.upsert', note });
  }

  function requireReview(jobId: string): Job {
    const job = jobs.get(jobId);
    if (job === null) throw new JobNotFoundError(jobId);
    if (job.state !== 'review') throw new ReviewError(409, REVIEW_MESSAGES.notInReview);
    return job;
  }

  /** An unsent note of this job. Sent notes are never changed, and another job's note is not found. */
  function unsentNote(jobId: string, noteId: string): ReviewNote {
    const note = notes.get(noteId);
    if (note === null || note.jobId !== jobId || note.round !== null) {
      throw new ReviewError(404, noteNotFoundMessage(noteId));
    }
    return note;
  }

  /** The trimmed text of a typed note, or the 400 it breaks. */
  function checkedText(raw: string): string {
    const text = raw.trim();
    if (text === '') throw new ReviewError(400, REVIEW_MESSAGES.noteEmpty);
    if (text.length > REVIEW_NOTE_MAX_LENGTH) {
      throw new ReviewError(400, REVIEW_MESSAGES.noteTooLong);
    }
    return text;
  }

  function settle(noteId: string, outcome: TranscriptOutcome): void {
    running.delete(noteId);
    let note: ReviewNote | null = null;
    try {
      note = notes.setTranscript(noteId, outcome);
      // A transcript that is done is a note Auto can read; a failed one has nothing to read.
      if (note !== null && outcome.status === 'done') note = routing.begin(note);
    } catch (err) {
      logger.error({ err, noteId }, 'could not save the transcript of a voice note');
    }
    // Null: the note was deleted (or its job removed) while it was being transcribed.
    if (note !== null) publishUpsert(note);
  }

  function transcribe(note: ReviewNote, job: Job): void {
    if (stopped || note.kind !== 'voice' || note.audioFile === null) return;
    // A second enqueue of the same recording would share the first one's result and ignore its signal.
    if (running.has(note.id)) return;

    const jobDir = jobDirOf(job);
    const controller = new AbortController();
    running.set(note.id, { jobId: note.jobId, controller });
    const audioPath = join(jobDir, note.audioFile);
    // No language: Scribe's auto-detect is as good as --language he, and a forced brief language
    // garbles a Hebrew note on an English job (W6).
    new Promise<{ text: string }>((resolve) => {
      resolve(
        transcriber.enqueue({
          audioPath,
          outDir: join(jobDir, VOICE_DIR_PATH),
          signal: controller.signal,
        }),
      );
    }).then(
      ({ text }) => {
        settle(note.id, { status: 'done', text });
        try {
          onTranscribed(note, job);
        } catch (err) {
          logger.warn({ err, noteId: note.id }, 'could not report a transcribed voice note');
        }
      },
      (err: unknown) => {
        // Deleted (cancelled) or shutting down (stopped): the note stays as it is; a pending one
        // is transcribed again at the next boot.
        if (
          err instanceof TranscriptionError &&
          (err.code === 'cancelled' || err.code === 'stopped')
        ) {
          running.delete(note.id);
          return;
        }
        settle(note.id, { status: 'failed' }); // timed_out, no_speech, failed, or anything unexpected
      },
    );
  }

  function stopTranscription(noteId: string): void {
    const run = running.get(noteId);
    if (run === undefined) return;
    running.delete(noteId);
    run.controller.abort();
  }

  // A removed job takes its notes with it (JobRepository.remove); its transcriptions stop here.
  const unsubscribe = bus.subscribe((event) => {
    if (event.type !== 'job.remove') return;
    for (const [noteId, run] of [...running]) {
      if (run.jobId === event.id) stopTranscription(noteId);
    }
  });

  /** Runs `work` after every earlier Send of this job has finished. */
  function exclusive<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = sends.get(jobId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(
      () => {},
      () => {},
    );
    sends.set(jobId, tail);
    void tail.then(() => {
      if (sends.get(jobId) === tail) sends.delete(jobId);
    });
    return result;
  }

  /** Where Auto put a waiting note: the router's tier, or `full` for a note it never read (or could not). */
  function waitingTier(note: ReviewNote): FixTier {
    return note.routeStatus === 'routed' && note.route !== null ? note.route.tier : 'full';
  }

  /**
   * The tier of the revise run a Send queues (QF4), read from the job as it is now: with the switch
   * on and Auto chosen, the biggest tier among the waiting notes, where a quick note that was not
   * fixed counts as `revise`; else `null` (a chosen level, or the switch off).
   */
  function reviseTierOf(jobId: string, waiting: readonly ReviewNote[]): ReviseTier | null {
    const job = jobs.get(jobId);
    if (job === null || !routing.enabled || job.reviewEffort !== null) return null;
    return biggestTier(waiting.map(waitingTier), { goesWithSend: true });
  }

  /**
   * What follows a round's notes being stamped sent, for Send and for an Approve that stamps fixed
   * notes: the Add to style and Add to series hooks (neither fails it), the notes leaving the unsent
   * list, the report to Analytics, and the round's fix files removed (QF4). `job.round` is the
   * round of `sentNotes`.
   */
  async function afterRound(job: Job, sentNotes: readonly ReviewNote[]): Promise<void> {
    const jobId = job.id;
    // Add to style (W7), then Add to series (K5).
    const styled = sentNotes.filter((note) => note.addToStyle);
    if (styled.length > 0) {
      try {
        await styleNotes.append(job, styled);
      } catch (err) {
        logger.error({ err, jobId }, 'could not add the review notes to the style');
      }
    }
    const serial = sentNotes.filter((note) => note.addToSeries);
    if (serial.length > 0) {
      try {
        await seriesNotes.append(job, serial);
      } catch (err) {
        logger.error({ err, jobId }, 'could not add the review notes to the series');
      }
    }

    // The sent notes leave the unsent list.
    for (const note of sentNotes) bus.publish({ type: 'note.remove', jobId, noteId: note.id });
    if (sentNotes.length > 0) {
      try {
        onSent(job, sentNotes);
      } catch (err) {
        logger.warn({ err, jobId }, 'could not report the sent review notes');
      }
    }
    await clearFixes(jobId);
  }

  /** The round is over: the fix files of the job go (the rows stay). Never fails the Send or the Approve. */
  async function clearFixes(jobId: string): Promise<void> {
    try {
      await fixes?.clearRound(jobId);
    } catch (err) {
      logger.warn({ err, jobId }, 'could not clear the quick fix files of a job');
    }
  }

  async function send(jobId: string): Promise<Job> {
    const job = jobs.get(jobId);
    if (job === null) throw new JobNotFoundError(jobId);
    if (job.state !== 'review') throw new InvalidTransition(job, 'SEND_NOTES'); // the route says "Cannot send the notes of a job that is X."
    const unsent = notes.listUnsent(jobId);
    if (unsent.length === 0) throw new ReviewError(409, REVIEW_MESSAGES.noNotesToSend);
    if (unsent.some((note) => note.transcriptStatus === 'pending')) {
      throw new ReviewError(409, REVIEW_MESSAGES.waitForTranscripts);
    }
    // Before the round file is written; asked again inside the transaction below.
    const early = reviewBlock?.(job);
    if (early !== null && early !== undefined) throw new ReviewError(409, early);
    // Quick fixes (QF4): a note fixed in Review rides along as already changed; the revise run is for
    // the others. Auto has to finish reading them first, since the run's tier depends on the answer.
    const waiting = unsent.filter((note) => !isFixedNote(note));
    if (waiting.length === 0) throw new ReviewError(409, FIX_MESSAGES.onlyFixed);
    if (
      routing.enabled &&
      job.reviewEffort === null &&
      waiting.some((note) => note.routeStatus === 'pending')
    ) {
      throw new ReviewError(409, FIX_MESSAGES.waitForAuto);
    }

    // 1. The round file, before the transition, so the revise run always finds it.
    const round = job.round + 1;
    const roundFile = join(jobDirOf(job), roundFilePath(round));
    await writeFileAtomic(
      roundFile,
      renderRoundFile({
        job: job.name,
        client: job.client,
        round,
        notes: waiting,
        fixed: unsent
          .filter(isFixedNote)
          .map((note) => ({ ...note, said: fixes?.said(note) ?? null })),
        // A job with two formats: each line says which preview its note was written on.
        ...(job.formats === undefined
          ? {}
          : { formats: job.formats.map(({ id, label }) => ({ id, label })) }),
      }),
    );

    // 2. One transaction (synchronous: better-sqlite3 refuses a promise): the job moves on and its
    // notes get the round, or neither.
    let sent: { job: Job; notes: ReviewNote[] };
    try {
      sent = db.sqlite
        .transaction(() => {
          // Something changed while the file was written (another tab): the file would be wrong.
          if (JSON.stringify(notes.listUnsent(jobId)) !== JSON.stringify(unsent)) {
            throw new ReviewError(409, REVIEW_MESSAGES.notesChanged);
          }
          // A make could have started while the file was written.
          const blocked = reviewBlock?.(job);
          if (blocked !== null && blocked !== undefined) throw new ReviewError(409, blocked);
          let next = jobs.applyTransition(jobId, { type: 'SEND_NOTES' }); // a savepoint inside this transaction
          if (next.round !== round) {
            throw new Error(`Sent round ${round}, but the job is at round ${next.round}`);
          }
          // With Auto (switch on, no level chosen) the run takes the tier its biggest waiting note
          // needs; with a level, or with the switch off, there is none and the run is as it was.
          const tier = reviseTierOf(jobId, waiting);
          if (next.reviseTier !== tier) next = jobs.setReviseTier(jobId, tier);
          const ids = unsent.map((note) => note.id);
          return { job: next, notes: notes.markSent(jobId, ids, round, clock().toISOString()) };
        })
        .immediate();
    } catch (err) {
      await rm(roundFile, { force: true }).catch((rmErr: unknown) =>
        logger.error({ err: rmErr, jobId }, 'could not remove the round file'),
      );
      throw err;
    }

    // 3. The Add to style and Add to series hooks, the sent notes leaving the unsent list, the report
    // to Analytics and the round's fix files (afterRound). The jobs route then publishes the job and
    // wakes the worker.
    await afterRound(sent.job, sent.notes);
    return sent.job;
  }

  async function approve(jobId: string): Promise<Job> {
    // One transaction: the job moves on and the notes fixed in Review get their round, or neither.
    const approved = db.sqlite
      .transaction((): { job: Job; sent: ReviewNote[] } => {
        const job = jobs.get(jobId);
        if (job === null) throw new JobNotFoundError(jobId);
        if (job.state !== 'review') {
          return { job: jobs.applyTransition(jobId, { type: 'APPROVE' }), sent: [] }; // InvalidTransition
        }
        // Something is changing the preview (a quick fix, the music): it is asked before the notes,
        // so a fix that runs answers "busy" and not "send or delete your notes".
        const blocked = reviewBlock?.(job);
        if (blocked !== null && blocked !== undefined) throw new ReviewError(409, blocked);
        // A note that waits for Send would be lost; one fixed in Review is already in the preview.
        const unsent = notes.listUnsent(jobId);
        if (unsent.some((note) => !isFixedNote(note))) {
          throw new ReviewError(409, REVIEW_MESSAGES.sendOrDeleteFirst);
        }
        const next = jobs.applyTransition(jobId, { type: 'APPROVE' });
        // The fixed notes are the next round's, as Send would have stamped them; the job's round stays.
        const sent =
          unsent.length === 0
            ? []
            : notes.markSent(
                jobId,
                unsent.map((note) => note.id),
                job.round + 1,
                clock().toISOString(),
              );
        return { job: next, sent };
      })
      .immediate();

    // The hooks see the round the notes were stamped with, as after a Send.
    const round = approved.sent[0]?.round ?? null;
    if (round === null) await clearFixes(jobId);
    else await afterRound({ ...approved.job, round }, approved.sent);
    return approved.job;
  }

  return {
    requireReview,

    listNotes(jobId) {
      requireReview(jobId);
      return notes.listUnsent(jobId);
    },

    addTextNote(jobId, input) {
      const job = requireReview(jobId);
      const text = checkedText(input.text);
      const format = noteFormatOf(job, input.format);
      const created = notes.create({
        id: newId(),
        jobId,
        kind: 'text',
        atSec: input.atSec,
        text,
        format,
      });
      // With Auto on, the note is already `pending` when it is published.
      const note = routing.begin(created);
      publishUpsert(note);
      return note;
    },

    async addVoiceNote(jobId, input) {
      const first = requireReview(jobId);
      const format = noteFormatOf(first, input.format);
      const id = newId();
      const audioFile = voiceAudioPath(id, input.type);
      const path = join(jobDirOf(first), audioFile);
      let note: ReviewNote;
      let job: Job;
      try {
        await writeFileAtomic(path, input.audio);
        // The job can leave review while the recording is written: look again, with no await
        // between that and the insert.
        job = requireReview(jobId);
        note = notes.create({
          id,
          jobId,
          kind: 'voice',
          atSec: input.atSec,
          audioFile,
          audioSec: input.audioSec,
          format,
        });
      } catch (err) {
        await rm(path, { force: true }).catch((rmErr: unknown) =>
          logger.error({ err: rmErr, jobId }, 'could not remove the recording of an unsaved note'),
        );
        throw err;
      }
      publishUpsert(note);
      transcribe(note, job);
      return note;
    },

    updateNote(jobId, noteId, patch) {
      const job = requireReview(jobId);
      const note = unsentNote(jobId, noteId);
      const changes: { text?: string; addToStyle?: boolean; addToSeries?: boolean } = {};
      if (patch.text !== undefined) {
        if (note.kind === 'voice') throw new ReviewError(400, REVIEW_MESSAGES.voiceTextFixed);
        changes.text = checkedText(patch.text);
        // New words: a note with a fix cannot take them (Undo first), and one whose fix is queued gives it up.
        if (changes.text !== note.text) {
          const refusal = fixes?.beforeEdit(note) ?? null;
          if (refusal !== null) throw new ReviewError(409, refusal);
        }
      }
      if (patch.addToStyle !== undefined) changes.addToStyle = patch.addToStyle;
      if (patch.addToSeries !== undefined) {
        // Marking needs series that are on and an episode; unmarking is always allowed, so a mark
        // that can't be kept (the job left its series) can still be cleared.
        if (patch.addToSeries) {
          if (!seriesNotes.enabled) throw new ReviewError(422, SERIES_MESSAGES.off);
          if (job.seriesId === null) throw new ReviewError(422, REVIEW_MESSAGES.notInSeries);
        }
        changes.addToSeries = patch.addToSeries;
      }
      const saved = notes.update(noteId, changes);
      if (saved === null) throw new ReviewError(404, noteNotFoundMessage(noteId));
      // New words need a new reading: the sorting of the old ones is dropped.
      const updated = saved.text !== note.text ? routing.begin(saved) : saved;
      publishUpsert(updated);
      return updated;
    },

    async deleteNote(jobId, noteId) {
      const job = requireReview(jobId);
      const first = unsentNote(jobId, noteId);
      // A note with a fix: queued, the fix is cancelled; running, the delete waits (409); fixed, the
      // newest fix is undone first (else 409). Undo takes a moment, so look at the note again after.
      const refusal = (await fixes?.beforeDelete(first)) ?? null;
      if (refusal !== null) throw new ReviewError(409, refusal);
      const note = unsentNote(jobId, noteId);
      notes.remove(noteId);
      stopTranscription(noteId);
      routing.forget(noteId);
      bus.publish({ type: 'note.remove', jobId, noteId });
      if (note.audioFile === null) return;

      const jobDir = jobDirOf(job);
      const audioPath = join(jobDir, note.audioFile);
      const transcriptPath = transcriptPathFor(audioPath, join(jobDir, VOICE_DIR_PATH));
      for (const path of [audioPath, transcriptPath]) {
        await rm(path, { force: true }).catch((err: unknown) =>
          logger.error({ err, jobId, noteId }, 'could not remove a deleted voice note file'),
        );
      }
    },

    async noteAudio(jobId, noteId) {
      const job = requireReview(jobId);
      const note = notes.get(noteId);
      if (note === null || note.jobId !== jobId) {
        throw new ReviewError(404, noteNotFoundMessage(noteId));
      }
      if (note.audioFile === null) throw new ReviewError(404, REVIEW_MESSAGES.noAudio);
      const path = await resolveInside(jobDirOf(job), note.audioFile);
      if (path === null) throw new ReviewError(404, REVIEW_MESSAGES.audioMissing);
      return { path, contentType: voiceContentType(note.audioFile) };
    },

    sendNotes: (jobId) => exclusive(jobId, () => send(jobId)),

    approve: (jobId) => exclusive(jobId, () => approve(jobId)),

    resumeTranscriptions() {
      for (const note of notes.listPendingVoice()) {
        const job = jobs.get(note.jobId);
        if (job !== null) transcribe(note, job);
      }
    },

    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
