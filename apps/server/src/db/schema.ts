// The tables of architecture §5, the Phase 2 plan §4 (`client_styles`), Phase 3 §6 (`review_notes`),
// Phase 4 §2 (`deliveries` with `paid_on`, `jobs.review_sec`) and the Series plan §2 (`series`,
// `jobs.series_id`, `episode` and `series_pinned`, `review_notes.add_to_series`), plus
// `series.waiting_notes` (C26), and the Graphics plan's `graphics`, `graphic_messages` and
// `graphic_uses`, the LUTs plan's `luts` and `lut_uses`, the Fonts plan's `font_uses` and
// `font_requests`, and the Quick fixes plan's `quick_fixes`, `jobs.review_effort`,
// `jobs.revise_tier` and the route and fix columns of `review_notes`, and Generated videos'
// `job_generate`, and the Clients × Instagram plan's `instagram_accounts`, `instagram_scans`,
// `instagram_reels` and `instagram_reel_reads`.
// `pnpm --filter @studio/server db:generate` turns changes to this file into a new migration
// under apps/server/drizzle/ (commit the SQL).
//
// Kept free of runtime imports from this repo so that drizzle-kit can load it on its own.
//
// Timestamps are integer milliseconds since the epoch, so ordering and comparing are numeric; the
// repository turns them into the ISO strings of the `Job` type (mapping.ts). Derived fields
// (placeInLine, settlesAt, etaSec) have no column: they are computed whenever a job is read.

import type {
  ClientStyleState,
  Effort,
  FixStatus,
  FixTier,
  FontUseSource,
  GeneratePhase,
  GraphicKind,
  GraphicMessageStatus,
  GraphicRole,
  GraphicVariable,
  InputCounts,
  JobOutput,
  JobPreview,
  JobState,
  LutKind,
  NoteRouteStatus,
  PushEvents,
  ReviewNoteKind,
  ReviseTier,
  RunKind,
  SeriesState,
  StepId,
  TranscriptStatus,
} from '@studio/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable(
  'jobs',
  {
    /** Stable hash of the relative path (W1's `jobIdFor`). */
    id: text('id').primaryKey(),
    client: text('client').notNull(),
    name: text('name').notNull(),
    /** `Client/Job` as the file system spells it (the latest spelling seen by a scan). */
    relPath: text('rel_path').notNull(),
    /** `relPath` in Unicode NFC, so macOS's NFC/NFD spellings of one folder find the same row. */
    relKey: text('rel_key').notNull(),
    state: text('state').$type<JobState>().notNull(),
    step: integer('step').$type<StepId>(),
    subProgress: text('sub_progress'),
    failedAt: integer('failed_at').$type<StepId>(),
    error: text('error'),
    stoppedAt: integer('stopped_at').$type<StepId>(),
    inputs: text('inputs', { mode: 'json' }).$type<InputCounts>().notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** Seconds of video and audio in the job's inputs; feeds the ETA, not sent to the web app. */
    footageSeconds: real('footage_seconds').notNull().default(0),
    addedAt: integer('added_at').notNull(),
    /** Last time the job's state, step/sub-progress, error, output, inputs or note changed. */
    updatedAt: integer('updated_at').notNull(),
    lastChangeAt: integer('last_change_at').notNull(),
    /** When the job last joined the queue; the queue runs oldest first. */
    settledAt: integer('settled_at'),
    /**
     * While `held`: the `settledAt` the job had when it was held, so that a release that restores
     * the place (the note dialog's) can put it back in line where it stood. `null` otherwise.
     */
    heldSettledAt: integer('held_settled_at'),
    /** When the latest edit attempt started (`START`). */
    startedAt: integer('started_at'),
    /** When the latest edit attempt ended (`SUCCEED`, `FAIL` or `CANCEL`). */
    finishedAt: integer('finished_at'),
    output: text('output', { mode: 'json' }).$type<JobOutput>(),
    /** 1 for the first attempt; a retry makes it one more. */
    attempt: integer('attempt').notNull().default(1),
    /** The owner's note for the editor, trimmed; `null` for none. Edited with `JobRepository.setNote`. */
    note: text('note'),
    /** The effort level of the job's edit and revise runs (`claude --effort`); `null` is Default (Extra high). Set with `JobRepository.setEffort`. */
    effort: text('effort').$type<Effort>(),
    /**
     * The effort of the Review dialog's notes (Quick fixes plan): `null` is Auto, a level makes
     * every note wait for Send at that level. Set with `JobRepository.setReviewEffort`. `effort`
     * stays the level of the first edit.
     */
    reviewEffort: text('review_effort').$type<Effort>(),
    /**
     * What the revise run that Send queued with Auto is: the biggest tier among the notes it sent.
     * `null` before a Send with Auto. Set with `JobRepository.setReviseTier`.
     */
    reviseTier: text('revise_tier').$type<ReviseTier>(),
    /**
     * When the job was archived; `null` for a job that is not. Set by `JobRepository.archive` (which
     * keeps the first date and leaves `updatedAt` alone), cleared by `unarchive` and by any save
     * that puts the job into arriving, queued or editing.
     */
    archivedAt: integer('archived_at'),
    /** The run the job is on or last ran: 'edit', 'revise' (after Send notes), 'render' (after Approve). */
    runKind: text('run_kind').$type<RunKind>().notNull().default('edit'),
    /** How many rounds of review notes were sent. */
    round: integer('round').notNull().default(0),
    /** The live composition's length and frame size (PREVIEW_READY); `null` before the first. */
    preview: text('preview', { mode: 'json' }).$type<JobPreview>(),
    /** When the owner approved the preview (APPROVE); `null` before. */
    approvedAt: integer('approved_at'),
    /**
     * Seconds the owner spent in the Review dialog for this job, all rounds together (Phase 4 §2, M3).
     * Added to with `JobRepository.addReviewSec`; copied into the delivery when the job is delivered.
     */
    reviewSec: integer('review_sec').notNull().default(0),
    /**
     * The series the job is an episode of (`series.id`); `null` for none. No foreign key, as for
     * the notes: a migration that rebuilds `series` must not touch the jobs.
     */
    seriesId: text('series_id'),
    /** The episode number from the folder name; `null` outside a series or without a number. */
    episode: integer('episode'),
    /**
     * True once the owner picked the job's series by hand (or "Not in a series"): the name rule then
     * leaves it alone. Set with `JobRepository.setSeries`.
     */
    seriesPinned: integer('series_pinned', { mode: 'boolean' }).notNull().default(false),
    /**
     * Formats (GN7): the sizes the brief asked for when it explicitly asked for more than one
     * ("1080x1920", "1080x1080": the main one first), written by the Brief step with
     * `JobRepository.setFormats`; `null` for every other job. `Job.formats` is read from it.
     */
    formats: text('formats', { mode: 'json' }).$type<string[]>(),
  },
  (table) => [
    uniqueIndex('jobs_rel_key_unique').on(table.relKey),
    index('jobs_updated_at_idx').on(table.updatedAt),
    index('jobs_state_settled_at_idx').on(table.state, table.settledAt),
    index('jobs_series_id_idx').on(table.seriesId),
  ],
);

