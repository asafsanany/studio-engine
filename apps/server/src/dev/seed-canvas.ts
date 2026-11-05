// Dev fixture for design QA (CVP-78): serves the built web app with the twelve sample jobs of the
// design canvas's Jobs board, in the same states, with the same names, clients, inputs, sizes and
// ages, so the page can be compared with the board (and walked through by hand) without waiting for
// any edit.
//
//   pnpm --filter @studio/web build          # the server serves apps/web/dist
//   pnpm seed:canvas                         # real clock: ages are relative to now
//   pnpm seed:canvas --now canvas            # clock pinned to the canvas's "Tue 20 Oct 2026, 13:42" (UTC)
//   pnpm seed:canvas --port 4390 --dir /tmp/canvas-seed
//   pnpm seed:canvas --demo                  # every mock set at once on today's dates (`pnpm demo`)
//   pnpm seed:canvas --empty                 # no jobs: the "Jobs · empty" board
//   pnpm seed:canvas --review                # the Phase 3 rows: two jobs in Review with playable previews, a revise and a render run
//   pnpm seed:canvas --series                # the Series boards: a client with two series, their episodes and series.md, Series on
//   pnpm seed:canvas --sheet                 # the Job sheet boards: one job per state (13), with their steps and notes, Series on
//   pnpm seed:canvas --no-job-sheet          # the Job sheet switch off (it is on by default, as in the app)
//   pnpm seed:canvas --phone                 # the Phone switch on: below 768 px the page shows the phone layout (any rows above)
//   pnpm seed:canvas --analytics             # the Analytics page: about forty finished jobs over 13 weeks and its logs, switch on
//   pnpm seed:canvas --graphics              # the Graphics library: the seven graphics of the GRLibrary board with their chats, switch on
//   pnpm seed:canvas --graphics-empty        # the Graphics switch on and no graphic: the "Nothing made yet" board
//   pnpm seed:canvas --luts                  # the LUTs page: four LUTs of Yours in _LUTs, the built-in ones from the colour-grade skill, switch on
//   pnpm seed:canvas --luts-empty            # the LUTs switch on and nothing of Yours: the "Nothing imported yet" board
//   pnpm seed:canvas --fonts                 # the Fonts page: five families of test fonts in _Fonts, switches on as live (fontsInNotes too: sample used counts, Copy @name, "To use it")
//   pnpm seed:canvas --fonts-empty           # the Fonts switch on and an empty _Fonts: the empty-library board
//   pnpm seed:canvas --fonts-in-notes        # the same as --fonts (fontsInNotes is on by default since v0.42.0); kept as the explicit flag
//   pnpm seed:canvas --no-fonts-in-notes     # --fonts with the fontsInNotes switch off: no used column, no Copy @name, no @ font picker
//   pnpm seed:canvas --fonts-missing 3       # --fonts and 1 to 3 open requests for a font the library lacks: the "a note asked for a font you don't have" banner
//   pnpm seed:canvas --music                 # the Soundtrack boards: twelve jobs, one per state of the Music list and the sheet's Music row, switch on
//   pnpm seed:canvas --songs                 # the Songs boards: twelve jobs, one per state of Review's Music list, Note for the editor and the job sheet's two files, switches on
//   pnpm seed:canvas --generate              # Generated videos (GN8, GN9): four jobs in Review (a generated job with two formats and the board's notes, a one-format one, an ordinary one, a two-format footage job) and one Pinewood job for each state of the boards GNStates and GNSheet (voice, looks, keyframes, clips, balance empty, key not accepted, over the budget, budget ran out, approved with two files); Generate on
//   pnpm seed:canvas --chat [--chat-log <log>]  # Draft & chat: a job in Review and one drafting, their chats built from a real job log (default: a generated job's), switch on
//   pnpm seed:canvas --instagram             # the Clients × Instagram boards: Falcon FPV's sample Instagram (13 weekly scans, 22 reels, two linked, one delivered video not), a failed scan, a private account and a client with none, switch on
//   pnpm seed:canvas --quick-fixes           # the Quick fixes boards: eleven jobs in Review, one per state (reading, fixing, fixed, queue, mixed, whole video, couldn't, undone, all fixed, a level), switch on
//
// What it is: the real Hono app (jobs routes, SSE stream, static web app) over a real SQLite
// database and a real JobRepository, but without the engine around them. There is no inbox, no
// watcher and no worker, so nothing moves on its own: the arriving job never settles, the queued
// ones never start, and the editing one never finishes. Start now, Hold, Release, Cancel, Resume,
// Retry, saving a note and Download all work (the state machine and the export files are real); Cancel is applied by the
// repository because there is no run to stop. Three of the twelve are archived (j6, paid; j9,
// delivered and not paid; j8, cancelled): GET /api/jobs still lists them, Archive and Unarchive
// work, and the two with a delivery have it in `Job.delivery`. The live preview route works too, reading from
// <dir>/inbox, which starts empty (with --review it holds a copy of the sample composition for each
// job in Review).
//
// The Job sheet switch is on, as in the app: a click on a row opens its sheet. The steps, the sent
// notes and Show in Finder are served by the real routes over the seed's database; Finder is never
// asked (a revealed folder or file is only written down, `CanvasServer.finder`). --sheet seeds the
// thirteen jobs of the Job sheet boards (JSStatesA, JSStatesB), at the boards' day, Thu 22 Oct 2026:
// each has the step runs and the sent review notes its board shows (seed-job-sheet.ts), so the
// sheet reads as drawn. The times are the boards' own (UTC); open the page in UTC to match them.
//
// The review notes work too (--review): add, change and delete a note, Send notes and Approve are
// the real routes over the real review service. A voice note gets the fake transcript after about
// a second. Nothing runs after Send or Approve, so the job just stays queued.
//
// --series turns the Series switch on for this app only (the default app stays as it is): the
// eight rows of the SeriesJobs board replace the twelve, and the client עו״ד דוד לוי has two series
// (מיתוס או אמת, episodes 5 to 8; שאלות נפוצות, episodes 5 and 6), each with its series.md in
// _Series/<name>/ of the seed inbox. The series routes are the real ones over the seed's database,
// with the real series service and the fake style runner. Its worker is never started, so nothing
// runs by itself; Start a series stores its series and then waits there.
//
// --analytics turns the Analytics switch on for this app only and seeds what the page reads (see
// seed-analytics.ts): about forty finished jobs of six clients over 13 weeks with every step timed,
// their review notes with topics (note-topics.json), deliveries, usage.jsonl and limits.jsonl in the
// seed's data folder. The twelve rows are replaced by them; with --empty the switch is on and
// nothing is recorded (the empty page). The route is the real one, over the seed's database.
//
// --graphics turns the Graphics switch (and "Edits can use it") on for this app only and seeds the
// library of the GRLibrary board (see seed-graphics.ts): seven graphics, one being made, one that
// couldn't finish v3, one off for edits, one with a Hebrew name, each made version a real project
// in _Graphics/<Name>/versions/vN/ with the fake run's canned graphics. It changes no job rows, so
// it goes with any option above. The graphics routes are the real ones over the seed's database,
// with the real service and a worker around the fake graphic run (3 s a version): Send, Stop,
// Retry, Use v1 again, rename, duplicate and delete all work. The worker never "starts", so the
// graphic seeded as being made stays so. A delete moves the folder to <dir>/home/.Trash, not the
// real one. --graphics-empty seeds no graphic.
//
// --luts turns the LUTs switch on for this app only and seeds Yours (see seed-luts.ts): four small
// generated .cube files in <inbox>/_LUTs (Golden Hour Warm, Teal Orange Soft, Sony S-Log3 to Rec709,
// and Soft Pastel added two minutes ago, so it carries "New") with used counts and added times, so
// every state of the LUStates board can be reached. Built in is the real catalog read from the
// installed colour-grade skill (~/.claude/skills/color-grade-ai; STUDIO_COLOR_GRADE_DIR moves it),
// and without the skill it says so. The LUTs routes are the real ones over the seed's database
// with the real service. The graded stills are made by ffmpeg when it is installed (so the slider
// shows a real look) and are the fake maker's (the plain test frame twice) when it is not, or with
// `--lut-previews fake`; an import is proved by the static check alone either way, so nothing
// needs ffmpeg. Show in Finder is
// recorded, not done. A delete moves the file to <dir>/home/.Trash, not the real one. It changes no
// job rows, so it goes with any option above. --luts-empty seeds nothing of Yours.
//
// --fonts turns the Fonts switch on for this app only, and the fontsInNotes switch with it (both are on in
// the app since v0.42.0; nothing else changes) and seeds the library (see seed-fonts.ts): COPIES of the
// six test fonts in fixtures/fonts/ filed
// into <inbox>/_Fonts/<Hebrew + English | English only>/<Family>/, five families (Secular One, Bellefair,
// Varela Round, Outfit with two weights, Oswald added two minutes ago so it carries "New") with added
// times and sample "used by" rows (Secular One 3 jobs, Outfit 1 job; the seed's service reports them
// while the fontsInNotes switch is on, as the engine does, so the list can be compared with the boards;
// --no-fonts-in-notes turns it off, for the look with notes off). The Fonts routes are the real
// ones over the seed's database with the real service, its index and the watcher on <inbox>/_Fonts, so
// files copied into that folder while the seed runs appear in the list at once. Show in Finder is
// recorded, not done. A delete moves the family to <dir>/home/.Trash, not the real one. It changes no
// job rows, so it goes with any option above. --fonts-empty seeds an empty _Fonts. --fonts-in-notes is
// --fonts, kept as the explicit flag (the fontsInNotes switch is on by default: the list's used column,
// Copy @name, the delete sentence about notes, "To use it" in the pane, the @ picker with fonts in the
// notes of the Review seed). --no-fonts-in-notes is --fonts with that switch off.
// --fonts-missing N is --fonts with N (1 to 3) notes of the seed's jobs that asked for
// a font the library does not have (Gotham Bold, Avenir Next, Proxima Nova Bold; see seed-fonts.ts),
// for the banner on top of the page. The real ~/Studio Inbox/_Fonts is never read or written.
//
// --music turns the Soundtrack switch (and Series) on for this app only and seeds the jobs of the
// boards SDStates and SDSheet (see seed-music.ts) instead of the twelve: made once or twice, being
// made, failed, off, the folder's file, a style that says no music, a series episode, each with
// its edit/music/ folder, its preview composition and the mp3s the music script's fake path makes.
// The clock starts at the boards' moment (Fri 23 Oct 2026, 00:20 UTC). The music routes are the real
// ones over the real music service with that script on --fake, so Make another (with words) and Pick
// work on every job in Review. "Demo 3" is being made for as long as the seed runs.
//
// --songs turns the Soundtrack and Songs switches on for this app only and seeds the jobs of the boards
// SGStates, SGNote and SGSheet (see seed-songs.ts) instead of the twelve: the song from Yael's screenshot,
// No music picked, couldn't get the song, "Original audio", a trending pick, a note added (a song, a
// trending one), two arriving jobs (a pasted screenshot in the note, nothing attached) and three approved
// ones (both files, the second still being made, the second one failed). The routes are the real ones: the
// music routes over the real music service with that script on --fake (Make music instead, Pick), the
// note's picture routes (Choose a file, paste, drop), and the second file's status and Try again over the
// engine's own NoSongExports with a stand-in render. Another song and Pick a trending one add real notes;
// nothing gets a song (no engine, no Brief run): `pnpm exec playwright test e2e/songs.spec.ts` does that.
// The clock starts at the boards' moment (Sat 24 Oct 2026, 21:30 UTC).
//
// --quick-fixes turns the Quick fixes switch on for this app only (`/api/health` says so) and seeds the
// jobs of the boards QFStates and QFEffort (see seed-quick-fixes.ts) instead of the twelve: eleven jobs
// in Review, each with the notes, routes and fixes (and the before/ copies and Compare stills) one
// state of the boards needs. The note routing, the fix service and the fix routes are the real ones
// over the seed's database, with the fake router and the fake quick fix (the e2e's), so a note typed
// in any job is read, fixed and undone for real; `--fix-speed 0.25` slows the fix's four steps down
// so they can be looked at. Not together with `--review`, `--series`, `--sheet`, `--analytics`, `--music` or `--songs`.
//
// --instagram turns the Clients × Instagram switch on for this app only and seeds the boards CLPage,
// CLStates and CLList (see seed-instagram.ts) instead of the twelve jobs: six jobs of four clients, and
// the Instagram of three of them as the real scanner's mapping writes it from the fake scanner's
// answers. The clients, Instagram, link and delivery routes are the real ones over the seed's
// database, and Scan now, Save and scan and a handle typed into the dialog are answered by the fake
// scanner (4 s a run; `--scan-seconds`): falcon.fpv, flaky.studio, venezia.studio (private), credit.out
// (no credit), no.key (no key) and any other name (not found). The clock starts at the boards'
// moment (Mon 26 Oct 2026, 06:30 UTC) unless `now` says otherwise. Not together with the other options
// that seed rows.
//
// It never touches ~/Studio Inbox or ~/.studio-engine: the database, the exports and the log all
// live in a temp folder (or --dir) that is removed on exit. Dev-only: nothing in apps/ imports it.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type {
  Effort,
  InputCounts,
  Job,
  JobOutput,
  JobPreview,
  RunKind,
  StepId,
} from '@studio/shared';
import { DRAFT_PENDING_BRIEF_SUMMARY, setHomeCurrencySymbol } from '@studio/shared';
import { readLimits } from '../analytics/limits-log.js';
import { NoteTopicStore } from '../analytics/note-topics.js';
import { createApp, type GraphicsApiOptions, type LutsApiOptions } from '../app.js';
import { FakeStyleRunner } from '../clients/fake-style.js';
import { NoSongExports } from '../clients/no-song-export.js';
import { seriesFileFor } from '../clients/paths.js';
import { ReviewExports } from '../clients/review-export.js';
import { createSeriesService, type SeriesService } from '../clients/series-service.js';
import { StyleWorker } from '../clients/style-worker.js';
import {
  ClientStyleRepository,
  DeliveryRepository,
  FontRepository,
  GenerateRepository,
  GraphicRepository,
  JobRepository,
  LutRepository,
  NoteRepository,
  openDatabase,
  QuickFixRepository,
  SeriesRepository,
  StepRunRepository,
  type StudioDb,
} from '../db/index.js';
import { type StoredJob, storedToColumns } from '../db/mapping.js';
import { deliveries, jobs } from '../db/schema.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';
import { createEventBus, type EventBus } from '../events/bus.js';
import { followQueuePlaces } from '../events/queue-places.js';
import { FeedService } from '../feed/feed-service.js';
import { createFontService, type FontService } from '../fonts/font-service.js';
import { readGenerateHistory } from '../generate/generate-history.js';
import { createGenerateService } from '../generate/generate-service.js';
import { FakeGraphicRunner } from '../graphics/fake-graphic-runner.js';
import { GRAPHICS_ASSETS_DIR } from '../graphics/graphic-assets.js';
import { GraphicFolders } from '../graphics/graphic-folders.js';
import { createGraphicService } from '../graphics/graphic-service.js';
import { GraphicWorker } from '../graphics/graphic-worker.js';
import { clientIdFor } from '../inbox/scan.js';
import { BOARD_ANCHOR } from '../instagram/sample-accounts.js';
import { createFakeLutPreviews } from '../luts/fake-lut-previews.js';
import { createBuiltInLuts } from '../luts/lut-builtin.js';
import { createRealLutPreviews } from '../luts/lut-previews.js';
import { createLutService } from '../luts/lut-service.js';
import { createLutStaging } from '../luts/lut-staging.js';
import { createMusicScriptRunner } from '../music/music-script.js';
import { createMusicService, type MusicService } from '../music/music-service.js';
import { renderFakePreviewVideo } from '../pipeline/fake-preview.js';
import { createVoiceTranscriber } from '../pipeline/voice-transcriber.js';
import { FakeNoteRouter } from '../review/fake-fix-router.js';
import { FakeQuickFixRunner } from '../review/fake-quick-fix.js';
import { createFixService, type FixService } from '../review/fix-service.js';
import { createNoteRouting, NO_NOTE_ROUTING } from '../review/note-routing.js';
import { createReviewService } from '../review/review-service.js';
import type { ActionWorker } from '../routes/jobs.js';
import { readUsageLog } from '../usage/usage-log.js';
import { buildAnalyticsSeed, writeAnalyticsSeed } from './seed-analytics.js';
import {
  createDemoMoney,
  createDemoSettings,
  createDemoTeam,
  lastScanMonday,
} from './seed-demo.js';
import { seedFontRequests, seedFonts } from './seed-fonts.js';
import { GENERATE_JOB_SPECS, seedGenerate } from './seed-generate.js';
import { seedGraphics } from './seed-graphics.js';
import {
  createInstagramSeed,
  INSTAGRAM_JOB_SPECS,
  INSTAGRAM_NOW,
  type InstagramSeed,
} from './seed-instagram.js';
import {
  SHEET_JOB_SPECS,
  SHEET_NOW,
  SHEET_SERIES_JOBS,
  seedJobSheetExtras,
} from './seed-job-sheet.js';
import { seedLuts } from './seed-luts.js';
import {
  holdingRunner,
  MUSIC_IDS,
  MUSIC_JOB_SPECS,
  MUSIC_MAKING_ASK,
  MUSIC_MAKING_JOB,
  MUSIC_NOW,
  MUSIC_SERIES_JOBS,
  seedMusicFiles,
  seedMusicRuns,
} from './seed-music.js';
import { QUICK_FIX_JOB_SPECS, seedQuickFixes } from './seed-quick-fixes.js';
import {
  SONGS_IDS,
  SONGS_JOB_SPECS,
  SONGS_NOW,
  seedSongsFiles,
  seedSongsNotes,
  seedSongsRuns,
  songsNoSongRender,
} from './seed-songs.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
/** The sample composition (1080×1920, 6 s). Test data is not copied to dist: the seed runs from src with tsx. */
const SAMPLE_PREVIEW_DIR = fileURLToPath(new URL('../pipeline/testdata/preview/', import.meta.url));

