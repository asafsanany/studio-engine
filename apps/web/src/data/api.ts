// Typed fetch wrappers for the jobs API (architecture §7). Every response is parsed with the shared
// zod schemas, so the rest of the app only ever sees valid `Job`s, and every failure is an
// `ApiError` that carries the text the server wrote for the person (a 409 says why the action is
// not allowed). No toasts and no retries here: callers decide what to show and when to try again.
// A request that gets no answer within 10 s (a voice-note upload 60 s) ends as an `ApiError` too, so
// a server that takes the connection and never replies cannot keep a page loading for ever. The one
// exception is a style upload, which goes through an XMLHttpRequest (to report progress) and can be
// as big as 2 GB: it ends when the server answers, or when the caller aborts it.

import {
  type AddNoteRequest,
  type AddTeamUserRequest,
  type AnalyticsPeriod,
  type AnalyticsResponse,
  type ArchiveJobsRequest,
  type AssigneesResponse,
  analyticsResponseSchema,
  apiErrorSchema,
  archiveJobsResponseSchema,
  assigneesResponseSchema,
  type ClientListResponse,
  type ClientRow,
  type ClientStyle,
  type ClientStyleResponse,
  type CreateClientRequest,
  clientListResponseSchema,
  clientStyleResponseSchema,
  clientStyleSchema,
  createClientResponseSchema,
  type DeleteClientResponse,
  deleteClientResponseSchema,
  deleteNoteResponseSchema,
  deliverResponseSchema,
  type Effort,
  type GenerateHistoryEvent,
  type GenerateNotePlan,
  type GenerateState,
  generateHistoryResponseSchema,
  generateNotePlanSchema,
  generateResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type Job,
  type JobAction,
  type JobActionOptions,
  type JobFeedResponse,
  type JobStepsResponse,
  type JobVersionsResponse,
  jobActionPath,
  jobActionResponseSchema,
  jobFeedResponseSchema,
  jobFixesResponseSchema,
  jobListResponseSchema,
  jobSchema,
  jobStepsResponseSchema,
  jobVersionsResponseSchema,
  type MakeMusicRequest,
  type MarkPaidRequest,
  type MeResponse,
  type MoneyPriceResponse,
  type MoneyResponse,
  type MusicView,
  meResponseSchema,
  moneyPriceResponseSchema,
  moneyResponseSchema,
  musicResponseSchema,
  musicViewSchema,
  type NoSongStatus,
  noSongStatusSchema,
  noteListResponseSchema,
  noteResponseSchema,
  type OrphanDelivery,
  orphanAsJob,
  orphanDeliveriesResponseSchema,
  type PatchNoteRequest,
  type PaymentResponse,
  type PickMusicRequest,
  paymentResponseSchema,
  type QuickFix,
  type RenameClientRequest,
  type RenameJobRequest,
  type RevealJobResponse,
  type ReviewEffortRequest,
  type ReviewNote,
  type ReviewTimeRequest,
  renameClientResponseSchema,
  renameJobResponseSchema,
  revealClientResponseSchema,
  revealJobResponseSchema,
  reviewTimeResponseSchema,
  type SaveEffortRequest,
  type SaveNoteRequest,
  type SentNotesResponse,
  type SetAssigneesRequest,
  type SettingsResponse,
  type StockResponse,
  saveEffortResponseSchema,
  saveNoteResponseSchema,
  sentNotesResponseSchema,
  settingsResponseSchema,
  stockResponseSchema,
  type TeamResponse,
  type TeamUser,
  teamResponseSchema,
  teamUserSchema,
  type UnarchiveJobsRequest,
  type UndoFixResponse,
  type UndoPaidRequest,
  type UpdateSettingsRequest,
  type UpdateTeamUserRequest,
  unarchiveJobsResponseSchema,
  undeliverResponseSchema,
  undoFixResponseSchema,
  voiceNoteType,
} from '@studio/shared';