/** One timed run of one step of one job; the ETA estimator reads these. */
export const stepRuns = sqliteTable(
  'step_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // No foreign key: the timings of a removed job stay useful for the ETA.
    jobId: text('job_id').notNull(),
    step: integer('step').$type<StepId>().notNull(),
    startedAt: integer('started_at').notNull(),
    /** `null` while the step is running. */
    endedAt: integer('ended_at'),
    /** The job's footage when the step started, so a run can be turned into seconds per minute. */
    footageSeconds: real('footage_seconds').notNull().default(0),
    /** Which kind of run timed this step (W3 writes it; older rows are edit runs). */
    runKind: text('run_kind').$type<RunKind>().notNull().default('edit'),
  },
  (table) => [
    index('step_runs_job_step_idx').on(table.jobId, table.step),
    index('step_runs_step_ended_at_idx').on(table.step, table.endedAt),
  ],
);

/**
 * One client's style (Phase 2 plan §4). A client with no row has state `none`. The file it
 * describes is `<inbox>/<Client>/_Style/style.md`; this row says where that style stands.
 */
export const clientStyles = sqliteTable('client_styles', {
  /** Stable hash of the client folder name (`clientIdFor`). */
  clientId: text('client_id').primaryKey(),
  /** The client folder's name, the latest spelling seen. */
  client: text('client').notNull(),
  state: text('state').$type<ClientStyleState>().notNull().default('none'),
  /** 0 until a style exists; +1 each time `style.md` is replaced. */
  version: integer('version').notNull().default(0),
  /** When the row last changed. Reconcile sets it to the mtime of a hand-made `style.md`. */
  updatedAt: integer('updated_at').notNull(),
  /** Why the latest style run failed; `null` otherwise. */
  error: text('error'),
  /** The job the current look was learned from; `null` for a style made from files. */
  sourceJobId: text('source_job_id'),
  /** What Retry runs again after a failure. The shape belongs to the style runs (C3, C4). */
  lastPass: text('last_pass', { mode: 'json' }).$type<ClientStylePass>(),
});