/** The moment the canvas shows ("Tue 20 Oct 2026, 13:42"), in UTC. */
export const CANVAS_NOW = '2026-10-20T13:42:00.000Z';

const KB = 1_000;
const MB = 1_000_000;
const GB = 1_000_000_000;

export interface CanvasJobSpec {
  id: string;
  client: string;
  name: string;
  state: Job['state'];
  inputs: [video: number, audio: number, image: number, doc: number];
  sizeBytes: number;
  /** Absolute time, as the canvas prints it (UTC). */
  addedAt: string;
  updatedAt: string;
  step?: StepId;
  subProgress?: string;
  /** What the ETA estimator would say: only the editing job has one. */
  etaSec?: number;
  /** When the job last joined the queue (queued jobs): decides "#1 in line". */
  settledAt?: string;
  /** Seconds of settle time left at the canvas's "now" (the arriving job). */
  settlesInSec?: number;
  failedAt?: StepId;
  error?: string;
  stoppedAt?: StepId;
  output?: Omit<JobOutput, 'fileName'>;
  /** The owner's note for the editor; most of the sample jobs have none. */
  note?: string;
  /** The run the job is on (default `edit`). */
  runKind?: RunKind;
  /** How many rounds of notes were sent (default 0). */
  round?: number;
  /** The live composition's length and frame size (default none). */
  preview?: JobPreview;
  /** When the preview was approved, in canvas time (the render run and what it made). */
  approvedAt?: string;
  /** Which copy of the sample composition goes into the job's edit/preview/ (`--review` only). */
  sampleShape?: 'portrait' | 'landscape';
  /** When the job was archived, in canvas time: hidden from the lists once the page filters on it. */
  archivedAt?: string;
  /** The effort level picked for the job (default none: Default, Extra high). */
  effort?: Effort;
  /** The level of its review rounds (Quick fixes): default none, which is Auto. */
  reviewEffort?: Effort;
  /** A held job's place in line before it was held: where Release puts it back. */
  heldSettledAt?: string;
  /** When the folder last changed: with an arriving job this plus 60 s is when it settles. */
  lastChangeAt?: string;
  /** When the latest edit attempt started and ended, when the default for the state is not it. */
  startedAt?: string;
  finishedAt?: string;
  /**
   * The job was marked delivered at `deliveredAt` (a row in `deliveries`, ₪40) and, with `paidOn`,
   * paid at that time. Without it the job has no delivery.
   */
  delivery?: { deliveredAt: string; paidOn?: string };
}

/**
 * The twelve jobs of the Jobs board, in the board's own order (j1 to j12), with its strings: ages
 * ("Added" / "Last updated" and their tooltips), "#1 in line", "settles in 0:42", the output line
 * "0:45 · 1080×1920 · 62 MB" and the full error text of the failed one.
 */