/** A request that did not give a usable answer. */
export class ApiError extends Error {
  /** The HTTP status, or 0 when the server could not be reached at all. */
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Text for the cases where the server did not say anything readable. */
export const UNREACHABLE_MESSAGE = 'Cannot reach the Studio Engine server.';
export const UNREADABLE_MESSAGE = 'The server sent an answer this page does not understand.';
export const TIMEOUT_MESSAGE = "The engine didn't answer.";

/** How long a request may take, answer included, before it is given up on. The engine is local. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cancel answers only once the edit has stopped: the server sends SIGTERM and waits up to 10 s
 * before SIGKILL (KILL_GRACE_MS), then the run settles. So it gets more time than other requests.
 */
export const CANCEL_TIMEOUT_MS = 30_000;

/** A voice-note upload may take a while (up to 25 MB), so it gets more than REQUEST_TIMEOUT_MS. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/** What a Read pass does with the files of an upload (the server's `mode` field). */
export type StyleUploadMode = 'add' | 'replace';

/** The files of one upload to a client's style, and how to treat them. */
export interface StyleUpload {
  files: readonly File[];
  mode: StyleUploadMode;
  /** Told the share of the bytes sent so far (0 to 100). */
  onProgress?: (percent: number) => void;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** What W11 uploads: the recording (its Blob type is what the server checks) and where it is pinned. */
export interface VoiceNoteUpload {
  audio: Blob;
  atSec: number;
  audioSec: number;
  /** Generated videos: the id of the extra format the note is recorded on ("1x1"); left out, the main one. */
  format?: string | null;
}

/**
 * The part of the browser's `XMLHttpRequest` an upload uses (a `fetch` cannot report how much of a
 * body it has sent); a test passes a fake.
 */
export interface XhrLike {
  open(method: string, url: string): void;
  send(body: FormData): void;
  abort(): void;
  readonly status: number;
  readonly statusText: string;
  readonly responseText: string;
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onload: ((event: ProgressEvent) => void) | null;
  onerror: ((event: ProgressEvent) => void) | null;
  onabort: ((event: ProgressEvent) => void) | null;
}

export interface ApiOptions {
  /** Prefix for every path. Empty = same origin (the browser; Vite proxies `/api` in dev). */
  baseUrl?: string;
  /** Defaults to the global `fetch`, looked up at call time so a test can replace it. */
  fetch?: typeof fetch;
  /** Default {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The limit for Cancel, which answers only once the edit has stopped. Default {@link CANCEL_TIMEOUT_MS}. */
  cancelTimeoutMs?: number;
  /** The limit for a voice-note upload. Default {@link UPLOAD_TIMEOUT_MS}. */
  uploadTimeoutMs?: number;
  /** Makes the request of a style upload. Default: a new `XMLHttpRequest`. */
  createXhr?: () => XhrLike;
}

export interface Api {
  /** `GET /api/jobs`: every job, newest `updatedAt` first. */
  listJobs(signal?: AbortSignal): Promise<Job[]>;
  /**
   * `POST /api/jobs/:id/<action>`: the job after the action. Rejects with an `ApiError`: 404 for an
   * unknown job, 409 (with the server's explanation) when the state machine refuses.
   * `options.restorePlace` (release only) adds `?restore=1`: a job that was queued when it was held
   * goes back to the place it had in line.
   */
  runJobAction(
    id: string,
    action: JobAction,
    signal?: AbortSignal,
    options?: JobActionOptions,
  ): Promise<Job>;
  /**
   * `PUT /api/jobs/:id/note`: saves the whole note (the server trims it, and empty text clears it)
   * and returns the job. Rejects with an `ApiError`: 400 for a note over 4000 characters, 404 for
   * an unknown job, 409 (with the server's explanation) when the job's state forbids it.
   */
  saveNote(id: string, note: string, signal?: AbortSignal): Promise<Job>;
  /**
   * `PUT /api/jobs/:id/name`: renames the job: its folder, its export files and every record about
   * it move to the new name. Answers with the job under its new `id` (the old id is gone). Rejects
   * with an `ApiError`: 400 for a name a folder cannot have, 404 for an unknown job, 409 (with the
   * server's explanation) while the job is arriving, queued or editing, while the engine works in
   * its folder, or when a video of that name already exists.
   */
  renameJob(id: string, name: string, signal?: AbortSignal): Promise<Job>;
  /**
   * `PUT /api/jobs/:id/effort`: sets the effort level of the job's edit and revise runs (`null` is
   * Default: Extra high) and returns the job. Rejects with an `ApiError`: 400 for a level that does not
   * exist, 404 for an unknown job, 409 (with the server's explanation) when the job's state forbids it.
   */
  saveEffort(id: string, effort: Effort | null, signal?: AbortSignal): Promise<Job>;
  /**
   * `PUT /api/jobs/:id/review-effort` (Quick fixes): sets the effort of the job's review rounds
   * (`null` is Auto, a level makes every note wait for Send and run at it) and returns the job.
   * Rejects with an `ApiError`: 400 for a level that does not exist, 404 for an unknown job or while
   * the switch is off, 409 (with the server's explanation) unless the job is in Review.
   */
  saveReviewEffort(id: string, effort: Effort | null, signal?: AbortSignal): Promise<Job>;
  /**
   * `POST /api/jobs/archive`: archives these jobs (1 to 200, none twice): hidden from the lists,
   * nothing else about them changes (`updatedAt` stays). Answers with the jobs, in the order asked.
   * All or nothing. Rejects with an `ApiError`: 400 for a bad request, 404 for an unknown job, 409
   * (with the server's explanation) when a job is arriving, queued or editing; then nothing changed.
   */
  archiveJobs(ids: readonly string[], signal?: AbortSignal): Promise<Job[]>;
  /**
   * `POST /api/jobs/unarchive`: takes these jobs (1 to 200, none twice) out of the archive and
   * answers with the jobs, in the order asked. All or nothing. Rejects with an `ApiError`: 400 for a
   * bad request, 404 for an unknown job; then nothing changed.
   */
  unarchiveJobs(ids: readonly string[], signal?: AbortSignal): Promise<Job[]>;
  /**
   * `DELETE /api/jobs/:id`: deletes the job for good: its folder, export, log and every row about
   * it, the delivery and payment included. Also works for a delivered video whose folder is already
   * gone. Rejects with an `ApiError`: 404 for an unknown job.
   */
  deleteJob(id: string, signal?: AbortSignal): Promise<void>;
  /**
   * `POST /api/jobs/:id/deliver`: Mark delivered. The job, now with its `delivery` (the client's
   * price from that moment, not paid). Rejects with an `ApiError`: 404 for an unknown job, 409
   * (with the server's explanation) unless the job is ready and not delivered yet.
   */
  deliverJob(id: string, signal?: AbortSignal): Promise<Job>;
  /**
   * `POST /api/jobs/:id/undeliver`: Not delivered yet. The job, back to approved (`delivery` is
   * `null`). For a video whose folder is gone there is no job to go back to approved: the answer is
   * that video as a folder-deleted job (`orphanAsJob`) with `delivery` `null`, since its delivery
   * is deleted for good. Rejects with an `ApiError`: 404 for an unknown video, 409 (with the
   * server's explanation) unless it is delivered and not paid.
   */
  undeliverJob(id: string, signal?: AbortSignal): Promise<Job>;
  /**
   * `POST /api/payments`: Mark paid. One payment covers these delivered videos (1 to 200) and came
   * in on `paidOn` (`YYYY-MM-DD`); `amounts` is what was paid for each, by job id (one left out
   * was paid its price). Answers with the jobs, in the order asked; a video whose folder
   * is gone is a folder-deleted job (`orphanAsJob`) among them. All or nothing. Rejects with an
   * `ApiError`: 400 for a bad request, 404 for an unknown video, 409 (naming the videos that
   * stopped it) when any is not delivered or is paid already; then nothing changed.
   */
  markPaid(
    jobIds: readonly string[],
    paidOn: string,
    amounts?: Readonly<Record<string, number>>,
    signal?: AbortSignal,
  ): Promise<Job[]>;
  /**
   * `POST /api/payments/undo`: Not paid yet. Takes these paid videos (1 to 200) back to delivered
   * and answers with the jobs, in the order asked (a video whose folder is gone is a
   * folder-deleted job). All or nothing. Rejects with an `ApiError`: 400 for a bad request, 404
   * for an unknown video, 409 (naming the videos that stopped it) unless every one is paid; then
   * nothing changed.
   */
  undoPaid(jobIds: readonly string[], signal?: AbortSignal): Promise<Job[]>;
  /**
   * `GET /api/deliveries/unpaid-without-job`: the delivered videos that are not paid and whose job
   * is gone (its folder was deleted), newest delivery first. They are still payable.
   */
  listOrphanDeliveries(signal?: AbortSignal): Promise<OrphanDelivery[]>;
  /** `GET /api/health`: the server's version and the settle delay it runs with. */
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  /** `GET /api/me`: who the engine thinks is asking (their login, name and role). */
  getMe(signal?: AbortSignal): Promise<MeResponse>;
  /**
   * `GET /api/money?month=YYYY-MM`: everything the Money page shows for that month (the banners,
   * the ledger, the subscriptions and the expenses). Rejects with an `ApiError`: 400 for a month
   * that is not YYYY-MM.
   */
  getMoney(month: string, signal?: AbortSignal): Promise<MoneyResponse>;
  /**
   * `GET /api/money/price?client=<name>`: what Mark delivered would charge the client now, and the
   * month it would count in. Rejects with an `ApiError`: 400 for an empty client.
   */
  getMoneyPrice(client: string, signal?: AbortSignal): Promise<MoneyPriceResponse>;
  /**
   * `GET /api/analytics?period=week|month`: everything the Analytics page shows for that period.
   * Rejects with an `ApiError`: 404 while the Analytics switch is off on the engine.
   */
  getAnalytics(period: AnalyticsPeriod, signal?: AbortSignal): Promise<AnalyticsResponse>;
  /** `GET /api/jobs/:id/notes`: the unsent notes, by atSec. 409 outside Review. */
  listNotes(jobId: string, signal?: AbortSignal): Promise<ReviewNote[]>;
  /** `POST /api/jobs/:id/notes`: a text note (trimmed by the server). */
  addNote(jobId: string, note: AddNoteRequest, signal?: AbortSignal): Promise<ReviewNote>;
  /** `POST /api/jobs/:id/notes/voice`: multipart audio, atSec, audioSec; 60 s limit. The note comes back pending. */
  addVoiceNote(jobId: string, upload: VoiceNoteUpload, signal?: AbortSignal): Promise<ReviewNote>;
  /** `PATCH /api/jobs/:id/notes/:noteId`. */
  patchNote(
    jobId: string,
    noteId: string,
    patch: PatchNoteRequest,
    signal?: AbortSignal,
  ): Promise<ReviewNote>;
  /** `DELETE /api/jobs/:id/notes/:noteId`. */
  deleteNote(jobId: string, noteId: string, signal?: AbortSignal): Promise<void>;
  /** `GET /api/clients`: every client folder of the inbox, with jobs or without, sorted by name. */
  listClients(signal?: AbortSignal): Promise<ClientListResponse>;
  /**
   * `POST /api/clients`: makes the client's folder (and its `_Style`) and answers with its row.
   * Rejects with an `ApiError`: 400 with a plain message for a name that can't be used, 409 when
   * a folder with that name already exists.
   */
  createClient(name: string, signal?: AbortSignal): Promise<ClientRow>;
  /**
   * `POST /api/jobs/:id/review-time`: adds `sec` (a whole number, 1 to 60) to the time the owner has
   * spent in the Review dialog for the job, and answers with the new total in seconds. Rejects with
   * an `ApiError`: 404 for an unknown job, 409 unless the job is in review, 400 for a bad `sec`.
   */
  addReviewTime(jobId: string, sec: number, signal?: AbortSignal): Promise<number>;
  /**
   * `PUT /api/clients/:clientId/name` (admin only): renames the client, its folder, its exports and
   * its jobs, and answers its row under the new name. The client's id is new, and so are its jobs'.
   * Rejects with an `ApiError`: 400 for a name that can't be used, 404 for an unknown client, 409
   * while the engine works on one of its jobs, its style or a series, or for a name that is taken.
   */
  renameClient(clientId: string, name: string, signal?: AbortSignal): Promise<ClientRow>;
  /**
   * `DELETE /api/clients/:clientId` (admin only): deletes the client. Its folder and its exports go
   * to the Trash; its jobs, their payments, its series and its style are deleted. Rejects with an
   * `ApiError`: 404 for an unknown client, 409 while the engine works on one of its jobs, its style
   * or a series, or when a folder could not be moved.
   */
  deleteClient(clientId: string, signal?: AbortSignal): Promise<DeleteClientResponse>;
  /**
   * `POST /api/clients/:clientId/reveal`: Finder opens the client's folder. Rejects with an
   * `ApiError`: 404 for a client the engine does not know.
   */
  revealClient(clientId: string, signal?: AbortSignal): Promise<void>;
  /** `GET /api/team` (admin only): the team and each assigned client's editors. */
  getTeam(signal?: AbortSignal): Promise<TeamResponse>;
  /** `GET /api/settings` (admin only): the feature switches as the engine runs them and as they are saved. */
  getSettings(signal?: AbortSignal): Promise<SettingsResponse>;
  /**
   * `PUT /api/settings` (admin only): saves the switches in `patch` to config.json (they count
   * after a restart). Rejects with an `ApiError`: 409 for a switch an environment variable decides.
   */
  saveSettings(patch: UpdateSettingsRequest, signal?: AbortSignal): Promise<SettingsResponse>;
  /** `POST /api/settings/restart` (admin only): the engine restarts after it has answered. 409 when it cannot. */
  restartEngine(signal?: AbortSignal): Promise<void>;
  /**
   * `POST /api/team` (admin only): adds a person and answers them. Rejects with an `ApiError`:
   * 400 with the reason for a missing name or login, 409 when the login is on the team already.
   */
  addTeamUser(person: AddTeamUserRequest, signal?: AbortSignal): Promise<TeamUser>;
  /** `PUT /api/team/:email` (admin only): changes a person's name and/or role. 404 for someone not on the team. */
  updateTeamUser(
    email: string,
    patch: UpdateTeamUserRequest,
    signal?: AbortSignal,
  ): Promise<TeamUser>;
  /** `DELETE /api/team/:email` (admin only): removes a person and every assignment of theirs. */
  removeTeamUser(email: string, signal?: AbortSignal): Promise<void>;
  /**
   * `PUT /api/clients/:clientId/assignees` (admin only): replaces the editors of a client (an empty
   * list makes it admin-only). 404 for an unknown client; 400 for a login that is not an editor.
   */
  setClientAssignees(
    clientId: string,
    editors: readonly string[],
    signal?: AbortSignal,
  ): Promise<AssigneesResponse>;
  /**
   * `GET /api/jobs/:id/steps`: the job's timed step runs, oldest first (`runs` is empty for a job
   * that has not started). Rejects with an `ApiError`: 404 for an unknown job.
   */
  getJobSteps(id: string, signal?: AbortSignal): Promise<JobStepsResponse>;
  /**
   * `GET /api/jobs/:id/versions`: the job's preview versions (Cut 1, Cut 2, …), newest first; none
   * for a job from before versions. Rejects with an `ApiError`: 404 for an unknown job.
   */
  getJobVersions(id: string, signal?: AbortSignal): Promise<JobVersionsResponse>;
  /**
   * `POST /api/jobs/:id/versions/:n/restore`: puts version `n` back as the live preview and
   * answers with the job (still in Review, same round). Rejects with an `ApiError`: 404 for an
   * unknown job or a version it does not have, 409 (with the server's explanation) unless the job
   * is in Review, not archived, with no unsent notes.
   */
  restoreJobVersion(id: string, n: number, signal?: AbortSignal): Promise<Job>;
  /**
   * `POST /api/jobs/:id/reveal`: Finder shows the job's export MP4 selected (`revealed: 'file'`)
   * when it has one, else opens its folder (`'folder'`). Rejects with an `ApiError`: 404 for an
   * unknown job or a folder that is gone, 500 when Finder could not be asked.
   */
  revealJob(id: string, signal?: AbortSignal): Promise<RevealJobResponse>;
  /**
   * `GET /api/jobs/:id/sent-notes`: the review notes the job's rounds were sent with, by round and
   * then by where each is pinned (`notes` is empty for a job that has sent none). Answers in every
   * state of the job, unlike `getNotes` (the unsent notes, only in Review). Rejects with an
   * `ApiError`: 404 for an unknown job.
   */
  getSentNotes(id: string, signal?: AbortSignal): Promise<SentNotesResponse>;
  /**
   * `GET /api/jobs/:id/stock`: the sound effects and photos the job's runs took from Openverse and
   * Unsplash, with who made them and under what license (`items` is empty for a job that took none).
   * Answers in every state of the job and with the Stock switch off. Rejects with an `ApiError`: 404
   * for an unknown job.
   */
  getJobStock(id: string, signal?: AbortSignal): Promise<StockResponse>;
  /**
   * `GET /api/jobs/:id/feed` (Draft & chat, DR3): the job's chat, built from its log up to now.
   * Rejects with an `ApiError`: 404 for an unknown job, or while Draft & chat is off.
   */
  getJobFeed(id: string, signal?: AbortSignal): Promise<JobFeedResponse>;
  /**
   * `GET /api/clients/:id/style`: the client's style and its style.md (`markdown` is `null` while
   * there is none). Rejects with an `ApiError`: 404 for a client the engine does not know.
   */
  getClientStyle(clientId: string, signal?: AbortSignal): Promise<ClientStyleResponse>;
  /**
   * `POST /api/clients/:id/style/files`: sends the files (multipart `files[]` and `mode`) to be
   * read into the style, reporting progress as the bytes go. Answers the style, now analysing.
   * Rejects with an `ApiError`: 404 for an unknown client, 409 while the last files are still
   * being analysed, 413 above 2 GB together. There is no time limit: a big upload takes as long
   * as it takes.
   */
  uploadStyleFiles(clientId: string, upload: StyleUpload): Promise<ClientStyle>;
  /** `POST /api/clients/:id/style/retry`: runs the failed style run again. 409 unless it failed. */
  retryClientStyle(clientId: string, signal?: AbortSignal): Promise<ClientStyle>;
  /**
   * `POST /api/jobs/:id/use-look`: queues the Learn pass that makes the finished job its client's
   * style, and answers the client's style, now analysing. Rejects with an `ApiError`: 404 for an
   * unknown job, 409 (with the server's explanation) unless the job is ready or while the client
   * is analysing.
   */
  applyLook(jobId: string, signal?: AbortSignal): Promise<ClientStyle>;
  /**
   * `POST /api/clients/:id/style/undo`: puts the newest style kept in history back and answers the
   * client's style. Rejects with an `ApiError`: 404 for an unknown client, 409 (with the server's
   * explanation) when there is nothing to go back to or while the client is analysing.
   */
  undoClientStyle(clientId: string, signal?: AbortSignal): Promise<ClientStyle>;
  /**
   * `GET /api/jobs/:id/generate` (Generated videos): where the job's Generate stage stands, or
   * `null` for a job that has none (the server answers 404 for it, and for an unknown job, and
   * while the Generate switch is off). Rejects with an `ApiError` for anything else.
   */
  getJobGenerate(jobId: string, signal?: AbortSignal): Promise<GenerateState | null>;
  /**
   * `GET /api/jobs/:id/generate/history` (Generated videos, GN5): what the Generate stage did,
   * oldest first, which the job sheet's History puts among its rows. `[]` for a job with none (404,
   * also while the Generate switch is off). Rejects with an `ApiError` for anything else.
   */
  getGenerateHistory(jobId: string, signal?: AbortSignal): Promise<GenerateHistoryEvent[]>;
  /**
   * `GET /api/jobs/:id/generate/review-plan` (Generated videos, GN8): the clips of the cut with
   * their windows and what a new take of each costs, and the voice lines with their windows, which
   * the note hints in Review read. `null` for a job with no hand-off yet (404, also while the
   * Generate switch is off). Rejects with an `ApiError` for anything else.
   */
  getGenerateReviewPlan(jobId: string, signal?: AbortSignal): Promise<GenerateNotePlan | null>;
  /**
   * `GET /api/jobs/:id/music` (Soundtrack): the job's music (its record, whether Make another is
   * allowed now and the music's `rev`), or `null` for a job without music.json. Rejects with an
   * `ApiError`: 404 for an unknown job, and 404 "Music is off." while the Soundtrack switch is off.
   */
  getJobMusic(jobId: string, signal?: AbortSignal): Promise<MusicView | null>;
  /**
   * `POST /api/jobs/:id/music`: Make another, following the owner's words when there are any. Answers
   * (202) with the job's music, now making. Rejects with an `ApiError`: 400 for words over 200
   * characters, 404 for an unknown job or while the switch is off, 409 (with the server's
   * explanation) when it is not allowed now, 501 until SD2 builds it.
   */
  makeMusic(jobId: string, ask?: string, signal?: AbortSignal): Promise<MusicView>;
  /**
   * `PUT /api/jobs/:id/music/pick`: picks a version (`v2`) or `off` (No music) and answers with the
   * job's music. Rejects with an `ApiError`: 400 for an id that is neither, 404 for an unknown job or
   * while the switch is off, 409 (with the server's explanation) when it is not allowed now, 501
   * until SD2 builds it.
   */
  pickMusic(jobId: string, id: PickMusicRequest['id'], signal?: AbortSignal): Promise<MusicView>;
  /**
   * `GET /api/jobs/:id/no-song` (Songs): where the job's second file, the one without the song,
   * stands: `none`, `idle`, `making`, `failed` (with its message) or `ready` (with its name and when
   * it was made). Never starts a render. Rejects with an `ApiError`: 404 for an unknown job, and
   * 404 while the Songs switch is off.
   */
  getNoSong(jobId: string, signal?: AbortSignal): Promise<NoSongStatus>;
  /**
   * `POST /api/jobs/:id/no-song` (Songs): Try again. Starts making the file without the song when
   * it is `idle` or `failed` and answers its status (`making`, or `ready` when a current file
   * exists). Rejects with an `ApiError`: 404 for an unknown job or while the switch is off, 409
   * (with the server's explanation) for a job that has no such file to make.
   */
  retryNoSong(jobId: string, signal?: AbortSignal): Promise<NoSongStatus>;
  /**
   * `GET /api/jobs/:id/fixes` (Quick fixes): the quick fixes of the job's next round
   * (`job.round + 1`), oldest first, in every state of the job. Rejects with an `ApiError`: 404 for
   * an unknown job, and 404 "Quick fixes are off." while the switch is off.
   */
  getJobFixes(jobId: string, signal?: AbortSignal): Promise<QuickFix[]>;
  /**
   * `POST /api/jobs/:id/fixes/:fixId/undo`: takes a fixed note's fix back and answers with the fix,
   * now `undone`, and the job. Rejects with an `ApiError`: 404 for an unknown job or fix, and 409
   * (with the server's explanation) unless it is the newest fixed fix, while another fix is queued
   * or running, or when the job is not in Review.
   */
  undoFix(jobId: string, fixId: string, signal?: AbortSignal): Promise<UndoFixResponse>;
}

/** What an error says when its body did not: "The server answered 502 Bad Gateway.". */
function genericMessage(status: number, statusText: string): string {
  return `The server answered ${status}${statusText ? ` ${statusText}` : ''}.`;
}

/** The text of an error response: its `{ error }` body, or a generic line when there is none. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // Not JSON (a proxy's HTML page, an empty body): fall through to the generic text.
  }
  return genericMessage(response.status, response.statusText);
}

/** The text of a failed `XMLHttpRequest`, as {@link errorMessage} reads a failed `fetch`. */
function xhrErrorMessage(xhr: XhrLike): string {
  try {
    const parsed = apiErrorSchema.safeParse(JSON.parse(xhr.responseText));
    if (parsed.success) return parsed.data.error;
  } catch {
    // Not JSON: the generic text.
  }
  return genericMessage(xhr.status, xhr.statusText);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function notesPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/notes`;
}

function reviewTimePath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/review-time`;
}

function stylePath(clientId: string): string {
  return `/api/clients/${encodeURIComponent(clientId)}/style`;
}

function generatePath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/generate`;
}

function musicPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/music`;
}

function noSongPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/no-song`;
}

function fixesPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/fixes`;
}