/**
 * The owner's review notes (Phase 3 §6). Unsent while `round` is null; Send stamps the round and
 * `sent_at`. No foreign key on purpose: drizzle runs migrations inside one transaction, where
 * `PRAGMA foreign_keys` can't be switched off, so a later migration that rebuilds `jobs` would
 * cascade-delete every note. `JobRepository.remove` deletes a job's notes instead.
 */
export const reviewNotes = sqliteTable(
  'review_notes',
  {
    /** A uuid. */
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    /** The round it was sent in; `null` while unsent. */
    round: integer('round'),
    atSec: real('at_sec').notNull(),
    kind: text('kind').$type<ReviewNoteKind>().notNull(),
    /** A text note's body, or a voice note's transcript. */
    text: text('text'),
    /** Relative to the job folder: edit/review/voice/<id>.webm or .m4a. */
    audioFile: text('audio_file'),
    audioSec: real('audio_sec'),
    transcriptStatus: text('transcript_status').$type<TranscriptStatus>(),
    addToStyle: integer('add_to_style', { mode: 'boolean' }).notNull().default(false),
    /** "Series", on an episode: on Send it also goes into the job's series. */
    addToSeries: integer('add_to_series', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    sentAt: integer('sent_at'),
    /** Quick fixes: where Auto's sorting of the note stands (`pending`, `routed`); `null` for a note never sorted. */
    routeStatus: text('route_status').$type<NoteRouteStatus>(),
    /** The router's answer once routed: the tier, what the note asks for and why it waits for Send (empty for a quick note). All three are set together, or none. */
    routeTier: text('route_tier').$type<FixTier>(),
    routeKind: text('route_kind'),
    routeWhy: text('route_why'),
    /**
     * Generated videos: the format of the preview the note was written on, as the `id` of one of the
     * job's formats ("1x1"). `null` is the main format, and every note from before formats.
     */
    format: text('format'),
    /** The quick fix made for the note (`quick_fixes.id`); `null` for none. */
    fixId: text('fix_id'),
    /** When that fix landed (the preview changed); `null` until then and again after Undo. */
    fixedAt: integer('fixed_at'),
  },
  (table) => [index('review_notes_job_round_idx').on(table.jobId, table.round)],
);

/**
 * A delivered job (Phase 4 §2). Written when the owner marks a job delivered, never by an export
 * finishing, and deleted only by Not delivered yet (refused once the job is paid). No foreign key
 * on purpose: the row must outlive the job and its folder, so the Money page keeps past months'
 * numbers. The price and currency are frozen at delivery; `paid_on` is set by Mark paid.
 */
export const deliveries = sqliteTable(
  'deliveries',
  {
    /** The job's id (`jobIdFor`). A job is delivered once: a second Mark delivered keeps the first row. */
    jobId: text('job_id').primaryKey(),
    clientId: text('client_id').notNull(),
    client: text('client').notNull(),
    name: text('name').notNull(),
    relPath: text('rel_path').notNull(),
    /** When the owner marked the job delivered. */
    deliveredAt: integer('delivered_at').notNull(),
    price: real('price').notNull(),
    currency: text('currency').notNull().default('ILS'),
    /** Seconds the owner spent in the Review dialog for this job; copied here on delivery (M3). */
    reviewSec: integer('review_sec').notNull().default(0),
    /** The calendar day the money came in, `YYYY-MM-DD`; `null` while the job is not paid. */
    paidOn: text('paid_on'),
    /**
     * What the client actually paid for the video, in `currency`, typed in Mark paid; `null` while
     * the job is not paid, and on a job paid before it could be typed (it was paid its `price`).
     */
    paidAmount: real('paid_amount'),
  },
  (table) => [index('deliveries_delivered_at_idx').on(table.deliveredAt)],
);

/**
 * One series of a client (Series plan §2). The files it describes are in
 * `<inbox>/<Client>/_Series/<name>/` (series.md and kit/); this row says where the series stands.
 * Named `seriesTable` because `series` is the word for one row as well as for all of them.
 */
export const seriesTable = sqliteTable(
  'series',
  {
    /** `seriesIdFor(clientId, name)`: sha1 over the NFC form of `<clientId>/<name>`, 12 hex characters. */
    id: text('id').primaryKey(),
    /** The client's id (`clientIdFor`). */
    clientId: text('client_id').notNull(),
    /** The client folder's name, the latest spelling seen. */
    client: text('client').notNull(),
    /** The series folder's name inside `_Series`, as it was started (trimmed, NFC). */
    name: text('name').notNull(),
    /** `name` as names compare (`seriesNameKey`): one series per name and client, whatever its case. */
    nameKey: text('name_key').notNull(),
    /** The job the format comes from, and its folder name. */
    formatJobId: text('format_job_id').notNull(),
    formatJob: text('format_job').notNull(),
    state: text('state').$type<SeriesState>().notNull(),
    /** Why the latest series pass failed; `null` otherwise. */
    error: text('error'),
    /** 0 until the first series.md is installed; +1 each time it is replaced. */
    version: integer('version').notNull().default(0),
    /** What Retry runs again after a failure. The shape belongs to the series passes (K2). */
    lastPass: text('last_pass', { mode: 'json' }).$type<SeriesPassRecord>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /**
     * The review-note files of the series folder that wait for their episode's approval (C26), as
     * Send wrote them: `[{ jobId, name, size }]`, oldest first; `null` for none.
     */
    waitingNotes: text('waiting_notes', { mode: 'json' }).$type<WaitingSeriesNoteRecord[]>(),
  },
  (table) => [uniqueIndex('series_client_name_unique').on(table.clientId, table.nameKey)],
);

/**
 * The phones that get a push (Mobile plan §6): one row per Home Screen app that turned
 * notifications on. `endpoint`, `p256dh` and `auth` are the browser's push subscription, secrets of
 * the push service that no route sends back; `events` holds the device's switches (the default is
 * everything on but Queue is empty); `last_ok_at` is when a push to it last went through.
 */
export const pushDevices = sqliteTable('push_devices', {
  /** A uuid, made when the endpoint is first registered and kept when it registers again. */
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** A short name from the user agent that registered the device: "iPhone". */
  label: text('label').notNull(),
  events: text('events', { mode: 'json' })
    .$type<PushEvents>()
    .notNull()
    .default(sql`'{"review":true,"failed":true,"approved":true,"queueEmpty":false,"badge":true}'`),
  createdAt: integer('created_at').notNull(),
  lastOkAt: integer('last_ok_at'),
  /**
   * The login of the person who registered the device (Team plan, TM2): `viewer.email`, which is
   * `local` for the owner on the Mac itself. A device registered before the team existed has none
   * (NULL) and belongs to the admin.
   */
  owner: text('owner'),
});

/**
 * One graphic of the library (Graphics plan, "Data"). Its files are in
 * `<inbox>/_Graphics/<folder>/` (versions/vN/, work/, refs/, fonts/); this row says what it is and
 * which version edits use. Deleting one sets `deleted_at` (its folder goes to the Trash); the row
 * stays, so the jobs that used it keep their `graphic_uses`. No foreign keys, as for the rest.
 */
export const graphics = sqliteTable(
  'graphics',
  {
    /** 12 hex characters, made when the graphic is (`GRAPHIC_ID_PATTERN`). */
    id: text('id').primaryKey(),
    /** As `cleanGraphicName` leaves it; unique without regard to case among live graphics. */
    name: text('name').notNull(),
    /** The folder's name inside `<inbox>/_Graphics`: the name, when it was last given. */
    folder: text('folder').notNull(),
    /** From the newest version's about.json; `null` before v1. */
    kind: text('kind').$type<GraphicKind>(),
    /** Seconds, from the newest version's about.json; `null` before v1. */
    lengthSec: real('length_sec'),
    /** The text fields, from the newest version's about.json; `[]` before v1. */
    variables: text('variables', { mode: 'json' })
      .$type<GraphicVariable[]>()
      .notNull()
      .default(sql`'[]'`),
    /** "When edits use it": about.json's `when` until the owner edits it. */
    whenText: text('when_text').notNull().default(''),
    /** True once the owner edited `when_text`: runs no longer overwrite it. */
    whenEdited: integer('when_edited', { mode: 'boolean' }).notNull().default(false),
    /** The version edits use (the newest made); `null` until v1. */
    version: integer('version'),
    /** "Edits can use it". */
    uses: integer('uses', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    /** When anything about it last changed: a message, a run, a rename, its switch. */
    updatedAt: integer('updated_at').notNull(),
    /** When it was deleted; `null` for a live graphic. */
    deletedAt: integer('deleted_at'),
  },
  (table) => [index('graphics_updated_at_idx').on(table.updatedAt)],
);

/**
 * One message of a graphic's chat (Graphics plan, "Data"). The owner's (`you`) carry their text, the files
 * they attached (`refs`, names inside the graphic's refs/) and the effort they picked; Claude's carry
 * the version they made or tried and the run's status, step, reply (`text`) and error. A version is
 * not a table: it is a Claude row that is `done`, plus its versions/vN/ folder. The chat's order is
 * `created_at`, then the order the rows were written in.
 */
export const graphicMessages = sqliteTable(
  'graphic_messages',
  {
    /** A uuid. */
    id: text('id').primaryKey(),
    graphicId: text('graphic_id').notNull(),
    role: text('role').$type<GraphicRole>().notNull(),
    /** The owner's message; Claude's reply once done (empty before). */
    text: text('text').notNull().default(''),
    /** The files of the owner's message: names inside the graphic's refs/. */
    refs: text('refs', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    /** The effort the owner picked next to Send; `null` is the default (Extra high). */
    effort: text('effort').$type<Effort>(),
    /** Claude's rows: the version this run made or tried. */
    version: integer('version'),
    /** Claude's rows: making, done, failed or stopped. */
    status: text('status').$type<GraphicMessageStatus>(),
    /** 0–2 while making. */
    step: integer('step'),
    /** Why the run failed. */
    error: text('error'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('graphic_messages_graphic_idx').on(table.graphicId, table.createdAt),
    index('graphic_messages_status_idx').on(table.status),
  ],
);

/**
 * Which jobs used which graphic, at which version (Graphics plan, build 2: filled by GR9 after an
 * edit or revise run). One row per graphic and job; a later run of the job updates it.
 */
export const graphicUses = sqliteTable(
  'graphic_uses',
  {
    graphicId: text('graphic_id').notNull(),
    jobId: text('job_id').notNull(),
    version: integer('version').notNull(),
    /** When the run that used it ended. */
    at: integer('at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.graphicId, table.jobId] })],
);

/**
 * One imported LUT (LUTs plan, "Tables"). Its file is `<inbox>/_LUTs/<file>`; this row says what it
 * is. Deleting one sets `deleted_at` (its file goes to the Trash); the row stays, so the jobs that
 * used it keep their `lut_uses`. Built-in LUTs are a fixed catalog in shared and have no row. No
 * foreign keys, as for the rest.
 */
export const luts = sqliteTable(
  'luts',
  {
    /** 12 hex characters, made when the LUT is imported (`LUT_ID_PATTERN`). */
    id: text('id').primaryKey(),
    /** The name in kebab-case (`lutSlug`); unique among live rows, and apart from the built-in slugs. */
    slug: text('slug').notNull(),
    /** As `cleanLutName` leaves it; unique without regard to case among live LUTs. */
    name: text('name').notNull(),
    kind: text('kind').$type<LutKind>().notNull(),
    /** The grid points per side (17, 33, 65 …). */
    size: integer('size').notNull(),
    /** The file's name inside `_LUTs`: `<name>.cube`. */
    file: text('file').notNull(),
    bytes: integer('bytes').notNull(),
    /** Of the stored file; with the id it keys the cached preview stills. */
    sha256: text('sha256').notNull(),
    /** The file's name as it was imported. */
    sourceName: text('source_name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** When it was deleted; `null` for a live LUT. */
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    uniqueIndex('luts_slug_live_idx').on(table.slug).where(sql`${table.deletedAt} is null`),
  ],
);

/**
 * Which jobs used which LUT, in which round (LUTs plan, build 2: filled when a run starts with a
 * note that names it). `lut_key` is a `luts.id`, or a built-in slug. `round` 0 is the edit, n is
 * review round n. "Used in 3 jobs" counts distinct `job_id`.
 */
export const lutUses = sqliteTable(
  'lut_uses',
  {
    lutKey: text('lut_key').notNull(),
    jobId: text('job_id').notNull(),
    round: integer('round').notNull(),
    at: integer('at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.lutKey, table.jobId, table.round] })],
);

/**
 * Which jobs used which font face, in which round (Fonts plan, "Tables"; filled by build 2: a note
 * that names a face, and the scan of a finished job's compositions). The fonts themselves are
 * files in `<inbox>/_Fonts`; nothing about a font is copied into the database. `family` is the
 * family's name as the writer had it (the repository compares it without regard to case),
 * `weight` is 100 to 900 (0 for a use that names no weight: the composition scan), `italic` is 0 or 1, `round` 0 is the edit and n is review round n, and
 * `source` is `token` (a note named it) or `composition` (the finished composition uses it).
 * "Used in 3 jobs" counts distinct `job_id`. No foreign keys, as for the rest.
 */
export const fontUses = sqliteTable(
  'font_uses',
  {
    /** 12 hex characters. */
    id: text('id').primaryKey(),
    family: text('family').notNull(),
    weight: integer('weight').notNull(),
    italic: integer('italic').notNull(),
    jobId: text('job_id').notNull(),
    round: integer('round').notNull(),
    source: text('source').$type<FontUseSource>().notNull(),
    at: integer('at').notNull(),
  },
  (table) => [index('font_uses_job_idx').on(table.jobId)],
);

/**
 * A note named a font the library does not have (Fonts plan, build 2): it drives the banner on the
 * Fonts page. `name` is as it was written, `at` is when the note was read, and `resolved_at` is
 * set when the request stops being open: a family with that name was imported, or the owner pressed
 * "Not a font" on it (C52), which also sets `dismissed_at` (`null` while it was not dismissed).
 */
export const fontRequests = sqliteTable(
  'font_requests',
  {
    /** 12 hex characters. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    jobId: text('job_id').notNull(),
    round: integer('round').notNull(),
    at: integer('at').notNull(),
    resolvedAt: integer('resolved_at'),
    dismissedAt: integer('dismissed_at'),
  },
  (table) => [index('font_requests_open_idx').on(table.resolvedAt, table.at)],
);

/**
 * One quick fix of one review note (Quick fixes plan): a Sonnet run that changes only the live
 * composition. The files it works in are `<job>/edit/review/fixes/<id>/` (the preview as it was
 * before, the run's reply, the before and after stills); this row says where the fix stands. The
 * rows are in the order the fixes were queued (SQLite's rowid), which is the order they run in. No
 * foreign keys, as for the rest: `JobRepository.remove` and `purge` delete a job's fixes.
 */
export const quickFixes = sqliteTable(
  'quick_fixes',
  {
    /** A uuid. */
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    noteId: text('note_id').notNull(),
    /** The round its note will be stamped with: `jobs.round + 1` when the fix was queued. */
    round: integer('round').notNull(),
    status: text('status').$type<FixStatus>().notNull(),
    /** 0–3 while the run is on; `null` otherwise. */
    step: integer('step'),
    stepLabel: text('step_label'),
    /** The run's reply to the owner once fixed. */
    said: text('said'),
    /** Why it could not be done here (escalated, failed). */
    why: text('why'),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    /** `null` while the fix is queued. */
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    durationSec: real('duration_sec'),
    /** Whether before.png and after.png both exist. */
    hasCompare: integer('has_compare', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('quick_fixes_job_round_idx').on(table.jobId, table.round),
    index('quick_fixes_note_idx').on(table.noteId),
  ],
);

/**
 * Where the Generate stage of a generated job stands (Generated videos, GN0): one row per job,
 * written by the engine as the run moves on and read whenever the job is read (`Job.generate`) and
 * by `GET /api/jobs/:id/generate`. The files in `<job>/edit/generate/` are the truth about what was
 * made; this row is what the Jobs list and the sheet show without reading them. Each part has a
 * done and a total count (0 of 0 until the plan says how many), `spend_usd` is Higgsfield only (the
 * voice is ElevenLabs, counted in `elevenlabs_chars`), and `budget_usd` is the job's own. No
 * foreign key, as for the rest: `JobRepository.remove` and `purge` delete a job's row.
 */
export const jobGenerate = sqliteTable('job_generate', {
  jobId: text('job_id').primaryKey(),
  phase: text('phase').$type<GeneratePhase>().notNull(),
  voiceDone: integer('voice_done').notNull().default(0),
  voiceTotal: integer('voice_total').notNull().default(0),
  looksDone: integer('looks_done').notNull().default(0),
  looksTotal: integer('looks_total').notNull().default(0),
  keyframesDone: integer('keyframes_done').notNull().default(0),
  keyframesTotal: integer('keyframes_total').notNull().default(0),
  clipsDone: integer('clips_done').notNull().default(0),
  clipsTotal: integer('clips_total').notNull().default(0),
  /** Clips kept below the bar because the money ran out. */
  belowBar: integer('below_bar').notNull().default(0),
  spendUsd: real('spend_usd').notNull().default(0),
  budgetUsd: real('budget_usd').notNull(),
  /** ElevenLabs characters the voice takes used (the voice's cost is in credits, not dollars). */
  elevenlabsChars: integer('elevenlabs_chars').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * How a scan of an Instagram account ended (Clients × Instagram plan, "Data"): `ok` read the
 * profile and the reels; `private` and `not-found` are what Instagram answered for the handle;
 * `no-token` (no Apify token) and `no-credit` (Apify's free month is used up) stopped it before it
 * read anything; `failed` is anything else, with the reason in `error`.
 */
export type InstagramScanOutcome =
  | 'ok'
  | 'private'
  | 'not-found'
  | 'no-token'
  | 'no-credit'
  | 'failed';

/**
 * The Instagram account of a client (Clients × Instagram plan, "Data"): at most one per client.
 * Removing the account deletes only this row. The scans, the reels and their links to jobs stay,
 * so adding the same account again brings everything back. No foreign keys, as for the rest: the
 * client rename and delete move and delete the rows by `client_id` (`JobRepository.renameClient`
 * and `purgeClient`), and the photo file with them.
 */
export const instagramAccounts = sqliteTable('instagram_accounts', {
  /** Stable hash of the client folder name (`clientIdFor`). */
  clientId: text('client_id').primaryKey(),
  /** The client folder's name, the latest spelling seen. */
  client: text('client').notNull(),
  /** Lower case, no `@`. */
  handle: text('handle').notNull(),
  /** Instagram's id of the account, so a renamed handle is still the same account; `null` until a scan reads it. */
  instagramId: text('instagram_id'),
  /** "Working together since", a calendar day `YYYY-MM-DD`; `null` means the client's first delivery. */
  since: text('since'),
  addedAt: integer('added_at').notNull(),
  fullName: text('full_name'),
  biography: text('biography'),
  private: integer('private', { mode: 'boolean' }).notNull().default(false),
  /** When the scan last saved the profile picture to `<data>/instagram/photos/<clientId>.jpg`; `null` while it has none. */
  photoSavedAt: integer('photo_saved_at'),
});

/**
 * One scan of one account (Clients × Instagram plan, "Data"). Written when the scan starts
 * (`finished_at` and `outcome` are `null` until it ends); the followers over time are the `ok`
 * rows. `cost_usd` is the sum of the Apify runs' `usageTotalUsd`; the Money page reads it. No
 * foreign keys, as for the rest.
 */
export const instagramScans = sqliteTable(
  'instagram_scans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: text('client_id').notNull(),
    /** The handle that was scanned (the account's handle may change later). */
    handle: text('handle').notNull(),
    startedAt: integer('started_at').notNull(),
    /** `null` while the scan runs. */
    finishedAt: integer('finished_at'),
    /** `null` while the scan runs. */
    outcome: text('outcome').$type<InstagramScanOutcome>(),
    /** Why a scan that did not end `ok` stopped; `null` otherwise. */
    error: text('error'),
    followers: integer('followers'),
    following: integer('following'),
    posts: integer('posts'),
    /** How many reels the scan read. */
    reelsRead: integer('reels_read').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    /** The ids of the Apify runs the scan started. */
    apifyRunIds: text('apify_run_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * When `cost_usd` was checked against Apify's runs again (C90). The scan writes the cost it read
     * right as the runs ended, before Apify had tallied their pay-per-event charges, so it is
     * early; a later check reads the runs again and writes what Apify really charged. `null` until
     * then, which is also what a scan stored before the check existed has.
     */
    costSettledAt: integer('cost_settled_at'),
  },
  (table) => [index('instagram_scans_client_started_idx').on(table.clientId, table.startedAt)],
);

/**
 * One reel of a client's account, with the numbers its latest scan read. `job_id` is the job
 * that made the reel ("ours"); `null` means it is the client's own ("theirs"). One reel links one
 * job and one job one reel, so `job_id` is unique (many rows may be `null`). The link is made by
 * hand (Link to job) and outlives the account row. No foreign keys, as for the rest.
 */
export const instagramReels = sqliteTable(
  'instagram_reels',
  {
    /** The reel's shortcode in its address, `instagram.com/reel/<shortcode>`. */
    shortcode: text('shortcode').primaryKey(),
    clientId: text('client_id').notNull(),
    url: text('url').notNull(),
    postedAt: integer('posted_at').notNull(),
    caption: text('caption'),
    durationSec: real('duration_sec'),
    plays: integer('plays').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    /** `null` when no scan could read them (the shares add-on is separate). */
    shares: integer('shares'),
    /** The song's name, or `Original audio`. */
    sound: text('sound'),
    /** The handles of the other authors of a collab reel. */
    coauthors: text('coauthors', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    hashtags: text('hashtags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    paidPartnership: integer('paid_partnership', { mode: 'boolean' }).notNull().default(false),
    /** The scan that first saw the reel, and the latest one that read it. */
    firstScanId: integer('first_scan_id').notNull(),
    lastScanId: integer('last_scan_id').notNull(),
    /** The job the reel is of (`jobs.id`, `deliveries.job_id`); `null` for a reel that is the client's own. */
    jobId: text('job_id'),
    /** When the link to the job was made; `null` with `job_id`. */
    linkedAt: integer('linked_at'),
  },
  (table) => [
    index('instagram_reels_client_posted_idx').on(table.clientId, table.postedAt),
    index('instagram_reels_posted_at_idx').on(table.postedAt),
    uniqueIndex('instagram_reels_job_id_unique').on(table.jobId),
  ],
);

/**
 * What one scan read of one reel: the plays, likes, comments and shares at that time. This is
 * what makes "this week" (the shares gained, the followers gained) a difference between two scans.
 * No foreign keys, as for the rest.
 */
export const instagramReelReads = sqliteTable(
  'instagram_reel_reads',
  {
    shortcode: text('shortcode').notNull(),
    scanId: integer('scan_id').notNull(),
    plays: integer('plays').notNull(),
    likes: integer('likes').notNull(),
    comments: integer('comments').notNull(),
    /** `null` when that scan could not read them. */
    shares: integer('shares'),
  },
  (table) => [
    primaryKey({ columns: [table.shortcode, table.scanId] }),
    index('instagram_reel_reads_scan_idx').on(table.scanId),
  ],
);

/** The style run Retry repeats, as stored in `client_styles.last_pass`. */
export type ClientStylePass = Record<string, unknown>;

/** The series pass Retry repeats, as stored in `series.last_pass`. */
export type SeriesPassRecord = Record<string, unknown>;

/** One review-note file waiting for its episode's approval, as stored in `series.waiting_notes`. */
export interface WaitingSeriesNoteRecord {
  /** The episode it was sent for. */
  jobId: string;
  /** The file's name inside the series folder. */
  name: string;
  /** Its bytes when it was written. */
  size: number;
}

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type StepRunRow = typeof stepRuns.$inferSelect;
export type ClientStyleRow = typeof clientStyles.$inferSelect;
export type ReviewNoteRow = typeof reviewNotes.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type PushDeviceRow = typeof pushDevices.$inferSelect;
export type SeriesRow = typeof seriesTable.$inferSelect;
export type GraphicRow = typeof graphics.$inferSelect;
export type GraphicMessageRow = typeof graphicMessages.$inferSelect;
export type GraphicUseRow = typeof graphicUses.$inferSelect;
export type LutRow = typeof luts.$inferSelect;
export type LutUseRow = typeof lutUses.$inferSelect;
export type FontUseRow = typeof fontUses.$inferSelect;
export type FontRequestRow = typeof fontRequests.$inferSelect;
export type QuickFixRow = typeof quickFixes.$inferSelect;
export type JobGenerateRow = typeof jobGenerate.$inferSelect;
export type InstagramAccountRow = typeof instagramAccounts.$inferSelect;
export type InstagramScanRow = typeof instagramScans.$inferSelect;
export type InstagramReelRow = typeof instagramReels.$inferSelect;
export type InstagramReelReadRow = typeof instagramReelReads.$inferSelect;