export const CANVAS_JOB_SPECS: readonly CanvasJobSpec[] = [
  {
    id: 'j1',
    state: 'arriving',
    name: 'פרומו לסוף השבוע',
    client: 'מאפיית הצפון',
    inputs: [14, 3, 1, 1],
    sizeBytes: 3.1 * GB,
    addedAt: '2026-10-20T13:41:00.000Z',
    updatedAt: '2026-10-20T13:41:00.000Z',
    settlesInSec: 42,
  },
  {
    id: 'j2',
    state: 'queued',
    name: 'Class schedule',
    client: 'Arc Fitness',
    inputs: [0, 1, 5, 0],
    sizeBytes: 48 * MB,
    addedAt: '2026-10-20T13:30:00.000Z',
    updatedAt: '2026-10-20T13:31:00.000Z',
    settledAt: '2026-10-20T13:31:00.000Z',
  },
  {
    id: 'j3',
    state: 'held',
    name: 'סרטון גיוס – Hiring video',
    client: 'מאפיית הצפון',
    inputs: [6, 2, 1, 0],
    sizeBytes: 1.1 * GB,
    addedAt: '2026-10-20T13:17:00.000Z',
    updatedAt: '2026-10-20T13:22:00.000Z',
    note: 'לפתוח על הצוות, לא על המבנה. עד דקה.',
  },
  {
    id: 'j4',
    state: 'queued',
    name: 'Patient testimonial',
    client: 'מרפאת מירה',
    inputs: [2, 1, 4, 0],
    sizeBytes: 1.4 * GB,
    addedAt: '2026-10-20T13:11:00.000Z',
    updatedAt: '2026-10-20T13:12:00.000Z',
    settledAt: '2026-10-20T13:12:00.000Z',
  },
  {
    id: 'j5',
    state: 'editing',
    name: 'Coach intro reel',
    client: 'Arc Fitness',
    inputs: [9, 0, 1, 1],
    sizeBytes: 2.2 * GB,
    addedAt: '2026-10-20T12:54:00.000Z',
    updatedAt: '2026-10-20T13:42:00.000Z',
    step: 1,
    subProgress: 'reading 2 files',
    etaSec: 420,
  },
  {
    id: 'j6',
    state: 'ready',
    name: 'השקת תפריט חדש',
    client: 'Kova Coffee',
    inputs: [11, 0, 7, 0],
    sizeBytes: 2.8 * GB,
    addedAt: '2026-10-20T07:02:00.000Z',
    updatedAt: '2026-10-20T07:22:00.000Z',
    step: 8,
    output: { durationSec: 45, width: 1080, height: 1920, sizeBytes: 62 * MB },
    // Archived (CVP-196): a paid job, which still counts in Money.
    delivery: { deliveredAt: '2026-10-20T08:00:00.000Z', paidOn: '2026-10-20T11:00:00.000Z' },
    archivedAt: '2026-10-20T12:00:00.000Z',
  },
  {
    id: 'j7',
    state: 'failed',
    name: 'Open house tour',
    client: 'טל נכסים',
    inputs: [22, 0, 0, 1],
    sizeBytes: 7.9 * GB,
    addedAt: '2026-10-20T10:42:00.000Z',
    updatedAt: '2026-10-20T12:07:00.000Z',
    step: 1,
    failedAt: 1,
    error:
      'Brief stopped: Claude Code isn’t signed in on this Mac. Open Terminal, run claude and sign in, then retry.',
  },
  {
    id: 'j8',
    state: 'cancelled',
    name: 'Summer menu teaser',
    client: 'Kova Coffee',
    inputs: [5, 1, 2, 0],
    sizeBytes: 900 * MB,
    addedAt: '2026-10-20T08:42:00.000Z',
    updatedAt: '2026-10-20T09:02:00.000Z',
    step: 1,
    stoppedAt: 1,
    // Archived (CVP-196): a cancelled job.
    archivedAt: '2026-10-20T13:00:00.000Z',
  },
  {
    id: 'j9',
    state: 'ready',
    name: 'טיפים להלבנת שיניים',
    client: 'מרפאת מירה',
    inputs: [4, 2, 0, 0],
    sizeBytes: 1.6 * GB,
    addedAt: '2026-10-19T13:20:00.000Z',
    updatedAt: '2026-10-19T13:22:00.000Z',
    step: 8,
    output: { durationSec: 72, width: 1080, height: 1920, sizeBytes: 96 * MB },
    // Archived (CVP-196): delivered and not paid yet, which still counts in Money.
    delivery: { deliveredAt: '2026-10-19T15:00:00.000Z' },
    archivedAt: '2026-10-20T12:30:00.000Z',
  },
  {
    id: 'j10',
    state: 'ready',
    name: 'Studio tour',
    client: 'Arc Fitness',
    inputs: [8, 0, 1, 0],
    sizeBytes: 2.0 * GB,
    addedAt: '2026-10-20T11:57:00.000Z',
    updatedAt: '2026-10-20T12:32:00.000Z',
    step: 8,
    output: { durationSec: 58, width: 1920, height: 1080, sizeBytes: 120 * MB },
  },
  {
    id: 'j11',
    state: 'ready',
    name: 'Apartment 4B walkthrough',
    client: 'טל נכסים',
    inputs: [12, 0, 0, 1],
    sizeBytes: 3.3 * GB,
    addedAt: '2026-10-18T15:10:00.000Z',
    updatedAt: '2026-10-18T15:32:00.000Z',
    step: 8,
    output: { durationSec: 90, width: 1920, height: 1080, sizeBytes: 180 * MB },
  },
  {
    id: 'j12',
    state: 'ready',
    name: 'מאפים של בוקר',
    client: 'מאפיית הצפון',
    inputs: [6, 1, 0, 0],
    sizeBytes: 640 * MB,
    addedAt: '2026-10-17T10:15:00.000Z',
    // The board prints "Sat 17 Oct 2026, 08:32" for this tooltip, earlier than "Added"; kept as drawn.
    updatedAt: '2026-10-17T08:32:00.000Z',
    step: 8,
    output: { durationSec: 30, width: 1080, height: 1920, sizeBytes: 41 * MB },
  },
];

/**
 * The Draft & chat rows (DR9), with `--chat`: a job in Review whose chat is a whole real job log
 * (the Brief, Generate, the Draft, its rounds and renders) and one that is drafting, whose log stops
 * in the middle of its Draft, so its chat is live. They replace the twelve (ids c1 and c2).
 */
export const CHAT_JOB_SPECS: readonly CanvasJobSpec[] = [
  {
    id: 'c1',
    state: 'review',
    name: '97 Window Ad',
    client: 'Pinewood',
    inputs: [0, 0, 7, 2],
    sizeBytes: 0.2 * GB,
    addedAt: '2026-10-20T11:00:00.000Z',
    updatedAt: '2026-10-20T13:40:00.000Z',
    step: 7,
    runKind: 'revise',
    round: 3,
    preview: { durationSec: 6, width: 1080, height: 1920 },
    sampleShape: 'portrait',
  },
  {
    id: 'c2',
    state: 'editing',
    name: 'Window Ad, drafting',
    client: 'Pinewood',
    inputs: [0, 0, 7, 2],
    sizeBytes: 0.2 * GB,
    addedAt: '2026-10-20T13:00:00.000Z',
    updatedAt: '2026-10-20T13:41:00.000Z',
    step: 5,
    subProgress: 'grading',
    etaSec: 1200,
  },
];

/** The job log the `--chat` rows are built from when `--chat-log` names none: a generated job's. */
export const DEFAULT_CHAT_LOG = join(
  homedir(),
  '.studio-engine',
  'logs',
  'jobs',
  'your-job-id.log',
);

/** How far into its Draft the drafting job's log goes: this many lines after the Draft's start. */
const DRAFTING_LINES = 700;

/**
 * Copies the job log into the seed's logs for the `--chat` rows: the whole of it for the job in
 * Review, and for the drafting one everything up to `DRAFTING_LINES` lines into the Draft (no end
 * marker, so its run is still going).
 */
async function writeChatLogs(dir: string, log: string): Promise<void> {
  const jobs = join(dir, 'logs', 'jobs');
  await mkdir(jobs, { recursive: true });
  const text = await readFile(log, 'utf8');
  await writeFile(join(jobs, 'c1.log'), text);
  const lines = text.split('\n');
  const draft = lines.findIndex((line) => line.includes('"runKind":"edit"'));
  const cut = draft === -1 ? lines.length : Math.min(lines.length, draft + DRAFTING_LINES);
  await writeFile(join(jobs, 'c2.log'), `${lines.slice(0, cut).join('\n')}\n`);
}

/**
 * The Phase 3 rows (board P3Rows), with `--review`: two jobs in Review with playable previews (a
 * 9:16 one and a 16:9 one, the second on its first round), a revise run, the render run, and a
 * ready job that was rendered. They replace the twelve (ids p1 to p5).
 */
export const REVIEW_JOB_SPECS: readonly CanvasJobSpec[] = [
  {
    id: 'p1',
    state: 'review',
    name: 'פרומו לסוף השבוע',
    client: 'מאפיית הצפון',
    inputs: [14, 3, 1, 1],
    sizeBytes: 3.1 * GB,
    addedAt: '2026-10-20T12:10:00.000Z',
    updatedAt: '2026-10-20T13:40:00.000Z',
    step: 7,
    preview: { durationSec: 6, width: 1080, height: 1920 },
    sampleShape: 'portrait',
  },
  {
    id: 'p2',
    state: 'review',
    name: 'Studio tour',
    client: 'Arc Fitness',
    inputs: [8, 0, 1, 0],
    sizeBytes: 2.0 * GB,
    addedAt: '2026-10-20T11:57:00.000Z',
    updatedAt: '2026-10-20T13:20:00.000Z',
    step: 7,
    runKind: 'revise',
    round: 1,
    preview: { durationSec: 6, width: 1920, height: 1080 },
    sampleShape: 'landscape',
  },
  {
    id: 'p3',
    state: 'editing',
    name: 'Spring promo',
    client: 'Kova Coffee',
    inputs: [8, 1, 3, 0],
    sizeBytes: 1.9 * GB,
    addedAt: '2026-10-20T11:30:00.000Z',
    updatedAt: '2026-10-20T13:41:00.000Z',
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
    runKind: 'revise',
    // One round of notes was sent, so this is the second cut: the row says "round 2".
    round: 1,
    preview: { durationSec: 6, width: 1080, height: 1920 },
  },
  {
    id: 'p4',
    state: 'editing',
    name: 'Hiring reel',
    client: 'Lumen Dental',
    inputs: [10, 0, 2, 1],
    sizeBytes: 2.4 * GB,
    addedAt: '2026-10-20T10:05:00.000Z',
    updatedAt: '2026-10-20T13:42:00.000Z',
    step: 8,
    etaSec: 180,
    runKind: 'render',
    round: 1,
    approvedAt: '2026-10-20T13:41:30.000Z',
    preview: { durationSec: 6, width: 1080, height: 1920 },
  },
  {
    id: 'p5',
    state: 'ready',
    name: 'Customer story · Dana',
    client: 'Lumen Dental',
    inputs: [9, 1, 0, 0],
    sizeBytes: 1.7 * GB,
    addedAt: '2026-10-20T11:05:00.000Z',
    updatedAt: '2026-10-20T12:42:00.000Z',
    step: 8,
    runKind: 'render',
    approvedAt: '2026-10-20T12:20:00.000Z',
    output: { durationSec: 45, width: 1080, height: 1920, sizeBytes: 62 * MB },
  },
];

const LAW = 'עו״ד דוד לוי';
const MYTH = 'מיתוס או אמת';
const FAQ = 'שאלות נפוצות';

/**
 * The rows of the Series boards (`--series`, board SeriesJobs): the client עו״ד דוד לוי with its
 * two series, and two other jobs. The states, ages and queue places are the board's at the
 * canvas's moment; the sizes and inputs are plausible. Episodes 5 are the formats (`ready`).
 */