/**
 * The videos of a payment, in the order they were asked for: the server answers the ones that
 * still have a job in `jobs` and the ones whose folder is gone in `orphans`; those become jobs
 * marked `folderDeleted`.
 */
function inOrderAsked(ids: readonly string[], { jobs, orphans }: PaymentResponse): Job[] {
  const byId = new Map<string, Job>([
    ...orphans.map((orphan) => [orphan.id, orphanAsJob(orphan)] as const),
    ...jobs.map((job) => [job.id, job] as const),
  ]);
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** A request with a JSON body. */
function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

/** The part of {@link ApiOptions} every JSON request needs. */
export type JsonClientOptions = Pick<ApiOptions, 'baseUrl' | 'fetch' | 'timeoutMs'>;

/**
 * What every typed wrapper is made of: `request` sends one request and answers its JSON body (or
 * throws an `ApiError`, as described at the top of this file), and `parse` runs a schema over it.
 * `createApi` is built on it, and so are the other API files (series-api.ts).
 */
export interface JsonClient {
  /** Sends `init` to `path` and answers the JSON body. `limitMs` replaces the time limit. */
  request(path: string, init: RequestInit, limitMs?: number): Promise<unknown>;
  /** Runs a schema over a body; a body that does not fit is an `ApiError`, not a ZodError. */
  parse<T>(schema: { parse(data: unknown): T }, body: unknown): T;
}

export function createJsonClient({
  baseUrl = '',
  fetch: fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: JsonClientOptions = {}): JsonClient {
  async function request(path: string, init: RequestInit, limitMs = timeoutMs): Promise<unknown> {
    // The caller's signal (a query being cancelled) and the timeout end the same fetch; whichever
    // fires first wins. The timeout keeps running while the body is read.
    const callerSignal = init.signal ?? undefined;
    const timeout = AbortSignal.timeout(limitMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

    /**
     * What a failed fetch or body read becomes. A cancelled request is the caller's doing, not a
     * failure: the abort goes through as it is. Next best explanation: the timeout (checked by the
     * signal, not by the error's name, which browsers do not all set the same way).
     */
    function failure(cause: unknown, otherwise: () => ApiError): unknown {
      if (callerSignal?.aborted) return cause;
      if (timeout.aborted) return new ApiError(0, TIMEOUT_MESSAGE, { cause });
      return isAbort(cause) ? cause : otherwise();
    }

    let response: Response;
    try {
      response = await (fetchImpl ?? fetch)(`${baseUrl}${path}`, { ...init, signal });
    } catch (cause) {
      throw failure(cause, () => new ApiError(0, UNREACHABLE_MESSAGE, { cause }));
    }
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    // 204 No Content (a push device deleted, a test push sent): there is no body to read.
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (cause) {
      throw failure(cause, () => new ApiError(response.status, UNREADABLE_MESSAGE, { cause }));
    }
  }

  /** Runs a schema over a body; a body that does not fit is an `ApiError`, not a ZodError. */
  function parse<T>(schema: { parse(data: unknown): T }, body: unknown): T {
    try {
      return schema.parse(body);
    } catch (cause) {
      throw new ApiError(200, UNREADABLE_MESSAGE, { cause });
    }
  }

  return { request, parse };
}

/** Sends a form; see {@link createFormSender}. */
export type FormSender = (
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * What sends a multipart form with an `XMLHttpRequest` (a `fetch` cannot report how much of a body
 * it has sent) and answers its JSON body. The same failures as a JSON request, except that there is
 * no time limit and `signal` (a cancel) rejects with an `AbortError`. `createApi` is built on it,
 * and so are the other API files that upload (graphics-api.ts).
 */
export function createFormSender({
  baseUrl = '',
  createXhr = () => new XMLHttpRequest(),
}: Pick<ApiOptions, 'baseUrl' | 'createXhr'> = {}): FormSender {
  return (path, form, onProgress, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const xhr = createXhr();
      const abort = () => xhr.abort();
      const finish = () => signal?.removeEventListener('abort', abort);
      xhr.open('POST', `${baseUrl}${path}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      };
      xhr.onload = () => {
        finish();
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiError(xhr.status, xhrErrorMessage(xhr)));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (cause) {
          reject(new ApiError(xhr.status, UNREADABLE_MESSAGE, { cause }));
        }
      };
      xhr.onerror = () => {
        finish();
        reject(new ApiError(0, UNREACHABLE_MESSAGE));
      };
      xhr.onabort = () => {
        finish();
        reject(signal?.reason ?? new DOMException('The upload was cancelled.', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      xhr.send(form);
    });
}

export function createApi({
  baseUrl = '',
  fetch: fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  cancelTimeoutMs = CANCEL_TIMEOUT_MS,
  uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
  createXhr = () => new XMLHttpRequest(),
}: ApiOptions = {}): Api {
  const { request, parse } = createJsonClient({ baseUrl, fetch: fetchImpl, timeoutMs });
  const sendForm = createFormSender({ baseUrl, createXhr });

  return {
    async listJobs(signal) {
      return parse(jobListResponseSchema, await request('/api/jobs', { signal }));
    },
    async runJobAction(id, action, signal, options = {}) {
      const restore = action === 'release' && options.restorePlace === true ? '?restore=1' : '';
      const path = `/api/jobs/${encodeURIComponent(id)}/${jobActionPath(action)}${restore}`;
      const limit = action === 'cancel' ? cancelTimeoutMs : timeoutMs;
      return parse(jobActionResponseSchema, await request(path, { method: 'POST', signal }, limit));
    },
    async saveNote(id, note, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/note`;
      const body: SaveNoteRequest = { note };
      const init: RequestInit = {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      };
      return parse(saveNoteResponseSchema, await request(path, init));
    },
    async renameJob(id, name, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/name`;
      const body: RenameJobRequest = { name };
      return parse(renameJobResponseSchema, await request(path, jsonInit('PUT', body, signal)));
    },
    async saveEffort(id, effort, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/effort`;
      const body: SaveEffortRequest = { effort };
      return parse(saveEffortResponseSchema, await request(path, jsonInit('PUT', body, signal)));
    },
    async saveReviewEffort(id, effort, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/review-effort`;
      const body: ReviewEffortRequest = { effort: effort ?? 'auto' };
      return parse(jobSchema, await request(path, jsonInit('PUT', body, signal)));
    },
    async archiveJobs(ids, signal) {
      const body: ArchiveJobsRequest = { ids: [...ids] };
      const answer = await request('/api/jobs/archive', jsonInit('POST', body, signal));
      return parse(archiveJobsResponseSchema, answer).jobs;
    },
    async unarchiveJobs(ids, signal) {
      const body: UnarchiveJobsRequest = { ids: [...ids] };
      const answer = await request('/api/jobs/unarchive', jsonInit('POST', body, signal));
      return parse(unarchiveJobsResponseSchema, answer).jobs;
    },
    async deleteJob(id, signal) {
      await request(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
    },
    async deliverJob(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/deliver`;
      return parse(deliverResponseSchema, await request(path, { method: 'POST', signal }));
    },
    async undeliverJob(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/undeliver`;
      const answer = parse(
        undeliverResponseSchema,
        await request(path, { method: 'POST', signal }),
      );
      // A video without a folder has no job to give back: its delivery is gone, which is what
      // `delivery: null` on a folder-deleted video says.
      return 'removed' in answer ? { ...orphanAsJob(answer.removed), delivery: null } : answer;
    },
    async markPaid(jobIds, paidOn, amounts, signal) {
      const body: MarkPaidRequest = {
        jobIds: [...jobIds],
        paidOn,
        ...(amounts === undefined ? {} : { amounts: { ...amounts } }),
      };
      const answer = await request('/api/payments', jsonInit('POST', body, signal));
      return inOrderAsked(jobIds, parse(paymentResponseSchema, answer));
    },
    async undoPaid(jobIds, signal) {
      const body: UndoPaidRequest = { jobIds: [...jobIds] };
      const answer = await request('/api/payments/undo', jsonInit('POST', body, signal));
      return inOrderAsked(jobIds, parse(paymentResponseSchema, answer));
    },
    async listOrphanDeliveries(signal) {
      const answer = await request('/api/deliveries/unpaid-without-job', { signal });
      return parse(orphanDeliveriesResponseSchema, answer).orphans;
    },
    async getHealth(signal) {
      return parse(healthResponseSchema, await request('/api/health', { signal }));
    },
    async getMe(signal) {
      return parse(meResponseSchema, await request('/api/me', { signal }));
    },
    async getMoney(month, signal) {
      const path = `/api/money?month=${encodeURIComponent(month)}`;
      return parse(moneyResponseSchema, await request(path, { signal }));
    },
    async getMoneyPrice(client, signal) {
      const path = `/api/money/price?client=${encodeURIComponent(client)}`;
      return parse(moneyPriceResponseSchema, await request(path, { signal }));
    },
    async getAnalytics(period, signal) {
      const path = `/api/analytics?period=${encodeURIComponent(period)}`;
      return parse(analyticsResponseSchema, await request(path, { signal }));
    },
    async listNotes(jobId, signal) {
      return parse(noteListResponseSchema, await request(notesPath(jobId), { signal }));
    },
    async addNote(jobId, note, signal) {
      return parse(
        noteResponseSchema,
        await request(notesPath(jobId), jsonInit('POST', note, signal)),
      );
    },
    async addVoiceNote(jobId, upload, signal) {
      const form = new FormData();
      const file = voiceNoteType(upload.audio.type) === 'audio/mp4' ? 'voice.m4a' : 'voice.webm';
      form.append('audio', upload.audio, file);
      form.append('atSec', String(upload.atSec));
      form.append('audioSec', String(upload.audioSec));
      if (upload.format !== undefined && upload.format !== null)
        form.append('format', upload.format);
      // No content-type: fetch adds multipart/form-data with its boundary.
      const init: RequestInit = { method: 'POST', body: form, signal };
      return parse(
        noteResponseSchema,
        await request(`${notesPath(jobId)}/voice`, init, uploadTimeoutMs),
      );
    },
    async patchNote(jobId, noteId, patch, signal) {
      const path = `${notesPath(jobId)}/${encodeURIComponent(noteId)}`;
      return parse(noteResponseSchema, await request(path, jsonInit('PATCH', patch, signal)));
    },
    async deleteNote(jobId, noteId, signal) {
      const path = `${notesPath(jobId)}/${encodeURIComponent(noteId)}`;
      parse(deleteNoteResponseSchema, await request(path, { method: 'DELETE', signal }));
    },
    async listClients(signal) {
      return parse(clientListResponseSchema, await request('/api/clients', { signal }));
    },
    async createClient(name, signal) {
      const body: CreateClientRequest = { name };
      return parse(
        createClientResponseSchema,
        await request('/api/clients', jsonInit('POST', body, signal)),
      );
    },
    async addReviewTime(jobId, sec, signal) {
      const body: ReviewTimeRequest = { sec };
      const init = jsonInit('POST', body, signal);
      const answer = parse(reviewTimeResponseSchema, await request(reviewTimePath(jobId), init));
      return answer.reviewSec;
    },
    async renameClient(clientId, name, signal) {
      const path = `/api/clients/${encodeURIComponent(clientId)}/name`;
      const body: RenameClientRequest = { name };
      return parse(renameClientResponseSchema, await request(path, jsonInit('PUT', body, signal)));
    },
    async deleteClient(clientId, signal) {
      const path = `/api/clients/${encodeURIComponent(clientId)}`;
      return parse(deleteClientResponseSchema, await request(path, { method: 'DELETE', signal }));
    },
    async revealClient(clientId, signal) {
      const path = `/api/clients/${encodeURIComponent(clientId)}/reveal`;
      parse(revealClientResponseSchema, await request(path, { method: 'POST', signal }));
    },
    async getTeam(signal) {
      return parse(teamResponseSchema, await request('/api/team', { signal }));
    },
    async getSettings(signal) {
      return parse(settingsResponseSchema, await request('/api/settings', { signal }));
    },
    async saveSettings(patch, signal) {
      const answer = await request('/api/settings', jsonInit('PUT', patch, signal));
      return parse(settingsResponseSchema, answer);
    },
    async restartEngine(signal) {
      await request('/api/settings/restart', { method: 'POST', signal });
    },
    async addTeamUser(person, signal) {
      const answer = await request('/api/team', jsonInit('POST', person, signal));
      return parse(teamUserSchema, answer);
    },
    async updateTeamUser(email, patch, signal) {
      const path = `/api/team/${encodeURIComponent(email)}`;
      return parse(teamUserSchema, await request(path, jsonInit('PUT', patch, signal)));
    },
    async removeTeamUser(email, signal) {
      await request(`/api/team/${encodeURIComponent(email)}`, { method: 'DELETE', signal });
    },
    async setClientAssignees(clientId, editors, signal) {
      const path = `/api/clients/${encodeURIComponent(clientId)}/assignees`;
      const body: SetAssigneesRequest = { editors: [...editors] };
      return parse(assigneesResponseSchema, await request(path, jsonInit('PUT', body, signal)));
    },
    async getJobSteps(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/steps`;
      return parse(jobStepsResponseSchema, await request(path, { signal }));
    },
    async getJobVersions(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/versions`;
      return parse(jobVersionsResponseSchema, await request(path, { signal }));
    },
    async restoreJobVersion(id, n, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/versions/${n}/restore`;
      return parse(jobActionResponseSchema, await request(path, { method: 'POST', signal }));
    },
    async revealJob(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/reveal`;
      return parse(revealJobResponseSchema, await request(path, { method: 'POST', signal }));
    },
    async getSentNotes(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/sent-notes`;
      return parse(sentNotesResponseSchema, await request(path, { signal }));
    },
    async getJobStock(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/stock`;
      return parse(stockResponseSchema, await request(path, { signal }));
    },
    async getJobFeed(id, signal) {
      const path = `/api/jobs/${encodeURIComponent(id)}/feed`;
      return parse(jobFeedResponseSchema, await request(path, { signal }));
    },
    async getClientStyle(clientId, signal) {
      return parse(clientStyleResponseSchema, await request(stylePath(clientId), { signal }));
    },
    async uploadStyleFiles(clientId, { files, mode, onProgress, signal }) {
      const form = new FormData();
      form.append('mode', mode);
      for (const file of files) form.append('files[]', file, file.name);
      const path = `${stylePath(clientId)}/files`;
      return parse(clientStyleSchema, await sendForm(path, form, onProgress, signal));
    },
    async retryClientStyle(clientId, signal) {
      const path = `${stylePath(clientId)}/retry`;
      return parse(clientStyleSchema, await request(path, { method: 'POST', signal }));
    },
    async applyLook(jobId, signal) {
      const path = `/api/jobs/${encodeURIComponent(jobId)}/use-look`;
      return parse(clientStyleSchema, await request(path, { method: 'POST', signal }));
    },
    async undoClientStyle(clientId, signal) {
      const path = `${stylePath(clientId)}/undo`;
      return parse(clientStyleSchema, await request(path, { method: 'POST', signal }));
    },
    async getJobGenerate(jobId, signal) {
      try {
        return parse(generateResponseSchema, await request(generatePath(jobId), { signal }));
      } catch (error) {
        // No Generate stage (not a generated video, no such job, or the switch is off).
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    async getGenerateHistory(jobId, signal) {
      try {
        const response = parse(
          generateHistoryResponseSchema,
          await request(`${generatePath(jobId)}/history`, { signal }),
        );
        return response.events;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }
    },
    async getGenerateReviewPlan(jobId, signal) {
      try {
        return parse(
          generateNotePlanSchema,
          await request(`${generatePath(jobId)}/review-plan`, { signal }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    async getJobMusic(jobId, signal) {
      return parse(musicResponseSchema, await request(musicPath(jobId), { signal }));
    },
    async makeMusic(jobId, ask, signal) {
      const body: MakeMusicRequest = ask === undefined ? {} : { ask };
      return parse(
        musicViewSchema,
        await request(musicPath(jobId), jsonInit('POST', body, signal)),
      );
    },
    async pickMusic(jobId, id, signal) {
      const body: PickMusicRequest = { id };
      const path = `${musicPath(jobId)}/pick`;
      return parse(musicViewSchema, await request(path, jsonInit('PUT', body, signal)));
    },
    async getNoSong(jobId, signal) {
      return parse(noSongStatusSchema, await request(noSongPath(jobId), { signal }));
    },
    async retryNoSong(jobId, signal) {
      return parse(
        noSongStatusSchema,
        await request(noSongPath(jobId), { method: 'POST', signal }),
      );
    },
    async getJobFixes(jobId, signal) {
      return parse(jobFixesResponseSchema, await request(fixesPath(jobId), { signal })).fixes;
    },
    async undoFix(jobId, fixId, signal) {
      const path = `${fixesPath(jobId)}/${encodeURIComponent(fixId)}/undo`;
      return parse(undoFixResponseSchema, await request(path, { method: 'POST', signal }));
    },
  };
}

/** The app's client: same origin. Hooks use this one; tests build their own with `createApi`. */
export const api: Api = createApi();

/**
 * Where the finished video of a `ready` job downloads from. A plain link target (`<a href download>`),
 * no fetch: the browser streams the file itself. `baseUrl` is only for tests.
 */
export function downloadUrl(id: string, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(id)}/download`;
}

/**
 * Where one format's file of a job with more than one downloads from (`id` is the format's id,
 * "1x1"; Generated videos, GN7): the same route as {@link downloadUrl} with `?format=`. The engine
 * names the file `<Job>.mp4` for the main format and `<Job> (1x1).mp4` for the others.
 */
export function formatDownloadUrl(id: string, formatId: string, baseUrl = ''): string {
  return `${downloadUrl(id, baseUrl)}?format=${encodeURIComponent(formatId)}`;
}

/**
 * Where the second file of a job with a song, the one without the song ("Demo 2 · no song.mp4"),
 * downloads from (Songs). Like {@link downloadUrl} a plain link target; the engine answers 404 until
 * the file exists, and ignores the query while the Songs switch is off. `baseUrl` is only for tests.
 */
export function noSongDownloadUrl(id: string, baseUrl = ''): string {
  return `${downloadUrl(id, baseUrl)}?file=no-song`;
}

/**
 * Where a finished job's still comes from: one JPEG frame of its export (404 with no export). A
 * plain `<img src>`, no fetch. `baseUrl` is only for tests.
 */
export function stillUrl(jobId: string, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/still`;
}

/**
 * Where the live preview of a job loads from: its root composition, edit/preview/index.html.
 * Its assets load from relative paths under the same folder. `?r=<round>` changes with every
 * review round, so the player loads the new round instead of reusing the old page. `musicRev`
 * (Soundtrack: the job's music `rev`) adds `&m=<rev>`, which changes whenever edit/preview/music.mp3
 * does, so the player loads the new music; left out (or `null`) the URL is what it always was. A
 * plain URL for the player, no fetch. `baseUrl` is only for tests.
 *
 * `fixRev` (Quick fixes: the newest `endedAt` in ms among the round's fixes that are fixed or
 * undone) adds `&f=<rev>` after it, which changes whenever a fix lands or is taken back, so the
 * player loads the changed composition; left out (or `null`) the URL is what it always was.
 *
 * With `version` (Plane VE3) it is that preview version's root composition instead
 * (`GET /api/jobs/:id/versions/:n/preview/index.html`): a frozen copy of edit/preview/ with its own
 * music.mp3, loaded by the same relative paths. Its files do not change, so it carries no round, no
 * music rev and no fix rev (`musicRev` and `fixRev` are ignored).
 *
 * `formatId` (Generated videos, GN8) is an extra format's id ("1x1"): then it is that format's
 * composition, `…/preview/1x1/index.html`, with the same query. Left out, `null` or the main
 * format's address, it is the URL it always was (the main format needs no id; pass `null` for it).
 */
export function previewUrl(
  jobId: string,
  round: number,
  musicRev?: number | null,
  baseUrl = '',
  version?: number | null,
  fixRev?: number | null,
  formatId?: string | null,
): string {
  const job = `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`;
  if (version !== undefined && version !== null) {
    return `${job}/versions/${version}/preview/index.html`;
  }
  const music = musicRev === undefined || musicRev === null ? '' : `&m=${musicRev}`;
  const fix = fixRev === undefined || fixRev === null ? '' : `&f=${fixRev}`;
  const folder =
    formatId === undefined || formatId === null
      ? 'preview'
      : `preview/${encodeURIComponent(formatId)}`;
  return `${job}/${folder}/index.html?r=${round}${music}${fix}`;
}

/**
 * Where one picture of a job's chat is (Draft & chat): `GET /api/jobs/:id/feed/img/:name`, the
 * picture as Claude saw it. A plain `<img src>`, no fetch. `baseUrl` is only for tests.
 */
export function feedPictureUrl(jobId: string, name: string, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/feed/img/${encodeURIComponent(name)}`;
}

/**
 * The fix rev an address was made with (`&f=<rev>` of {@link previewUrl} or
 * {@link previewVideoUrl}); `null` for one without. Two addresses with the same rev show the same
 * fixes, so the player that first carries a new rev is the one that shows a fix that has just landed.
 */
export function previewFixRev(src: string): number | null {
  const found = /[?&]f=(\d+)(?:&|$)/.exec(src);
  return found?.[1] === undefined ? null : Number(found[1]);
}

/**
 * Where the live preview's poster comes from: one JPEG of its first frame (404 with no preview or
 * no video in it). `?r=<round>` changes with every review round, like {@link previewUrl}. A plain
 * `<img src>`, no fetch. `baseUrl` is only for tests.
 */
export function previewPosterUrl(jobId: string, round: number, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/preview-poster?r=${round}`;
}

/**
 * The small MP4 of a job's preview, for the phone: its status (`{ state: 'making' | 'ready' |
 * 'failed' }`, and asking starts the render) and the file (`download` saves it instead of playing
 * it). `?r=<round>` changes with every review round. Plain URLs, no fetch here.
 */
export function previewVideoStatusUrl(jobId: string, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/preview-video`;
}

export function previewVideoUrl(
  jobId: string,
  round: number,
  {
    download = false,
    musicRev,
    fixRev,
    baseUrl = '',
  }: { download?: boolean; musicRev?: number; fixRev?: number; baseUrl?: string } = {},
): string {
  // `&m=<rev>` (Soundtrack): the MP4 is rendered again with the new music.mp3 after a music change.
  const music = musicRev === undefined ? '' : `&m=${musicRev}`;
  // `&f=<rev>` (Quick fixes): and again with the composition a fix changed.
  const fix = fixRev === undefined ? '' : `&f=${fixRev}`;
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/preview-video.mp4?r=${round}${music}${fix}${download ? '&download=1' : ''}`;
}

/**
 * The full-quality MP4 of a job in Review (Export MP4): `POST` starts the render and answers its
 * status (`making`, `ready`, `failed` with a message, `idle`); `GET` only answers the status; the
 * file is downloaded as `<job>.mp4`. `?r=<round>` changes with every review round.
 *
 * `formatId` (Formats, C65) is an extra format's id ("1x1") on a job with two formats: then it is
 * that format's own export (`?format=1x1`), saved as `<job> (1x1).mp4`. Left out or `null` it is the
 * main format's, the address it always was (the main format needs no id).
 */
export function reviewExportUrl(jobId: string, baseUrl = '', formatId?: string | null): string {
  const format =
    formatId === undefined || formatId === null ? '' : `?format=${encodeURIComponent(formatId)}`;
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/review-export${format}`;
}

export function reviewExportFileUrl(
  jobId: string,
  round: number,
  baseUrl = '',
  formatId?: string | null,
): string {
  const format =
    formatId === undefined || formatId === null ? '' : `&format=${encodeURIComponent(formatId)}`;
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/review-export.mp4?r=${round}${format}`;
}

/** What {@link sendReviewTimeLast} needs of the browser; a test passes fakes. */
export interface LastSendOptions {
  /** Prefix for the path. Empty = same origin. */
  baseUrl?: string;
  /** Default `navigator.sendBeacon`, when the browser has it. */
  sendBeacon?: ((url: string, data: Blob) => boolean) | null;
  /** The fallback when there is no beacon, or it refused: default the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Sends `sec` seconds of review time (`POST /api/jobs/:id/review-time`) in a way that survives the
 * page going away: `navigator.sendBeacon` when the browser has it, else a `fetch` with `keepalive`.
 * Fire and forget: nothing is awaited, nothing is parsed and nothing is thrown, so the answer (or
 * a refusal, or no answer) is never seen. The body is JSON sent as `text/plain`, which a beacon can
 * send to any origin without a preflight; the server reads it as JSON either way.
 */
export function sendReviewTimeLast(
  jobId: string,
  sec: number,
  {
    baseUrl = '',
    sendBeacon = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon.bind(navigator)
      : null,
    fetch: fetchImpl,
  }: LastSendOptions = {},
): void {
  const url = `${baseUrl}${reviewTimePath(jobId)}`;
  const body = JSON.stringify({ sec } satisfies ReviewTimeRequest);
  try {
    if (sendBeacon?.(url, new Blob([body], { type: 'text/plain;charset=utf-8' })) === true) return;
    (fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Not sent, and nobody is told: the review time is bookkeeping.
  }
}

/**
 * Where a voice note's recording plays from (an `<audio src>`, no fetch). `baseUrl` is only for
 * tests.
 */
export function noteAudioUrl(jobId: string, noteId: string, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/notes/${encodeURIComponent(noteId)}/audio`;
}
