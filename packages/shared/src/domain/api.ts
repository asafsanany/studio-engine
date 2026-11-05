import { z } from 'zod';
import { effortSchema } from './effort.ts';
import { formatIdSchema } from './formats.ts';
import { jobSchema } from './job.ts';
import { calendarDaySchema } from './money.ts';
import { orphanDeliverySchema } from './orphan-delivery.ts';
import { reviewNoteSchema } from './review-note.ts';
import { seriesSchema, seriesSummarySchema } from './series.ts';

/** `GET /api/jobs`: the full list; the client sorts, filters and paginates. */
export const jobListResponseSchema = z.array(jobSchema);
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

/** `POST /api/jobs/:id/{start|hold|release|cancel|resume|retry|send-notes|approve}`: the job after the action. */
export const jobActionResponseSchema = jobSchema;
export type JobActionResponse = z.infer<typeof jobActionResponseSchema>;

/**
 * `PUT /api/jobs/:id/note` body: the whole note, replacing the old one. The server trims it and
 * stores empty text as no note (`null`); see `canEditNote` and `NOTE_MAX_LENGTH`.
 */
export const saveNoteRequestSchema = z.object({ note: z.string() });
export type SaveNoteRequest = z.infer<typeof saveNoteRequestSchema>;

/** `PUT /api/jobs/:id/note`: the job with its new note. */
export const saveNoteResponseSchema = jobSchema;
export type SaveNoteResponse = z.infer<typeof saveNoteResponseSchema>;

/**
 * `PUT /api/jobs/:id/effort` body: the job's effort level, or `null` for Default (Extra high). See
 * `canEditEffort`.
 */
export const saveEffortRequestSchema = z.object({ effort: effortSchema.nullable() });
export type SaveEffortRequest = z.infer<typeof saveEffortRequestSchema>;

/** `PUT /api/jobs/:id/effort`: the job with its new effort. */
export const saveEffortResponseSchema = jobSchema;
export type SaveEffortResponse = z.infer<typeof saveEffortResponseSchema>;

/** The most jobs one archive or unarchive request may name. */
export const ARCHIVE_MAX_IDS = 200;

/**
 * `POST /api/jobs/archive` and `POST /api/jobs/unarchive` body: the jobs to act on, 1 to
 * {@link ARCHIVE_MAX_IDS} ids, none twice. It is all or nothing: one job that is unknown (404) or
 * cannot be archived (409, see `canArchive`) and no job changes.
 */
export const archiveJobsRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(ARCHIVE_MAX_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'Each job can be named only once.'),
});
export type ArchiveJobsRequest = z.infer<typeof archiveJobsRequestSchema>;

/** `POST /api/jobs/archive`: the jobs after archiving, in the order of the request. */
export const archiveJobsResponseSchema = z.object({ jobs: z.array(jobSchema) });
export type ArchiveJobsResponse = z.infer<typeof archiveJobsResponseSchema>;

/** `POST /api/jobs/unarchive` body: the same as {@link archiveJobsRequestSchema}. */
export const unarchiveJobsRequestSchema = archiveJobsRequestSchema;
export type UnarchiveJobsRequest = ArchiveJobsRequest;

/** `POST /api/jobs/unarchive`: the jobs after unarchiving, in the order of the request. */
export const unarchiveJobsResponseSchema = archiveJobsResponseSchema;
export type UnarchiveJobsResponse = ArchiveJobsResponse;

/** The most seconds one `POST /api/jobs/:id/review-time` may add: the Review dialog sends every 15 s. */
export const REVIEW_TIME_MAX_SEC = 60;

/**
 * `POST /api/jobs/:id/review-time` body: whole seconds the owner spent in the Review dialog since the
 * last send, 1 to {@link REVIEW_TIME_MAX_SEC}. The server adds them to the job's review time.
 */
export const reviewTimeRequestSchema = z.object({
  sec: z.number().int().min(1).max(REVIEW_TIME_MAX_SEC),
});
export type ReviewTimeRequest = z.infer<typeof reviewTimeRequestSchema>;

/** `POST /api/jobs/:id/review-time`: the job's review time in seconds, all rounds together. */
export const reviewTimeResponseSchema = z.object({ reviewSec: z.number().int().nonnegative() });
export type ReviewTimeResponse = z.infer<typeof reviewTimeResponseSchema>;