export const SERIES_JOB_SPECS: readonly CanvasJobSpec[] = [
  {
    id: 'm5',
    state: 'ready',
    name: `${MYTH} 5`,
    client: LAW,
    inputs: [7, 0, 1, 0],
    sizeBytes: 1.4 * GB,
    addedAt: '2026-10-20T08:50:00.000Z',
    updatedAt: '2026-10-20T09:42:00.000Z',
    step: 8,
    output: { durationSec: 36, width: 1080, height: 1920, sizeBytes: 26 * MB },
  },
  {
    id: 'm6',
    state: 'review',
    name: `${MYTH} 6`,
    client: LAW,
    inputs: [7, 0, 1, 0],
    sizeBytes: 1.5 * GB,
    addedAt: '2026-10-20T11:50:00.000Z',
    updatedAt: '2026-10-20T13:30:00.000Z',
    step: 7,
    // The sample composition is 6 s long, so Review plays it; the board's line says 0:38.
    preview: { durationSec: 6, width: 1080, height: 1920 },
    sampleShape: 'portrait',
  },
  {
    id: 'm7',
    state: 'editing',
    name: `${MYTH} 7`,
    client: LAW,
    inputs: [6, 0, 1, 0],
    sizeBytes: 1.2 * GB,
    addedAt: '2026-10-20T12:30:00.000Z',
    updatedAt: '2026-10-20T13:42:00.000Z',
    step: 5,
    etaSec: 120,
  },
  {
    id: 'm8',
    state: 'queued',
    name: `${MYTH} 8`,
    client: LAW,
    inputs: [6, 0, 1, 0],
    sizeBytes: 1.3 * GB,
    addedAt: '2026-10-20T13:20:00.000Z',
    updatedAt: '2026-10-20T13:41:00.000Z',
    settledAt: '2026-10-20T13:21:00.000Z',
  },
  {
    id: 'rgm',
    state: 'queued',
    name: 'טורניר בחירות – הכרזה',
    client: 'RGM',
    inputs: [2, 1, 0, 0],
    sizeBytes: 420 * MB,
    addedAt: '2026-10-20T13:35:00.000Z',
    updatedAt: '2026-10-20T13:39:00.000Z',
    settledAt: '2026-10-20T13:36:00.000Z',
  },
  {
    id: 'f5',
    state: 'ready',
    name: `${FAQ} 5`,
    client: LAW,
    inputs: [3, 0, 0, 0],
    sizeBytes: 900 * MB,
    addedAt: '2026-10-20T10:10:00.000Z',
    updatedAt: '2026-10-20T13:02:00.000Z',
    step: 8,
    output: { durationSec: 34, width: 1080, height: 1920, sizeBytes: 24 * MB },
  },
  {
    id: 'f6',
    state: 'queued',
    name: `${FAQ} 6`,
    client: LAW,
    inputs: [3, 0, 0, 0],
    sizeBytes: 900 * MB,
    addedAt: '2026-10-20T13:10:00.000Z',
    updatedAt: '2026-10-20T13:38:00.000Z',
    settledAt: '2026-10-20T13:38:00.000Z',
  },
  {
    id: 'dk',
    state: 'ready',
    name: 'סיור בפרויקט',
    client: 'LAKESHORE',
    inputs: [9, 1, 0, 0],
    sizeBytes: 2.1 * GB,
    addedAt: '2026-10-20T09:30:00.000Z',
    updatedAt: '2026-10-20T11:42:00.000Z',
    step: 8,
    output: { durationSec: 44, width: 1080, height: 1920, sizeBytes: 31 * MB },
  },
];

/** A series of the Series boards: its format is one of its episodes, and its series.md is written. */
export interface CanvasSeriesSpec {
  name: string;
  /** The episode that is the format (Start a series' job: pinned to the series). */
  formatJobId: string;
  /** Its episodes, by job id and number (the number the job's name gives). */
  episodes: readonly { jobId: string; episode: number }[];
  /** The series.md, written to `_Series/<name>/series.md` of the client's folder. */
  markdown: string;
}

/** `series.md` of מיתוס או אמת: the text of the SeriesFormat board, one line per entry. */
const MYTH_SERIES_MD = [
  `# Series: ${MYTH}`,
  `Format from ${MYTH} 5 (21 Oct 2026). Fonts, colours and captions come from the style of ${LAW}.`,
  '## Flow',
  '- 0:00–0:03.6 · Opening: the title typed letter by letter on a blurred still of the speaker, with the typing sound',
  '- 0:03.6 · The stamp slams in on the first spoken word, with the seal stamp sound, and is gone 1.1 s later',
  '- 0:03.6 to the end · The answer, cut tight on word edges, with captions throughout',
  '- The music runs under everything and fades out at the end',
  '## Same in every episode',
  '- Title: white Heebo 800, 84 px, right-aligned, 190 px side margins, top 830 px. Typing starts at 0.35 s, a letter every 0.067 s; it fades out at 3.3 s',
  '- Stamp: red Heebo 800, 140 px, centred, top 1130 px, scaling from 2.2 to 1 in 0.14 s',
  '- Music: News Tv Cinematic Intro by Infraction, low under the whole video',
  '- Sounds: typing under the title, the seal stamp on the stamp, nothing under the answer',
  '- Canvas: 1080×1920 at 29.97 fps, about 35 s',
  '## New in each episode',
  '- Title: from the client’s brief, word for word',
  '- Stamp: the verdict word from the brief (מיתוס in episode 5)',
  '- Footage: the clips in the episode’s folder',
  '- Captions: from the speech',
  '## Kit',
  `- The composition of ${MYTH} 5, with the title, the stamp word and the captions left open`,
]
  .join('\n')
  .concat('\n');

/**
 * `series.md` of שאלות נפוצות. A short stand-in: the design has no format text for this series.
 */
const FAQ_SERIES_MD = [
  `# Series: ${FAQ}`,
  `Format from ${FAQ} 5. Fonts, colours and captions come from the style of ${LAW}.`,
  '## Flow',
  '- The question on screen, then the answer, cut tight on word edges, with captions throughout',
  '## Same in every episode',
  '- Canvas: 1080×1920',
  '## New in each episode',
  '- Question: from the client’s brief, word for word',
  '- Captions: from the speech',
]
  .join('\n')
  .concat('\n');

/** The two series of the Series boards (`--series`). */
export const CANVAS_SERIES_SPECS: readonly CanvasSeriesSpec[] = [
  {
    name: MYTH,
    formatJobId: 'm5',
    episodes: [
      { jobId: 'm5', episode: 5 },
      { jobId: 'm6', episode: 6 },
      { jobId: 'm7', episode: 7 },
      { jobId: 'm8', episode: 8 },
    ],
    markdown: MYTH_SERIES_MD,
  },
  {
    name: FAQ,
    formatJobId: 'f5',
    episodes: [
      { jobId: 'f5', episode: 5 },
      { jobId: 'f6', episode: 6 },
    ],
    markdown: FAQ_SERIES_MD,
  },
];

/**
 * Puts the series into the seed, through the repositories the engine uses: each series is stored
 * `ready` (`SeriesRepository.create`), its format job is pinned to it as Start a series leaves it,
 * the episodes join it (`JobRepository.setSeries`), and its series.md is written into
 * `_Series/<name>/` of the seed inbox. The jobs must already be seeded.
 */
export async function seedCanvasSeries(
  inboxPath: string,
  jobRepo: JobRepository,
  seriesRepo: SeriesRepository,
  specs: readonly CanvasSeriesSpec[] = CANVAS_SERIES_SPECS,
): Promise<void> {
  for (const spec of specs) {
    const format = jobRepo.get(spec.formatJobId);
    if (format === null) throw new Error(`The format job ${spec.formatJobId} is not seeded.`);
    const stored = seriesRepo.create({
      clientId: format.clientId,
      client: format.client,
      name: spec.name,
      formatJobId: format.id,
      formatJob: format.name,
      state: 'ready',
    });
    // One learned series.md, so the series page reads as learned.
    seriesRepo.update(stored.id, { version: 1 });
    for (const episode of spec.episodes) {
      jobRepo.setSeries(episode.jobId, {
        seriesId: stored.id,
        episode: episode.episode,
        pinned: episode.jobId === spec.formatJobId,
      });
    }
    const path = seriesFileFor(inboxPath, format.client, spec.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, spec.markdown);
  }
}

/**
 * The two series of the Job sheet boards (`--sheet`): the lawyer's "מיתוס או אמת" (the format is
 * episode 5, the paid job; episode 6 is the one being edited) and "שאלות נפוצות" (episode 5, the
 * job in Review on its second cut). The series.md files are the Series boards' own.
 */
export const SHEET_SERIES_SPECS: readonly CanvasSeriesSpec[] = [
  { ...(CANVAS_SERIES_SPECS[0] as CanvasSeriesSpec), ...SHEET_SERIES_JOBS.myth },
  { ...(CANVAS_SERIES_SPECS[1] as CanvasSeriesSpec), ...SHEET_SERIES_JOBS.faq },
];

/** The lawyer's "מיתוס או אמת" of the Soundtrack boards (`--music`): episode 5 is the format, episode 6 is in Review. */
export const MUSIC_SERIES_SPECS: readonly CanvasSeriesSpec[] = [
  { ...(CANVAS_SERIES_SPECS[0] as CanvasSeriesSpec), ...MUSIC_SERIES_JOBS },
];

function inputCounts([video, audio, image, doc]: CanvasJobSpec['inputs']): InputCounts {
  return { video, audio, image, doc };
}

/** The export's path inside the exports folder: `Client/Job.mp4`. */
function exportName(spec: CanvasJobSpec): string {
  return `${spec.client}/${spec.name}.mp4`;
}

/**
 * The stored jobs, with every time moved by `shiftMs` (0 keeps the canvas's own times; the gap
 * between the canvas's "now" and the real now makes the ages read the same today).
 */
export function canvasStoredJobs(
  shiftMs = 0,
  specs: readonly CanvasJobSpec[] = CANVAS_JOB_SPECS,
): StoredJob[] {
  const at = (iso: string): string => new Date(Date.parse(iso) + shiftMs).toISOString();
  return specs.map((spec): StoredJob => {
    const addedAt = at(spec.addedAt);
    // The settle timer runs 60 s from the last file change (SETTLE_MS in @studio/shared).
    const lastChangeAt =
      spec.lastChangeAt !== undefined
        ? at(spec.lastChangeAt)
        : spec.settlesInSec === undefined
          ? addedAt
          : at(new Date(Date.parse(CANVAS_NOW) + (spec.settlesInSec - 60) * 1000).toISOString());
    return {
      id: spec.id,
      clientId: clientIdFor(spec.client),
      client: spec.client,
      name: spec.name,
      relPath: `${spec.client}/${spec.name}`,
      state: spec.state,
      step: spec.step ?? null,
      subProgress: spec.subProgress ?? null,
      etaSec: null,
      placeInLine: null,
      settlesAt: null,
      failedAt: spec.failedAt ?? null,
      error: spec.error ?? null,
      stoppedAt: spec.stoppedAt ?? null,
      inputs: inputCounts(spec.inputs),
      sizeBytes: spec.sizeBytes,
      addedAt,
      lastChangeAt,
      settledAt: spec.settledAt === undefined ? null : at(spec.settledAt),
      heldSettledAt: spec.heldSettledAt === undefined ? null : at(spec.heldSettledAt),
      runKind: spec.runKind ?? 'edit',
      round: spec.round ?? 0,
      preview: spec.preview ?? null,
      approvedAt: spec.approvedAt === undefined ? null : at(spec.approvedAt),
      delivery: null,
      effort: spec.effort ?? null,
      reviewEffort: spec.reviewEffort ?? null,
      reviseTier: null,
      fixing: null,
      fixedCount: 0,
      reviseMinutes: null,
      seriesId: null,
      episode: null,
      archivedAt: spec.archivedAt === undefined ? null : at(spec.archivedAt),
      updatedAt: at(spec.updatedAt),
      output: spec.output === undefined ? null : { fileName: exportName(spec), ...spec.output },
      note: spec.note ?? null,
      footageSec: 0,
      startedAt:
        spec.startedAt !== undefined
          ? at(spec.startedAt)
          : spec.state === 'editing'
            ? at('2026-10-20T13:30:00.000Z')
            : null,
      finishedAt:
        spec.finishedAt !== undefined
          ? at(spec.finishedAt)
          : ['ready', 'failed', 'cancelled', 'review'].includes(spec.state)
            ? at(spec.updatedAt)
            : null,
      attempt: 1,
      reviewSec: 0,
      seriesPinned: false,
    };
  });
}