/**
 * `GET /api/health`. `settleMs` is the settle delay the server runs with (`STUDIO_SETTLE_MS`), so
 * the page can run the same Release rule as the server for its instant update. `series` is the
 * Series switch (`series` in config.json, or `STUDIO_SERIES`): while it is off the page shows
 * nothing of series and every series route answers 404 {@link SERIES_MESSAGES}.off. `jobSheet` is
 * the Job sheet switch (`jobSheet` in config.json, or `STUDIO_JOB_SHEET`): while it is off a click
 * on a job row opens nothing and `?job=` in the address is ignored. `analytics` is the Analytics
 * switch (`analytics` in config.json, or `STUDIO_ANALYTICS`): while it is off the sidebar item
 * stays the disabled "coming in a later phase" one, `/analytics` shows Not found and
 * `/api/analytics` does not exist.
 * `phone` is the Phone switch (`phone` in config.json, or `STUDIO_PHONE`): while it is off the app
 * has no phone layout, at any width. `graphics` is the Graphics switch (`graphics` in config.json,
 * or `STUDIO_GRAPHICS`): while it is off there is no Graphics item in the sidebar, `/graphics`
 * shows Not found and every `/api/graphics` route answers 404 "Graphics are off.".
 * `graphicsInEdits` is the switch that lets edits use the library (`graphicsInEdits`, or
 * `STUDIO_GRAPHICS_IN_EDITS`): while it is off no edit sees the graphics and Details hides "Used in".
 * `music` is the Soundtrack switch (`music` in config.json, or `STUDIO_MUSIC`): while it is off
 * there is no Music button or Music row and every `/api/jobs/:id/music` route answers 404
 * "Music is off.".
 * `luts` is the LUTs switch (`luts` in config.json, or `STUDIO_LUTS`): while it is off there is no
 * LUTs item in the sidebar, `/luts` shows Not found and every `/api/luts` route answers 404
 * "LUTs are off.". `lutsInEdits` is the switch that lets notes name a LUT (`lutsInEdits`, or
 * `STUDIO_LUTS_IN_EDITS`, on by default): while it is off there is no @ picker for LUTs and runs
 * ignore LUT tokens.
 * `fonts` is the Fonts switch (`fonts` in config.json, or `STUDIO_FONTS`): while it is off there is
 * no Fonts item in the sidebar, `/fonts` shows Not found and every `/api/fonts` route answers 404
 * "Fonts are off.". `fontsInNotes` is the switch that lets notes name a font (`fontsInNotes`, or
 * `STUDIO_FONTS_IN_NOTES`): while it is off there is no font group in the @ picker, runs ignore
 * font tokens and Review shows no live font preview.
 * `quickFixes` is the Quick fixes switch (`quickFixes` in config.json, or `STUDIO_QUICK_FIXES`),
 * on by default since the feature shipped (`STUDIO_QUICK_FIXES=0` turns it off): while it is off
 * there is no Auto effort, no sorting of notes and no fix in Review, every fix route answers 404
 * {@link FIX_MESSAGES}.off, and Review is exactly as before.
 * `songs` is the Songs switch (`songs` in config.json, or `STUDIO_SONGS`), already combined with
 * `music`: it is true only when both are on. On by default since U22 (`STUDIO_SONGS=0` turns it
 * off); off, nothing of Songs shows or happens. It is optional, unlike the other switches, so a
 * stand-in or an engine from before Songs still parses; absent means off.
 * `generate` is the Generate switch (`generate` in config.json, or `STUDIO_GENERATE`): off (the
 * default until GN11) nothing of Generated videos shows or happens and `/api/jobs/:id/generate`
 * does not exist. Optional like `songs`, for the same reason; absent means off.
 * `draftChat` is the Draft & chat switch (`draftChat` in config.json, or `STUDIO_DRAFT_CHAT`): off
 * (the default) Review keeps its notes column and `/api/jobs/:id/feed` does not exist; on, Review is
 * the job's chat. Optional like `songs`; absent means off.
 * `instagram` is the Clients × Instagram switch (`instagram` in config.json, or `STUDIO_INSTAGRAM`):
 * on by default since the acceptance run (IG15; `STUDIO_INSTAGRAM=0` turns it off); off, there is no
 * Instagram scan, section, menu item or photo avatar and every Instagram route answers 404
 * {@link INSTAGRAM_MESSAGES}.off. Optional like `songs`; absent means off.
 */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string().min(1),
  settleMs: z.number().int().min(0),
  series: z.boolean(),
  jobSheet: z.boolean(),
  analytics: z.boolean(),
  phone: z.boolean(),
  graphics: z.boolean(),
  graphicsInEdits: z.boolean(),
  music: z.boolean(),
  luts: z.boolean(),
  lutsInEdits: z.boolean(),
  fonts: z.boolean(),
  fontsInNotes: z.boolean(),
  quickFixes: z.boolean(),
  songs: z.boolean().optional(),
  generate: z.boolean().optional(),
  draftChat: z.boolean().optional(),
  instagram: z.boolean().optional(),
  /** The Instagram DMs page exists (`/api/dms`); absent from an engine from before it. */
  dms: z.boolean().optional(),
  /** The symbol money is shown with (`currencySymbol` in config.json). */
  currencySymbol: z.string().optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * `POST /api/jobs/:id/notes` body: a text note. The server trims `text` and allows 1–2000
 * characters. `format` (Generated videos) is the format of the preview it was written on: the `id`
 * of one of the job's `formats`; left out or `null` it is the main format.
 */