/** Writes the jobs (the twelve, by default) into an empty, migrated database. */
export function seedCanvasJobs(
  db: StudioDb,
  shiftMs = 0,
  specs: readonly CanvasJobSpec[] = CANVAS_JOB_SPECS,
): void {
  for (const job of canvasStoredJobs(shiftMs, specs)) {
    db.orm
      .insert(jobs)
      .values({ id: job.id, ...storedToColumns(job) })
      .run();
  }
  // The deliveries of the jobs that have one (`Job.delivery` is read from this table).
  for (const spec of specs) {
    if (spec.delivery === undefined) continue;
    const at = (iso: string): number => Date.parse(iso) + shiftMs;
    db.orm
      .insert(deliveries)
      .values({
        jobId: spec.id,
        clientId: clientIdFor(spec.client),
        client: spec.client,
        name: spec.name,
        relPath: `${spec.client}/${spec.name}`,
        deliveredAt: at(spec.delivery.deliveredAt),
        price: 40,
        currency: 'ILS',
        reviewSec: 0,
        paidOn:
          spec.delivery.paidOn === undefined
            ? null
            : new Date(at(spec.delivery.paidOn)).toISOString().slice(0, 10),
      })
      .run();
  }
}

/** Placeholder exports, so Download answers 200 for the ready jobs. They are not real videos. */
export async function writeCanvasExports(
  exportsDir: string,
  specs: readonly CanvasJobSpec[] = CANVAS_JOB_SPECS,
): Promise<void> {
  for (const spec of specs) {
    if (spec.output === undefined) continue;
    const path = join(exportsDir, exportName(spec));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(16 * KB));
  }
}

/** The sample composition's size, which landscape copies turn around. */
const PORTRAIT_TO_LANDSCAPE: readonly (readonly [from: string, to: string])[] = [
  ['data-width="1080" data-height="1920"', 'data-width="1920" data-height="1080"'],
  ['width: 1080px; height: 1920px;', 'width: 1920px; height: 1080px;'],
  ['width=1080, height=1920', 'width=1920, height=1080'],
];

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Puts a copy of the sample composition into the edit/preview/ of each job that has a
 * `sampleShape`, under `<inboxPath>/<Client>/<Job>/`, so the live preview route has something to
 * play. The copy carries the job's name instead of "Sample preview" (the title and the title
 * element), and a landscape one is turned into 1920×1080.
 */
export async function writeReviewPreviews(
  inboxPath: string,
  specs: readonly CanvasJobSpec[],
): Promise<void> {
  for (const spec of specs) {
    if (spec.sampleShape === undefined) continue;
    const previewDir = join(inboxPath, spec.client, spec.name, 'edit', 'preview');
    await cp(SAMPLE_PREVIEW_DIR, previewDir, { recursive: true });

    const editFile = async (relPath: string, edit: (text: string) => string): Promise<void> => {
      const path = join(previewDir, relPath);
      await writeFile(path, edit(await readFile(path, 'utf8')));
    };
    const landscape = (text: string): string =>
      spec.sampleShape === 'landscape'
        ? PORTRAIT_TO_LANDSCAPE.reduce((acc, [from, to]) => acc.replaceAll(from, to), text)
        : text;
    await editFile('index.html', (text) =>
      landscape(text.replaceAll('Sample preview', escapeHtml(spec.name))),
    );
    if (spec.sampleShape === 'landscape') await editFile('compositions/badge.html', landscape);
  }
}

export interface CanvasServerOptions {
  /** Folder for the database and the exports. Default: a new temp folder, removed by `stop()`. */
  dir?: string;
  /** Default 0: any free port. */
  port?: number;
  /** `canvas` pins the clock to {@link CANVAS_NOW}; a date or `now` (the default) uses the real one. */
  now?: string;
  /** Built web app. Default `apps/web/dist`. */
  webDist?: string;
  /** Start with no jobs at all (the "Jobs · empty" board). */
  empty?: boolean;
  /**
   * `pnpm demo`: every mock set at once, on today's dates: the Jobs rows, Review, Series, Generate,
   * Analytics, Clients × Instagram, Graphics, LUTs, Fonts and Money. No key, no footage, nothing
   * reaches the network.
   */
  demo?: boolean;
  /**
   * Seed the Phase 3 rows ({@link REVIEW_JOB_SPECS}) instead of the twelve, with a playable
   * preview for each job in Review.
   */
  review?: boolean;
  /**
   * Seed the Series boards ({@link SERIES_JOB_SPECS}, with {@link CANVAS_SERIES_SPECS}) instead of
   * the twelve, and turn the Series switch on for this app: the series routes are served, by the
   * real series service. Not together with `review`.
   */
  series?: boolean;
  /**
   * Seed the Job sheet boards ({@link SHEET_JOB_SPECS}: thirteen jobs, one per state, with their
   * step runs, sent notes and the lawyer's two series) instead of the twelve, turn the Series switch
   * on, and put the clock at the boards' day (Thu 22 Oct 2026) unless `now` says otherwise. Not
   * together with `review` or `series`.
   */
  sheet?: boolean;
  /** The Job sheet switch, which `/api/health` reports. Default true, as in the app. */
  jobSheet?: boolean;
  /**
   * Turn the Phone switch on for this app only: `/api/health` says `phone: true`, so a window under
   * 768 px (a browser at 390 px) shows the phone layout. Changes no rows, so it goes with any of
   * the options above.
   */
  phone?: boolean;
  /**
   * Turn the Analytics switch on for this app only and seed the page's records
   * ({@link buildAnalyticsSeed}) instead of the twelve rows: about forty finished jobs over 13
   * weeks, their steps, notes, deliveries and the three logs. With `empty` the switch is on and
   * nothing is recorded. Not together with `review` or `series`.
   */
  analytics?: boolean;
  /**
   * Turn the Graphics switch (and "Edits can use it") on for this app only and seed the library of
   * the GRLibrary board ({@link seedGraphics}): seven graphics with their chats and versions. The
   * job rows stay as the other options leave them, so it goes with any of them.
   */
  graphics?: boolean;
  /** The Graphics switch on with no graphic made: the "Nothing made yet" board. Implies `graphics`. */
  graphicsEmpty?: boolean;
  /** How much faster than real time the graphic run goes (default 1: 3 s a version). Tests pass more. */
  graphicSpeed?: number;
  /**
   * Turn the LUTs switch on for this app only and seed Yours ({@link seedLuts}): four LUTs with
   * their files in `_LUTs/`, used counts and added times. Built in is read from the installed
   * colour-grade skill. The job rows stay as the other options leave them, so it goes with any of
   * them.
   */
  luts?: boolean;
  /** The LUTs switch on with nothing of Yours: the "Nothing imported yet" board. Implies `luts`. */
  lutsEmpty?: boolean;
  /**
   * Turn the Fonts switch on for this app only, with `fontsInNotes` on as the app has it (nothing
   * else changes) and seed the library ({@link seedFonts}): copies of the test fonts in `_Fonts/`
   * with added times and "used by" rows (counted while `fontsInNotes` is on, as the engine does).
   * The job rows stay as the other options leave them, so it goes with any of them.
   */
  fonts?: boolean;
  /** The Fonts switch on with an empty `_Fonts`: the empty-library board. Implies `fonts`. */
  fontsEmpty?: boolean;
  /**
   * The `fontsInNotes` switch (the list's used column, Copy @name, the delete sentence about
   * notes, "To use it" in the pane, the font group in the @ picker). Left out, it is on, as in the
   * app; `true` is the explicit flag and `false` turns it off (`--no-fonts-in-notes`); either one
   * implies `fonts`.
   */
  fontsInNotes?: boolean;
  /**
   * `fonts`, and this many (1 to 3) open requests for a font the library does not have, made
   * by the first jobs of the seed ({@link seedFontRequests}): the banner on top of the Fonts page.
   * Implies `fontsInNotes` (a request is shown only while notes can name a font).
   */
  fontsMissing?: number;
  /**
   * Who makes the graded stills of the LUTs page: `real` runs ffmpeg, `fake` copies the plain frame
   * (no ffmpeg; the slider shows no difference). Default: `real` when ffmpeg runs here, else `fake`.
   */
  lutPreviews?: 'real' | 'fake';
  /**
   * Seed the Soundtrack boards ({@link MUSIC_JOB_SPECS}: twelve jobs, one per state of the Music
   * list and of the job sheet's Music row, with their music files) instead of the twelve, turn the
   * Soundtrack and Series switches on, and put the clock at the boards' moment (23 Oct 2026, 00:20
   * UTC) unless `now` says otherwise. Needs ffmpeg. Not together with `review`, `series`, `sheet` or
   * `analytics`.
   */
  music?: boolean;
  /**
   * Turn the Soundtrack and Songs switches on for this app only and seed the jobs of the Songs boards
   * ({@link SONGS_JOB_SPECS}: twelve jobs, one per state of Review's Music list, of Note for the editor
   * and of the job sheet's two files) instead of the twelve, with the second file's routes over the
   * engine's own `NoSongExports` (a stand-in render) and the note's picture routes. The clock starts at
   * the boards' moment (24 Oct 2026, 21:30 UTC) unless `now` says otherwise. Needs ffmpeg. Not together
   * with `review`, `series`, `sheet`, `analytics`, `music` or `quickFixes`.
   */
  songs?: boolean;
  /**
   * Turn the Quick fixes switch on for this app only and seed the jobs of the Quick fixes boards
   * ({@link QUICK_FIX_JOB_SPECS}: eleven jobs in Review, one per state) instead of the twelve. The
   * note routing, the fix service and the fix routes are the real ones over the seed's database,
   * with the fake router and the fake quick fix. Not together with `review`, `series`, `sheet`,
   * `analytics` or `music`.
   */
  quickFixes?: boolean;
  /** How much faster than real time the fake fix goes (default 1: about 2 s a fix). Slower is below 1. */
  fixSpeed?: number;
  /**
   * Turn the Generate switch on for this app only and seed the jobs of Generated videos
   * ({@link GENERATE_JOB_SPECS}: four jobs in Review and one for each state of the stage, GN9) instead of the twelve: a generated job with two
   * formats and the board's three notes, a generated job with one format, an ordinary job, and a
   * footage job with two formats. No call to Higgsfield or ElevenLabs, no key. Not together with
   * `review`, `series`, `sheet`, `analytics`, `music`, `songs` or `quickFixes`.
   */
  generate?: boolean;
  /**
   * Turn the Draft & chat switch on for this app only and seed {@link CHAT_JOB_SPECS} instead of the
   * twelve, their chats built by the real feed service from `chatLog` (default
   * {@link DEFAULT_CHAT_LOG}). Not together with the other options that seed rows.
   */
  chat?: boolean;
  /** The job log the `chat` rows are built from. */
  chatLog?: string;
  /**
   * Turn the Clients × Instagram switch on for this app only and seed {@link INSTAGRAM_JOB_SPECS} and
   * the Instagram of the boards CLPage, CLStates and CLList ({@link createInstagramSeed}) instead of
   * the twelve. The clock starts at the boards' moment (26 Oct 2026, 06:30 UTC) unless `now` says
   * otherwise. Not together with the other options that seed rows.
   */
  instagram?: boolean;
  /** Seconds each run of a live fake scan takes, with `instagram` (default 4). */
  scanSeconds?: number;
}