export const addNoteRequestSchema = z.object({
  atSec: z.number().nonnegative(),
  text: z.string(),
  format: formatIdSchema.nullish(),
});
export type AddNoteRequest = z.infer<typeof addNoteRequestSchema>;

/**
 * `PATCH /api/jobs/:id/notes/:noteId` body: at least one of the three. `text` only for a text
 * note, `addToSeries` only for a note on an episode (Series plan §6).
 */
export const patchNoteRequestSchema = z
  .object({
    text: z.string().optional(),
    addToStyle: z.boolean().optional(),
    addToSeries: z.boolean().optional(),
  })
  .refine(
    (patch) =>
      patch.text !== undefined || patch.addToStyle !== undefined || patch.addToSeries !== undefined,
  );
export type PatchNoteRequest = z.infer<typeof patchNoteRequestSchema>;

/** `GET /api/jobs/:id/notes`: the unsent notes, by atSec. */
export const noteListResponseSchema = z.array(reviewNoteSchema);
export type NoteListResponse = z.infer<typeof noteListResponseSchema>;

/** `POST /api/jobs/:id/notes`, `POST …/notes/voice` and `PATCH …/notes/:noteId`: the note. */
export const noteResponseSchema = reviewNoteSchema;
export type NoteResponse = z.infer<typeof noteResponseSchema>;

/** `DELETE /api/jobs/:id/notes/:noteId`. */
export const deleteNoteResponseSchema = z.object({ ok: z.literal(true) });
export type DeleteNoteResponse = z.infer<typeof deleteNoteResponseSchema>;

/**
 * Every error response: 404 for an unknown job, 409 when the state machine refuses an action, the
 * note cannot be edited in the job's state, or notes cannot be changed or sent (not in Review, no
 * notes to send, a voice note still being transcribed, unsent notes at Approve, a job that cannot
 * be marked delivered or paid), 400 for a note that is not text, is too long or is a bad recording
 * or a payment body that does not fit, 413 for a voice note over 25 MB. The series routes answer
 * with {@link SERIES_MESSAGES} (422 for a series name that can't be used).
 */
export const apiErrorSchema = z.object({ error: z.string().min(1) });
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * `POST /api/jobs/:id/deliver` (Phase 4 §3): the job after the change, with its `delivery` set. No
 * body.
 */
export const deliverResponseSchema = jobSchema;
export type DeliverResponse = z.infer<typeof deliverResponseSchema>;

/**
 * `POST /api/jobs/:id/undeliver`: the job after the change, back to approved (`delivery` is
 * `null`). For a video whose folder is gone there is no job to give back: the delivery is deleted
 * and the answer is `{ removed }`, the delivery that was taken off (CVP-204).
 */
export const undeliverResponseSchema = z.union([
  jobSchema,
  z.object({ removed: orphanDeliverySchema }),
]);
export type UndeliverResponse = z.infer<typeof undeliverResponseSchema>;

/**
 * Why `POST /api/jobs/:id/undeliver` turned a video down with a reason the page can name: `uploaded`
 * (a reel is linked to the video: unlink it on the client page first). The other 409s of that route
 * (not delivered, paid already) are a plain {@link apiErrorSchema}.
 */
export const UNDELIVER_REFUSAL_REASONS = ['uploaded'] as const;
export const undeliverRefusedResponseSchema = apiErrorSchema.extend({
  reason: z.enum(UNDELIVER_REFUSAL_REASONS),
});
export type UndeliverRefusedResponse = z.infer<typeof undeliverRefusedResponseSchema>;

/** The most videos one payment (`POST /api/payments`, `…/undo`) may cover. */
export const PAYMENT_JOBS_MAX = 200;

/** The jobs of a payment: 1 to {@link PAYMENT_JOBS_MAX} ids, none twice. */
const paymentJobIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(PAYMENT_JOBS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'must not list a job twice');

/**
 * `POST /api/payments` body: the delivered videos one payment covers, the calendar day the money
 * came in, and, optionally, what was paid for each video (by job id, in the currency it was
 * delivered at; it can be 0). A video `amounts` leaves out was paid its price. All or nothing: a
 * job that is not delivered, or is paid already, refuses the lot.
 */
export const markPaidRequestSchema = z
  .object({
    jobIds: paymentJobIdsSchema,
    paidOn: calendarDaySchema,
    amounts: z.record(z.string(), z.number().nonnegative().finite()).optional(),
  })
  .refine(
    ({ jobIds, amounts }) => Object.keys(amounts ?? {}).every((id) => jobIds.includes(id)),
    'amounts must be for videos the payment covers',
  );
export type MarkPaidRequest = z.infer<typeof markPaidRequestSchema>;

/** `POST /api/payments/undo` body: the paid videos to take back to Delivered. All or nothing. */
export const undoPaidRequestSchema = z.object({ jobIds: paymentJobIdsSchema });
export type UndoPaidRequest = z.infer<typeof undoPaidRequestSchema>;

/**
 * `POST /api/payments` and `POST /api/payments/undo`: every video of the request, as it is now. A
 * video that still has its job is in `jobs`, a delivered video whose folder is gone (CVP-204) in
 * `orphans`; each list keeps the order asked.
 */
export const paymentResponseSchema = z.object({
  jobs: z.array(jobSchema),
  orphans: z.array(orphanDeliverySchema),
});
export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

/**
 * `GET /api/deliveries/unpaid-without-job`: the delivered videos that are not paid and whose job
 * is gone (its folder was deleted), newest delivery first. They are still payable (CVP-204); a
 * paid one is only in the Money Ledger.
 */
export const orphanDeliveriesResponseSchema = z.object({ orphans: z.array(orphanDeliverySchema) });
export type OrphanDeliveriesResponse = z.infer<typeof orphanDeliveriesResponseSchema>;

/**
 * Why a job stopped a payment change: `not-delivered` (no delivery), `already-paid` (Mark paid) or
 * `not-paid` (Not paid yet).
 */
export const PAYMENT_REFUSAL_REASONS = ['not-delivered', 'already-paid', 'not-paid'] as const;
export const paymentRefusalSchema = z.object({
  jobId: z.string().min(1),
  reason: z.enum(PAYMENT_REFUSAL_REASONS),
});
export type PaymentRefusal = z.infer<typeof paymentRefusalSchema>;

/**
 * The 409 of `POST /api/payments` and `POST /api/payments/undo`: an {@link apiErrorSchema} body
 * that also names every job that was in the wrong stage. Nothing was changed.
 */
export const paymentRefusedResponseSchema = apiErrorSchema.extend({
  refused: z.array(paymentRefusalSchema).min(1),
});
export type PaymentRefusedResponse = z.infer<typeof paymentRefusedResponseSchema>;

// --- series (Series plan §5) ------------------------------------------------------------------
//
//   GET  /api/clients/:clientId/series   the client's series                    200 { series }
//   GET  /api/series/:seriesId           the series and its series.md           200 { series, markdown }
//   POST /api/jobs/:jobId/series         Start a series { name }                202 { series }
//   POST /api/series/:seriesId/format    Use as the series format { jobId }     202 { series }
//   PUT  /api/jobs/:jobId/series         put the job in a series { seriesId }   200 job
//   POST /api/series/:seriesId/undo      Undo of Start a series                 200 { ok: true }
//   POST /api/series/:seriesId/retry     run the failed series pass again       202 { series }
//
// While the Series switch is off every one of them answers 404 SERIES_MESSAGES.off.

/** `GET /api/clients/:clientId/series`: the client's series, by name. A client with none has `[]`. */
export const clientSeriesResponseSchema = z.object({ series: z.array(seriesSummarySchema) });
export type ClientSeriesResponse = z.infer<typeof clientSeriesResponseSchema>;

/** `GET /api/series/:seriesId`: the series and its series.md, `null` while there is none. */
export const seriesResponseSchema = z.object({
  series: seriesSchema,
  markdown: z.string().nullable(),
});
export type SeriesResponse = z.infer<typeof seriesResponseSchema>;