/** What Finder was asked to show: the seed never opens it. */
export interface FinderCalls {
  /** Folders asked to be opened (Show the folder in Finder). */
  folders: string[];
  /** Files asked to be shown selected (Show the MP4 in Finder). */
  files: string[];
}

export interface CanvasServer {
  url: string;
  dir: string;
  /**
   * Where a job's live preview is read from: `<inboxPath>/<Client>/<Job>/edit/preview/`. Empty
   * until something is put there.
   */
  inboxPath: string;
  jobs: JobRepository;
  /** The Graphics library, with `graphics` or `graphicsEmpty`; `null` without them. */
  graphicsRepo: GraphicRepository | null;
  /** The LUTs of Yours, with `luts` or `lutsEmpty`; `null` without them. */
  lutsRepo: LutRepository | null;
  /** The Fonts library's two small tables, with `fonts` or `fontsEmpty`; `null` without them. */
  fontsRepo: FontRepository | null;
  /** The jobs' music, with `music` or `songs`; `null` without them. */
  music: MusicService | null;
  /** The second file of a job whose music is a song, with `songs`; `null` without it. */
  noSong: NoSongExports | null;
  /** The quick fixes of Review, with `quickFixes`; `null` without it. */
  fixes: FixService | null;
  /** The event bus the page listens to: publish a `job.upsert` or `job.remove` for a change made on `jobs`. */
  bus: EventBus;
  /** What Finder was asked to show, instead of Finder being asked. */
  finder: FinderCalls;
  stop(): Promise<void>;
}

/** Whether `ffmpeg` runs here. */
function ffmpegRuns(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** A job's folder as the database compares it: two jobs of one folder cannot both be seeded. */
const folderKey = (job: { client: string; name: string }): string =>
  `${job.client}/${job.name}`.toLowerCase();

/**
 * `--demo`: the rows whose times follow the clock (the Instagram ones follow the last scan). The
 * boards reuse a few folders: the first set to name one keeps it, Generate and Series first because
 * their seeds look their jobs up by id.
 */
const DEMO_JOB_SPECS: readonly CanvasJobSpec[] = (() => {
  const byFolder = new Map<string, CanvasJobSpec>();
  for (const spec of [
    ...GENERATE_JOB_SPECS,
    ...SERIES_JOB_SPECS,
    ...REVIEW_JOB_SPECS,
    ...CANVAS_JOB_SPECS,
  ]) {
    if (!byFolder.has(folderKey(spec))) byFolder.set(folderKey(spec), spec);
  }
  return [...byFolder.values()];
})();

/** The row sets are drawn for one board each: only `--demo` takes them together. */
function assertOneRowSet(options: CanvasServerOptions): void {
  const seeded = [options.review, options.series, options.sheet].filter(Boolean).length;
  if (seeded > 1) {
    throw new Error('--review, --series and --sheet seed different rows: pass one of them.');
  }
  if (options.analytics && (options.series || options.review || options.sheet)) {
    throw new Error(
      '--analytics seeds its own rows: do not pass --series, --review or --sheet with it.',
    );
  }
  if (
    options.songs &&
    (options.series ||
      options.review ||
      options.sheet ||
      options.analytics ||
      options.music ||
      options.quickFixes)
  ) {
    throw new Error(
      '--songs seeds its own rows: do not pass --series, --review, --sheet, --analytics, --music or --quick-fixes with it.',
    );
  }
  if (options.music && (options.series || options.review || options.sheet || options.analytics)) {
    throw new Error(
      '--music seeds its own rows: do not pass --series, --review, --sheet or --analytics with it.',
    );
  }
  if (
    options.quickFixes &&
    (options.series ||
      options.review ||
      options.sheet ||
      options.analytics ||
      options.music ||
      options.songs)
  ) {
    throw new Error(
      '--quick-fixes seeds its own rows: do not pass --series, --review, --sheet, --analytics, --music or --songs with it.',
    );
  }
  if (
    options.generate &&
    (options.series ||
      options.review ||
      options.sheet ||
      options.analytics ||
      options.music ||
      options.songs ||
      options.quickFixes)
  ) {
    throw new Error(
      '--generate seeds its own rows: do not pass --series, --review, --sheet, --analytics, --music, --songs or --quick-fixes with it.',
    );
  }
  if (
    options.instagram &&
    (options.series ||
      options.review ||
      options.sheet ||
      options.analytics ||
      options.music ||
      options.songs ||
      options.quickFixes ||
      options.generate ||
      options.chat)
  ) {
    throw new Error(
      '--instagram seeds its own rows: do not pass --series, --review, --sheet, --analytics, --music, --songs, --quick-fixes, --generate or --chat with it.',
    );
  }
}

export async function startCanvasServer(input: CanvasServerOptions = {}): Promise<CanvasServer> {
  const options: CanvasServerOptions = input.demo
    ? {
        ...input,
        series: true,
        analytics: true,
        instagram: true,
        generate: true,
        graphics: true,
        luts: true,
        fonts: true,
        phone: true,
      }
    : input;
  if (!options.demo) assertOneRowSet(options);
  const ownsDir = options.dir === undefined;
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'studio-canvas-seed-')));
  await mkdir(dir, { recursive: true });

  const realStart = Date.now();
  // The Job sheet boards are drawn on their own day, which is where the clock starts without --now.
  const now =
    options.now ??
    (options.demo
      ? 'now'
      : options.sheet
        ? 'sheet'
        : options.music
          ? 'music'
          : options.songs
            ? 'songs'
            : options.instagram
              ? 'instagram'
              : undefined);
  const nowAt =
    now === undefined || now === 'now'
      ? realStart
      : now === 'canvas'
        ? Date.parse(CANVAS_NOW)
        : now === 'sheet'
          ? Date.parse(SHEET_NOW)
          : now === 'music'
            ? Date.parse(MUSIC_NOW)
            : now === 'songs'
              ? Date.parse(SONGS_NOW)
              : now === 'instagram'
                ? Date.parse(INSTAGRAM_NOW)
                : Date.parse(now);
  if (Number.isNaN(nowAt))
    throw new Error(`--now must be "now", "canvas" or a date: ${options.now}`);
  // The specs' times are the board's own: moved as far as the clock is from the board's moment.
  const shiftMs =
    nowAt -
    Date.parse(
      options.demo
        ? CANVAS_NOW
        : options.sheet
          ? SHEET_NOW
          : options.music
            ? MUSIC_NOW
            : options.songs
              ? SONGS_NOW
              : options.instagram
                ? INSTAGRAM_NOW
                : CANVAS_NOW,
    );
  // The server's clock starts at `nowAt` and keeps running, so a Hold or a Retry is stamped in the
  // same "today" as the jobs, even when the clock is pinned to the canvas's moment.
  const clock = (): Date => new Date(Date.now() - realStart + nowAt);

  const db = openDatabase(join(dir, 'canvas.db'));
  const exportsDir = join(dir, 'exports');
  const inboxPath = join(dir, 'inbox');
  // --demo: the Instagram jobs' dates go with the scans', on the last Monday; the others with the clock.
  const demoAnchor = lastScanMonday(nowAt);
  const demoMoney = options.demo ? createDemoMoney(dir, nowAt) : null;
  if (options.demo) setHomeCurrencySymbol('$');
  const specs: readonly CanvasJobSpec[] = options.demo
    ? [...DEMO_JOB_SPECS, ...INSTAGRAM_JOB_SPECS]
    : options.analytics
      ? []
      : options.review
        ? REVIEW_JOB_SPECS
        : options.series
          ? SERIES_JOB_SPECS
          : options.sheet
            ? SHEET_JOB_SPECS
            : options.music
              ? MUSIC_JOB_SPECS
              : options.songs
                ? SONGS_JOB_SPECS
                : options.quickFixes
                  ? QUICK_FIX_JOB_SPECS
                  : options.generate
                    ? GENERATE_JOB_SPECS
                    : options.chat
                      ? CHAT_JOB_SPECS
                      : options.instagram
                        ? INSTAGRAM_JOB_SPECS
                        : CANVAS_JOB_SPECS;
  if (!options.empty) {
    if (options.demo) {
      seedCanvasJobs(db, shiftMs, DEMO_JOB_SPECS);
      seedCanvasJobs(db, demoAnchor - Date.parse(BOARD_ANCHOR), INSTAGRAM_JOB_SPECS);
    } else {
      seedCanvasJobs(db, shiftMs, specs);
    }
    await writeCanvasExports(exportsDir, specs);
    await writeReviewPreviews(inboxPath, specs);
    if (options.sheet) {
      seedJobSheetExtras(db, shiftMs);
      // A folder for each job, so Show the folder in Finder has one to show (to nothing: see `finder`).
      for (const spec of specs)
        await mkdir(join(inboxPath, spec.client, spec.name), { recursive: true });
    }
    if (options.instagram) {
      // A folder for each job too, so Show the folder in Finder has one to show.
      for (const spec of specs)
        await mkdir(join(inboxPath, spec.client, spec.name), { recursive: true });
    }
    if (options.analytics) {
      const seed = buildAnalyticsSeed(nowAt);
      const taken = new Set(specs.map(folderKey));
      await writeAnalyticsSeed(db, dir, exportsDir, {
        ...seed,
        jobs: seed.jobs.filter((job) => !taken.has(folderKey(job))),
      });
    }
    if (options.chat) await writeChatLogs(dir, options.chatLog ?? DEFAULT_CHAT_LOG);
    if (options.songs) {
      seedSongsRuns(db, shiftMs);
      seedSongsNotes(db, shiftMs);
      await seedSongsFiles({
        inboxPath,
        exportsDir,
        dir,
        samplePreviewDir: SAMPLE_PREVIEW_DIR,
        shiftMs,
        specs,
      });
    }
    if (options.music) {
      seedMusicRuns(db, shiftMs);
      await seedMusicFiles({
        inboxPath,
        dir,
        samplePreviewDir: SAMPLE_PREVIEW_DIR,
        shiftMs,
        specs,
      });
    }
  }

  const etaById = new Map(specs.map((spec) => [spec.id, spec.etaSec ?? null]));
  const repository = new JobRepository(db, {
    clock,
    estimateEtaSec: (job) => etaById.get(job.id) ?? null,
    quickFixes: options.quickFixes,
    generate: options.generate,
  });

  const bus = createEventBus();
  followQueuePlaces({ bus, jobs: repository });
  // --instagram: the Instagram routes' side, with the fake scanner (seed-instagram.ts).
  const instagramSeed: InstagramSeed | null = options.instagram
    ? await createInstagramSeed({
        db,
        dir,
        inboxPath,
        exportsDir,
        jobs: repository,
        bus,
        clock,
        scanSeconds: options.scanSeconds,
        empty: options.empty,
        ...(options.demo
          ? {
              anchor: demoAnchor,
              moreClients: repository.getAll().map((job) => job.client),
              recordDelivery: createRecordDelivery({
                deliveries: new DeliveryRepository(db),
                jobs: repository,
                priceFor: demoMoney?.priceFor ?? (() => ({ price: 0, currency: 'ILS' })),
                clock,
                onRecorded: () => bus.publish({ type: 'money.changed' }),
              }),
            }
          : {}),
      })
    : null;
  // The review notes, as the engine builds them (engine.ts): a voice note gets the fake transcript
  // after about a second. Send and Approve queue the job as they do for real, and nothing runs
  // after them, so the job stays queued.
  const notes = new NoteRepository(db, { clock });
  // --generate: the Generate rows (the same table the engine reads), and the jobs' formats, hand-off
  // files and notes.
  const generateRepo = new GenerateRepository(db, { clock });
  if (options.generate && !options.empty) {
    await seedGenerate({
      jobs: repository,
      generate: generateRepo,
      notes,
      db,
      exportsDir,
      shiftMs,
      inboxPath,
      samplePreviewDir: SAMPLE_PREVIEW_DIR,
    });
  }
  const transcriber = createVoiceTranscriber({ kind: 'fake' });
  // --music: the jobs' music as the engine builds it (engine.ts), with the music script on its fake
  // path (a tone, no network, no key). The `make` of "Demo 3" never ends, so that job stays "being
  // made" (and Approve waits) for as long as the seed runs.
  // --songs: the same service (Make music instead and Pick on the script's fake path), with nothing
  // held: no job is being made.
  const music: MusicService | null =
    options.music || options.songs
      ? createMusicService({
          inboxPath,
          logger: { warn: () => {} },
          jobs: repository,
          publish: (event) => bus.publish(event),
          run: options.music
            ? holdingRunner(
                createMusicScriptRunner({ cwd: dir }),
                join(inboxPath, MUSIC_MAKING_JOB.client, MUSIC_MAKING_JOB.name),
              )
            : createMusicScriptRunner({ cwd: dir }),
          fake: true,
        })
      : null;
  // --songs: the second file of a video whose music is the song, as the engine builds it (engine.ts),
  // over this inbox and these exports, with a stand-in for the render (seed-songs.ts). Each start and end
  // republishes the job, so the sheet asks again.
  const noSong: NoSongExports | null = options.songs
    ? new NoSongExports({
        inboxPath,
        exportsDir,
        render: songsNoSongRender(),
        onChanged: (jobId) => {
          const job = repository.get(jobId);
          if (job !== null) bus.publish({ type: 'job.upsert', job });
        },
      })
    : null;
  const stopNoSongListening = noSong?.listen(bus);
  const stopMusicListening = music?.listen(bus);
  // --quick-fixes: the fix service, the note routing and the notes' rules, as the engine builds them
  // (engine.ts), with the fake router and the fake quick fix. Nothing is started: the fixes the
  // seed wrote as running or queued stay so; a note typed afterwards goes through the real queue.
  const fixes: FixService | null = options.quickFixes
    ? createFixService({
        inboxPath,
        jobs: repository,
        notes,
        fixes: new QuickFixRepository(db, { clock }),
        bus,
        runner: new FakeQuickFixRunner({ config: { inboxPath }, speed: options.fixSpeed }),
        clock,
      })
    : null;
  const stopFixListening = fixes?.listen(bus);
  if (fixes !== null) {
    // Started on an empty table: start() fails the fixes an earlier engine left running and cancels
    // the queued ones, so the rows of the states are written after it and stay as they are.
    await fixes.start();
    if (!options.empty) await seedQuickFixes({ db, inboxPath, shiftMs, specs });
  }
  const noteRouting =
    fixes === null
      ? NO_NOTE_ROUTING
      : createNoteRouting({
          enabled: true,
          router: new FakeNoteRouter(),
          jobs: repository,
          notes,
          bus,
          onRouted: (job, note) => {
            fixes.enqueue(job, note);
          },
        });
  const review = createReviewService({
    db,
    jobs: repository,
    notes,
    bus,
    inboxPath,
    transcriber,
    clock,
    ...(fixes === null && music === null
      ? {}
      : {
          reviewBlock: (job: Job) =>
            fixes?.reviewBlock(job.id) ?? music?.reviewBlock(job.id) ?? null,
        }),
    routing: noteRouting,
    ...(fixes === null
      ? {}
      : {
          fixes: {
            beforeEdit: (note) => fixes.beforeNoteEdit(note),
            beforeDelete: (note) => fixes.beforeNoteDelete(note),
            said: (note) =>
              note.fixId === null ? null : (fixes.find(note.jobId, note.fixId)?.said ?? null),
            clearRound: (jobId: string) => fixes.clearRound(jobId),
          },
        }),
  });
  // No run exists to stop, so Cancel is applied by the repository (`null` means "nothing to stop").
  const worker: ActionWorker = { cancel: async () => null, notify() {} };
  // --series and --sheet: the Series switch is on for this app only. The real series service over this
  // database, with the fake style runner. Its worker is never started, so no pass runs by itself.
  const seriesRepo = new SeriesRepository(db, { clock });
  let series: SeriesService | undefined;
  let styleWorker: StyleWorker | undefined;
  if (options.series || options.sheet || options.music) {
    if (!options.empty) {
      await seedCanvasSeries(
        inboxPath,
        repository,
        seriesRepo,
        options.sheet
          ? SHEET_SERIES_SPECS
          : options.music
            ? MUSIC_SERIES_SPECS
            : CANVAS_SERIES_SPECS,
      );
    }
    const clientStyles = new ClientStyleRepository(db, { clock });
    styleWorker = new StyleWorker({
      clientStyles,
      inboxPath,
      dataDir: dir,
      runner: new FakeStyleRunner({ clock }),
    });
    series = createSeriesService({
      inboxPath,
      jobs: repository,
      seriesRepo,
      clientStyles,
      worker: styleWorker,
      onJobChanged: (job) => bus.publish({ type: 'job.upsert', job }),
      clock,
    });
    // Published as engine.ts publishes them.
    series.onChange((change) => {
      if (change.type === 'removed') {
        bus.publish({
          type: 'series.removed',
          seriesId: change.seriesId,
          clientId: change.clientId,
        });
      } else {
        bus.publish({ type: 'series.changed', series: change.series });
      }
    });
  }
  const streams = new AbortController();
  // The job sheet's steps, sent notes and Show in Finder, over this database. Finder is never asked.
  const finder: FinderCalls = { folders: [], files: [] };
  // --graphics / --graphics-empty: the Graphics library as the engine builds it (engine.ts), over
  // this database and this inbox, with the fake graphic run and the seed's clock. The worker is
  // never started, so the graphic seeded as being made stays so; a graphic that is sent works.
  const graphicsOn = options.graphics === true || options.graphicsEmpty === true;
  let graphicsRepo: GraphicRepository | null = null;
  let graphicWorker: GraphicWorker | null = null;
  let graphicsApi: GraphicsApiOptions | undefined;
  if (graphicsOn) {
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    // A delete goes to a Trash of the seed's own, never the real one.
    const folders = new GraphicFolders({ inboxPath, dataDir: dir, home: join(dir, 'home') });
    if (!options.graphicsEmpty) {
      let seedAt = nowAt;
      await seedGraphics({
        repo: new GraphicRepository(db, { clock: () => new Date(seedAt) }),
        setNow: (at) => {
          seedAt = at;
        },
        folders,
        now: nowAt,
      });
    }
    graphicsRepo = new GraphicRepository(db, { clock });
    const publish = (event: Parameters<EventBus['publish']>[0]): void => bus.publish(event);
    graphicWorker = new GraphicWorker({
      repo: graphicsRepo,
      folders,
      runner: new FakeGraphicRunner({ speed: options.graphicSpeed }),
      publish,
      logger,
      clock,
    });
    graphicsApi = {
      graphics: {
        service: createGraphicService({
          repo: graphicsRepo,
          folders,
          worker: graphicWorker,
          publish,
          usedIn: true,
          openFolder: async (path) => {
            finder.folders.push(path);
          },
          logger,
          clock,
        }),
      },
      files: { graphics: graphicsRepo, inboxPath, assetsDir: GRAPHICS_ASSETS_DIR },
      voice: { transcriber, dataDir: dir },
    };
  }
  // --luts / --luts-empty: the LUTs service as the engine builds it (engine.ts), over this database
  // and this inbox, with the fake preview maker, the static check alone (no ffmpeg) and the seed's
  // clock. Show in Finder is recorded; a delete goes to a Trash of the seed's own.
  const lutsOn = options.luts === true || options.lutsEmpty === true;
  let lutsRepo: LutRepository | null = null;
  let lutsApi: LutsApiOptions | undefined;
  if (lutsOn) {
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    if (!options.lutsEmpty) {
      let seedAt = nowAt;
      await seedLuts({
        repo: new LutRepository(db, { clock: () => new Date(seedAt) }),
        setNow: (at) => {
          seedAt = at;
        },
        inboxPath,
        now: nowAt,
      });
    }
    lutsRepo = new LutRepository(db, { clock });
    const builtIn = createBuiltInLuts({ dataDir: dir, logger });
    const previews =
      (options.lutPreviews ?? (ffmpegRuns() ? 'real' : 'fake')) === 'real'
        ? createRealLutPreviews({ dataDir: dir, logger })
        : createFakeLutPreviews({ dataDir: dir, logger });
    lutsApi = {
      luts: {
        service: createLutService({
          repo: lutsRepo,
          builtIn,
          staging: createLutStaging({ dataDir: dir, clock }),
          previews,
          inboxPath,
          publish: (event) => bus.publish(event),
          usedIn: false,
          openFolder: async (path) => {
            finder.files.push(path);
          },
          prover: async () => null,
          dataDir: dir,
          home: join(dir, 'home'),
          logger,
          clock,
        }),
      },
      previews: { luts: lutsRepo, builtIn, previews, inboxPath },
    };
  }
  // --fonts / --fonts-empty: the Fonts service as the engine builds it (engine.ts), over this
  // database and this inbox, with the seed's clock: the real index and watcher on <inbox>/_Fonts, so
  // a file copied in while the seed runs shows up. As in the engine, the service counts use (usedIn)
  // while the fontsInNotes switch is on (it is, unless --no-fonts-in-notes): then the sample "used
  // by" counts show, as in the boards and as the live page reads. Show in Finder is recorded;
  // a delete goes to a Trash of the seed's own.
  const fontsMissing = options.fontsMissing ?? 0;
  const fontsInNotes = fontsMissing > 0 || options.fontsInNotes !== false;
  const fontsOn =
    options.fonts === true ||
    options.fontsEmpty === true ||
    options.fontsInNotes !== undefined ||
    fontsMissing > 0;
  let fontsRepo: FontRepository | null = null;
  let fontService: FontService | null = null;
  if (fontsOn) {
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    fontsRepo = new FontRepository(db, { clock });
    await seedFonts({
      repo: fontsRepo,
      inboxPath,
      now: nowAt,
      ...(options.fontsEmpty ? { specs: [] } : {}),
    });
    // --fonts-missing: notes of the first jobs that asked for fonts the library does not have.
    if (fontsMissing > 0) {
      seedFontRequests({
        repo: fontsRepo,
        jobIds: repository.getAll().map((job) => job.id),
        count: fontsMissing,
        now: nowAt,
      });
    }
    fontService = createFontService({
      repo: fontsRepo,
      inboxPath,
      dataDir: dir,
      publish: (event) => bus.publish(event),
      usedIn: fontsInNotes,
      jobName: (jobId) => {
        const job = repository.get(jobId);
        return job === null ? null : `${job.client} · ${job.name}`;
      },
      openFolder: async (path) => {
        finder.files.push(path);
      },
      home: join(dir, 'home'),
      logger,
      clock,
    });
    await fontService.start();
  }
  // --analytics: the Analytics route as the engine builds it (engine.ts), over this database and
  // this data folder, with the seed's clock.
  const analyticsRoutes = options.analytics
    ? {
        jobs: repository,
        stepRuns: new StepRunRepository(db, { clock }),
        notes,
        deliveries: new DeliveryRepository(db),
        usage: () => readUsageLog(dir),
        limits: () => readLimits(dir),
        noteTopics: () => new NoteTopicStore(dir).get(),
        clock,
      }
    : undefined;
  // --chat: the job chat, read by the real feed service from the seed's logs.
  const feed = options.chat
    ? new FeedService({
        logsDir: join(dir, 'logs'),
        feedsDir: join(dir, 'feeds'),
        notes,
        pendingBriefSummary: DRAFT_PENDING_BRIEF_SUMMARY,
      })
    : null;
  const app = createApp({
    webDist: options.webDist ?? DEFAULT_WEB_DIST,
    ...(feed === null ? {} : { draftChat: true, feedRoutes: { jobs: repository, feed } }),
    jobSheet: options.jobSheet ?? true,
    ...(instagramSeed === null
      ? {}
      : {
          instagram: true,
          clients: instagramSeed.clients,
          instagramRoutes: instagramSeed.instagramRoutes,
          delivery: instagramSeed.delivery,
        }),
    jobSheetRoutes: {
      jobs: repository,
      steps: new StepRunRepository(db, { clock }),
      notes,
      inboxPath,
      exportsDir,
      ...(instagramSeed === null ? {} : { instagram: instagramSeed.repo }),
      openFolder: async (path) => {
        finder.folders.push(path);
      },
      revealFile: async (path) => {
        finder.files.push(path);
      },
    },
    jobs: {
      jobs: repository,
      worker,
      exportsDir,
      onJobChanged: (job) => bus.publish({ type: 'job.upsert', job }),
      review,
      ...(noSong === null ? {} : { noSong }),
    },
    preview: {
      jobs: repository,
      inboxPath,
      // --generate (C65): Export MP4 works in Review, per format, with the fake runner's stand-in
      // clip instead of a real delivery render.
      ...(options.generate
        ? { exports: new ReviewExports({ inboxPath, render: renderFakePreviewVideo }) }
        : {}),
    },
    notes: { review },
    events: { bus, signal: streams.signal },
    ...(series === undefined ? {} : { series: { series } }),
    phone: options.phone ?? false,
    ...(music === null ? {} : { music: true, musicRoutes: { jobs: repository, music } }),
    ...(noSong === null
      ? {}
      : {
          songs: true,
          noteAttachments: { jobs: repository, inboxPath },
          noSongRoutes: { jobs: repository, noSong },
        }),
    ...(fixes === null ? {} : { quickFixes: true, fixRoutes: { jobs: repository, fixes } }),
    ...(options.generate
      ? {
          generate: true,
          generateRoutes: {
            jobs: repository,
            generate: createGenerateService(generateRepo, {
              // The stage's History is a file of the job's edit/ folder, as in the engine.
              history: async (jobId) => {
                const job = repository.get(jobId);
                return job === null
                  ? []
                  : readGenerateHistory(join(inboxPath, job.relPath, 'edit'));
              },
            }),
          },
          generateReviewRoutes: { jobs: repository, inboxPath },
        }
      : {}),
    ...(analyticsRoutes === undefined ? {} : { analytics: true, analyticsRoutes }),
    ...(demoMoney === null
      ? {}
      : {
          currencySymbol: '$',
          settingsRoutes: { settings: createDemoSettings(dir), restart: null },
          ...(instagramSeed === null
            ? {}
            : {
                teamRoutes: {
                  team: createDemoTeam(dir),
                  clients: instagramSeed.instagramRoutes.clients,
                  onChanged: () => bus.publish({ type: 'access.changed' }),
                },
              }),
          money: {
            deliveries: new DeliveryRepository(db),
            jobs: repository,
            money: demoMoney.loader,
            clock,
            archivedJobIds: () => repository.archivedIds(),
            priceFor: demoMoney.priceFor,
          },
        }),
    ...(graphicsApi === undefined
      ? {}
      : { graphics: true, graphicsInEdits: true, graphicsRoutes: graphicsApi }),
    ...(lutsApi === undefined ? {} : { luts: true, lutsRoutes: lutsApi }),
    ...(fontService === null
      ? {}
      : {
          fonts: true,
          fontsInNotes,
          fontsRoutes: { service: fontService },
        }),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: options.port ?? 0 },
      () => resolve(listening as Server),
    ) as Server;
    listening.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // "Demo 3" is being made: v2, with words, in the background (its `make` is the one that never ends).
  const making = music === null ? null : repository.get(MUSIC_IDS.making);
  if (options.music && music !== null && making !== null) {
    await music.makeAnother(making, MUSIC_MAKING_ASK);
  }
  // "Demo 12" is making its second file (the stand-in render never ends); "Demo 13" tried and failed.
  if (noSong !== null && !options.empty) {
    const holding = repository.get(SONGS_IDS.making);
    if (holding !== null) await noSong.start(holding);
    const failing = repository.get(SONGS_IDS.failed);
    if (failing !== null) {
      await noSong.start(failing);
      await noSong.idle(failing.id);
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    dir,
    inboxPath,
    jobs: repository,
    graphicsRepo,
    lutsRepo,
    fontsRepo,
    music,
    noSong,
    fixes,
    bus,
    finder,
    stop: async () => {
      demoMoney?.loader.close();
      await instagramSeed?.queue.stop();
      stopNoSongListening?.();
      await noSong?.stop();
      stopFixListening?.();
      await noteRouting.stop();
      await fixes?.stop();
      stopMusicListening?.();
      await music?.stop();
      streams.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await graphicWorker?.stop();
      await fontService?.stop();
      review.stop();
      await styleWorker?.stop();
      await transcriber.stop();
      db.close();
      if (ownsDir) await rm(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  // `pnpm seed:canvas --now canvas` reaches here as `-- --now canvas`: drop the separator.
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      port: { type: 'string' },
      now: { type: 'string' },
      dir: { type: 'string' },
      'web-dist': { type: 'string' },
      empty: { type: 'boolean' },
      demo: { type: 'boolean' },
      review: { type: 'boolean' },
      series: { type: 'boolean' },
      sheet: { type: 'boolean' },
      'no-job-sheet': { type: 'boolean' },
      phone: { type: 'boolean' },
      analytics: { type: 'boolean' },
      graphics: { type: 'boolean' },
      'graphics-empty': { type: 'boolean' },
      luts: { type: 'boolean' },
      'luts-empty': { type: 'boolean' },
      'lut-previews': { type: 'string' },
      fonts: { type: 'boolean' },
      'fonts-empty': { type: 'boolean' },
      'fonts-in-notes': { type: 'boolean' },
      'no-fonts-in-notes': { type: 'boolean' },
      'fonts-missing': { type: 'string' },
      music: { type: 'boolean' },
      songs: { type: 'boolean' },
      'quick-fixes': { type: 'boolean' },
      'fix-speed': { type: 'string' },
      generate: { type: 'boolean' },
      chat: { type: 'boolean' },
      'chat-log': { type: 'string' },
      instagram: { type: 'boolean' },
      'scan-seconds': { type: 'string' },
    },
  });
  const server = await startCanvasServer({
    port: values.port === undefined ? undefined : Number(values.port),
    now: values.now,
    dir: values.dir,
    webDist: values['web-dist'],
    empty: values.empty,
    demo: values.demo,
    review: values.review,
    series: values.series,
    sheet: values.sheet,
    jobSheet: values['no-job-sheet'] ? false : undefined,
    phone: values.phone,
    analytics: values.analytics,
    graphics: values.graphics,
    graphicsEmpty: values['graphics-empty'],
    luts: values.luts,
    lutsEmpty: values['luts-empty'],
    lutPreviews:
      values['lut-previews'] === 'real' || values['lut-previews'] === 'fake'
        ? values['lut-previews']
        : undefined,
    fonts: values.fonts,
    fontsEmpty: values['fonts-empty'],
    fontsInNotes: values['no-fonts-in-notes'] ? false : values['fonts-in-notes'],
    fontsMissing:
      values['fonts-missing'] === undefined ? undefined : Number(values['fonts-missing']),
    music: values.music,
    songs: values.songs,
    quickFixes: values['quick-fixes'],
    fixSpeed: values['fix-speed'] === undefined ? undefined : Number(values['fix-speed']),
    generate: values.generate,
    chat: values.chat,
    chatLog: values['chat-log'],
    instagram: values.instagram,
    scanSeconds: values['scan-seconds'] === undefined ? undefined : Number(values['scan-seconds']),
  });
  console.log(
    values.demo
      ? `Studio Engine demo: ${server.url}  (made-up data, no keys needed; Ctrl+C to stop and clean up)`
      : `Canvas seed: ${server.url}  (data in ${server.dir}; Ctrl+C to stop and clean up)`,
  );

  const stop = (): void => {
    server
      .stop()
      .catch((err: unknown) => console.error(err))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