/**
 * `POST /api/jobs/:jobId/series` body: Start a series from this Ready job, named `name`. The server
 * trims it and writes it in Unicode NFC; see `seriesNameProblem` for what it refuses (422).
 */
export const startSeriesRequestSchema = z.object({ name: z.string() });
export type StartSeriesRequest = z.infer<typeof startSeriesRequestSchema>;

/**
 * `POST /api/series/:seriesId/format` body: make this Ready episode the series' format (Use as the
 * series format).
 */
export const seriesFormatRequestSchema = z.object({ jobId: z.string().min(1) });
export type SeriesFormatRequest = z.infer<typeof seriesFormatRequestSchema>;

/**
 * `POST /api/jobs/:jobId/series`, `POST /api/series/:seriesId/format` and
 * `POST /api/series/:seriesId/retry` (each 202): the series, now `learning`.
 */
export const seriesActionResponseSchema = z.object({ series: seriesSchema });
export type SeriesActionResponse = z.infer<typeof seriesActionResponseSchema>;

/**
 * `PUT /api/jobs/:jobId/series` body: the series to put the job in, or `null` for "Not in a
 * series". Only while `canChangeSeries(job)`; the job then keeps that choice (the name rule leaves
 * it alone).
 */
export const setJobSeriesRequestSchema = z.object({ seriesId: z.string().min(1).nullable() });
export type SetJobSeriesRequest = z.infer<typeof setJobSeriesRequestSchema>;

/** `PUT /api/jobs/:jobId/series`: the job, with its new `seriesId` and `episode`. */
export const setJobSeriesResponseSchema = jobSchema;
export type SetJobSeriesResponse = z.infer<typeof setJobSeriesResponseSchema>;

/** `POST /api/series/:seriesId/undo`: the series is gone, and what it replaced is back. */
export const undoSeriesResponseSchema = z.object({ ok: z.literal(true) });
export type UndoSeriesResponse = z.infer<typeof undoSeriesResponseSchema>;

/**
 * What the series routes answer when they refuse, as `{ error }`, with the status each one goes
 * with. An unknown job is 404 "Job <id> not found" (as for every job route), an unknown series 404
 * {@link seriesNotFoundMessage}, a name `seriesNameProblem` refuses 422 with its own words.
 */
export const SERIES_MESSAGES = {
  /** 404, every series route while the Series switch is off. */
  off: 'Series are off.',
  /** 409, Start a series: the job is not ready. */
  notFinished: 'Only a finished job can start a series.',
  /** 409, Start a series: the job is in a series already. */
  alreadyInSeries: 'This job is already in a series.',
  /** 409, Use as the series format and Retry: a style pass of the client is queued or running (Start a series waits for it). */
  styleBusy: 'The style is being analysed. Try again when it’s done.',
  /** 409, Start a series, Use as the series format and Retry: a series pass of the client is queued or running. */
  seriesBusy: 'A series of this client is being learned. Try again when it’s done.',
  /** 422, Start a series: the client has a series of this name (names compare as `seriesNameKey`). */
  nameTaken: 'A series with this name already exists.',
  /** 409, Use as the series format: the job is not a ready episode of this series. */
  notReadyEpisode: 'Only a finished episode of this series can be its format.',
  /** 409, Use as the series format: the job is the format already. */
  formatAlready: 'This episode is the format already.',
  /** 409, putting a job in a series or taking it out: its edit has started (`canChangeSeries`). */
  jobStarted: 'Only a job that hasn’t started can change series.',
  /** 422, putting a job in a series: the series is another client's. */
  otherClient: 'That series belongs to another client.',
  /** 409, Undo: more than `SERIES_UNDO_MS` after the series started. */
  undoTooLate: 'It’s too late to undo starting this series.',
  /** 409, Retry: the series has not failed. */
  notFailed: 'Only a series that failed can be tried again.',
  /** 400, Start a series: the body is not `{ name }`. */
  startBody: 'Send the name as JSON: { "name": "the series name" }.',
  /** 400, Use as the series format: the body is not `{ jobId }`. */
  formatBody: 'Send the episode as JSON: { "jobId": "the job" }.',
  /** 400, putting a job in a series: the body is not `{ seriesId }`. */
  setBody: 'Send the series as JSON: { "seriesId": "the series" } or { "seriesId": null }.',
} as const;

/** 404 for a series id the engine does not know. */
export function seriesNotFoundMessage(seriesId: string): string {
  return `Series ${seriesId} not found`;
}
