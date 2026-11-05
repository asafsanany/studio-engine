// Boot composition: builds everything that runs the engine from the config and an open database,
// so index.ts only has to listen, start and stop it.
//
//   repositories -> runner + Brief step -> queue worker -> HTTP app
//   (on start: the inbox first -- reconcile the disk with the database, then watch it -- and only
//   then the worker, so it never picks up a job whose folder vanished while the engine was down)
//
// Beside the edit worker runs the style worker (Phase 2): one style run at a time, fed by uploads,
// Retry and files dropped into a client's `_Style` folder (the inbox watcher's style events, which
// `StyleDrops` turns into Read passes), and by Learn passes: every job that reaches ready adds its
// look to its client's style (the edit worker waits for it only before an edit of the same
// client), Use this look, and on the first start with client styles, the newest finished job of
// every client without a style. It starts after the inbox, once the client styles are reconciled,
// and just before the edit worker, and runs again what a crash or a shutdown left analysing.
//
// A job that reaches Ready is only Approved (Phase 4): no delivery is written then, and none is
// backfilled on start. A delivery is recorded when the owner marks the job delivered, with
// `recordDelivery` (the deliver route writes the same record and sends the events itself); a job's
// `delivery` is read from the deliveries.
//
// The Money page's numbers (Phase 4): money.json is read by the money file loader, which the engine
// starts and closes with itself. It decides the price of a delivery (`priceForClient`) and, with
// the deliveries, answers `GET /api/money`. `money.changed` goes out on the bus when a delivery is
// recorded, when money.json changes (or gets a mistake, or is fixed: the page's warning line) and
// when review time is added. The last valid money.json is saved as money.last-good.json and used
// when a restart finds the file invalid; with no good version at all, Mark delivered is refused (a
// default price is never frozen into a delivery).
//
// Series (Series plan): the series service answers the series routes and Send's Add to series, and
// its changes go out on the bus as `series.changed` / `series.removed`. The name rule
// (`assignSeries`) runs when the inbox finds or settles a job and, for the client's waiting jobs,
// when one of its series is installed. While the Series switch is off the service is the disabled
// one: nothing joins, nothing changes, and the series routes answer 404 "Series are off.".
//
// Graphics (Graphics plan): while the Graphics switch is on, the library's repository, its
// folders, the worker that runs its runs (a runner from `createGraphicRunner`) and the service the
// routes ask; every change goes out on the bus as `graphic.changed` / `graphic.removed`. The worker
// starts with the other workers and stops with them. Off: the disabled service, no worker, no
// graphics route (every /api/graphics path answers 404 "Graphics are off.") and no `_Graphics`.
// With the graphicsInEdits switch on too, the edit runner is wrapped so that a successful edit or
// revise run records the library graphics its edit mounted (`withGraphicUses`, "Used in").
//
// LUTs (LUTs plan): the library's repository exists whatever the switch says (the tables are empty
// while it is off); while the LUTs switch is on, the LUTs service answers the LUTs routes (the
// list, a LUT's pane, rename, import …) with the built-in catalog and a preview maker, and every
// change goes out on the bus as `lut.changed` / `lut.removed`. Off: the disabled service, no LUTs
// route (every /api/luts path answers 404 "LUTs are off.") and no `_LUTs` folder.
//
// With the lutsInEdits switch on too, the edit runner is wrapped so that a run whose notes name a LUT
// (`@luts/name`) or a library graphic copies the LUT files into edit/luts/, counts the use and is
// told about them (`withLutRefs`, LU9); off, notes are plain text as before.
//
// Fonts (Fonts plan): the library's repository (`font_uses`, `font_requests`) exists whatever the
// switch says (the tables are empty while it is off); while the Fonts switch is on, the Fonts
// service answers the Fonts routes (the list, a family's pane, import, delete …), builds its font
// index at boot, watches `_Fonts` for fonts dropped in Finder, and every change goes out on the bus
// as `font.changed` / `font.removed`. Off: the disabled service and no Fonts
// route (every /api/fonts path answers 404 "Fonts are off."). The `_Fonts` folder is made at every
// boot whatever the switch says (CVP-201, inbox/boot.ts): the jobs' fonts copy depends on it.
// While Fonts is on, a successful edit or revise run records the library fonts its compositions
// use (`withFontUses`, "Used in"), and the first boot reads the jobs that finished before that
// existed, once (`backfillFontUses`, a marker file in the data dir).
//
// With the fontsInNotes switch on too, the edit runner is wrapped so that a run whose notes name a
// font (`@Heebo Bold`) has its file made sure of in the job's edit/fonts/, the use counted in
// `font_uses` and is told about it, in the same "Library references" block as the LUTs
// (`withFontRefs`, FN15); off, notes are plain text as before. A font a note names that the library
// does not have is told too (use the closest) and written to `font_requests` (FN16).
//
// Soundtrack (Soundtrack plan): while the music switch is on, the music service answers the music
// routes (read, Make another, Pick), the runners and prompts read `config.music`, and the edit
// runner is wrapped so that every edit or revise run, when it ends, logs the versions of music it
// made in the usage log and tells the page the job's music (`withMusicRuns`). The service stops
// what it runs for a job that is cancelled or deleted and when the engine stops, and Approve and
// Send notes wait while a version is being made. Off: no service and no music route (every /api/jobs/:id/music path
// answers 404 "Music is off."), and every prompt is what it was before Soundtrack.
//
// Quick fixes (Quick fixes plan): while the quickFixes switch is on, every new note of a job in Review
// on Auto is sorted by the router (QF1) and a note it calls quick is fixed by itself by the fix
// service (QF3, review/fix-service.ts), one at a time per job and at most two jobs at once, beside the
// edit queue; the job stays in Review. Its runner is the headless Sonnet run (QF2), or the fake one
// with the fake runner. While a fix is queued or running, Approve, Send notes, Export MP4, going back
// to an earlier cut and the music's Make another and Pick wait (`reviewBlock`, combined with the
// music's: the first that answers wins), and the fix itself waits while the music is being made.
// The service stops with the engine (its running fix is put back), when a job is deleted (before
// its folder goes) and, following the bus, when a job leaves Review, is archived or leaves Auto. Off:
// no service, no fix route (every /api/jobs/:id/fixes path answers 404 "Quick fixes are off.") and
// nothing of Review changes. A fixed note ends the round with the others (QF4): Send lists it in the
// round file as already changed, Approve works when every unsent note is fixed, both clear the round's
// fix files, and `PUT /api/jobs/:id/review-effort` sets Review's own effort (the review service and
// the jobs routes; the revise run's model and effort follow it, in the Claude runner).
//
// Generated videos (GN0, GN5): while the generate switch is on, the Generate step runs between the
// Brief step and the edit for a job whose brief says `production: generate` (the worker calls it),
// the Jobs and sheet read the job's Generate state (`Job.generate`, `GET /api/jobs/:id/generate`)
// and its History (`GET /api/jobs/:id/generate/history`), and every change of that state goes out on
// the bus as `job.generate`. The step is the Claude Generate run, or the fake one with the fake
// runner (it calls the two scripts' fake path). Off: no step, no route, nothing of it exists.
//
// Web push (Mobile plan §6): the push service listens on the bus and sends a push to each phone
// that turned notifications on when a job enters Review, fails or is approved and rendered, and
// when the queue goes empty. The phones register through the /api/push routes; the VAPID keys are
// made on first use into <dataDir>/push.json.
//
// The engine never refuses to boot because edits cannot run. When no runner is available (its
// work item is not merged yet, or `runner` names one that is not installed) the API still works
// and jobs still move through arriving, queued, held and cancelled; only the editing is paused.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DRAFT_PENDING_BRIEF_SUMMARY,
  type GenerateState,
  isFixedNote,
  type Job,
  priceForClient,
  type ReviewNote,
  type ServerEvent,
  setClaudeBudgets,
  setHomeCurrencySymbol,
  TEAM_FILE_NAME,
} from '@studio/shared';
import type { Hono } from 'hono';
import { backfillLimits, readLimits } from './analytics/limits-log.js';
import { NoteTopicStore } from './analytics/note-topics.js';
import { ClaudeNoteTopicRunner } from './analytics/note-topics-claude.js';
import { NoteTopicPass } from './analytics/note-topics-pass.js';
import type { NoteTopicRunner } from './analytics/note-topics-run.js';
import { claudePlanProbeRun, PlanProbe } from './analytics/plan-probe.js';
import { createApp } from './app.js';
import { ClientFolders } from './clients/client-folders.js';
import { createStyleRunner } from './clients/create-style-runner.js';
import { FakeStyleRunner } from './clients/fake-style.js';
import { JobStills } from './clients/job-still.js';
import { findClient } from './clients/lookup.js';
import { NoSongExports, withNoSongOnReady } from './clients/no-song-export.js';
import { PreviewVideos } from './clients/preview-video.js';
import { ReviewExports } from './clients/review-export.js';
import { ReviewWarmup } from './clients/review-warmup.js';
import { assignSeries, assignWaitingJobs, type SeriesAssignDeps } from './clients/series-assign.js';
import { createSeriesNotes } from './clients/series-notes.js';
import {
  createSeriesService,
  disabledSeriesService,
  type SeriesService,
} from './clients/series-service.js';
import { StyleDrops } from './clients/style-drops.js';
import { backfillStyles, createLearnOnReady, createLearnWait } from './clients/style-learn.js';
import { createStyleNotes } from './clients/style-notes.js';
import type { StyleRunner } from './clients/style-run.js';
import { StyleWorker } from './clients/style-worker.js';
import type { Config } from './config.js';
import {
  ClientStyleRepository,
  DeliveryRepository,
  FontRepository,
  GenerateRepository,
  GraphicRepository,
  InstagramRepository,
  JobRepository,
  LutRepository,
  NoteRepository,
  PushDeviceRepository,
  QuickFixRepository,
  SeriesRepository,
  StepRunRepository,
  type StudioDb,
  toClientStyle,
} from './db/index.js';
import { createRecordDelivery, type PriceFor } from './deliveries/deliveries.js';
import { createEventBus, type EventBus } from './events/bus.js';
import { followQueuePlaces } from './events/queue-places.js';
import { FeedService } from './feed/feed-service.js';
import { withFontRefs, withQuickFixFonts } from './fonts/font-run-refs.js';
import {
  createDisabledFontService,
  createFontService,
  type FontService,
} from './fonts/font-service.js';
import { backfillFontUses, recordFontUses, withFontUses } from './fonts/font-uses.js';
import { readGenerateHistory } from './generate/generate-history.js';
import {
  createGenerateService,
  disabledGenerateService,
  type GenerateService,
} from './generate/generate-service.js';
import { syncGeneratedSpend } from './generate/generated-job.js';
import { reapGraphicRuns } from './graphics/claude-graphic.js';
import { createGraphicRunner } from './graphics/create-graphic-runner.js';
import { FakeGraphicRunner } from './graphics/fake-graphic-runner.js';
import { GRAPHICS_ASSETS_DIR } from './graphics/graphic-assets.js';
import { GraphicFolders } from './graphics/graphic-folders.js';
import type { GraphicRunner } from './graphics/graphic-run.js';
import {
  createDisabledGraphicService,
  createGraphicService,
  type GraphicService,
} from './graphics/graphic-service.js';
import { recordGraphicUses, withGraphicUses } from './graphics/graphic-uses.js';
import { GraphicWorker } from './graphics/graphic-worker.js';
import { type RunningInbox, type StartInboxOptions, startInbox } from './inbox/boot.js';
import { ClientRegistry, useClientRegistry } from './inbox/client-registry.js';
import { listClientNames } from './inbox/scan.js';
import type { WatcherLogger } from './inbox/watcher.js';
import { readClientInstagramSummary } from './instagram/client-instagram.js';
import { createScannerFor } from './instagram/create-scanner.js';
import {
  createInstagramScanQueue,
  type InstagramScanQueue,
  type ScanTimers,
} from './instagram/scan-queue.js';
import { activeClientIds } from './instagram/scan-schedule.js';
import type { InstagramScanner } from './instagram/scanner.js';
import { DmInbox } from './instagram-dms/dm-inbox.js';
import { type CameraTagProbe, createCameraPreparer } from './luts/camera-luts.js';
import { createBuiltInLuts, warmBuiltInLuts } from './luts/lut-builtin.js';
import { createFfmpegLutProver, type LutProver } from './luts/lut-check.js';
import { type LutJobFilesOptions, withLutRefs } from './luts/lut-job-files.js';
import { createLutPreviews, type LutPreviews } from './luts/lut-previews.js';
import {
  type BuiltInLuts,
  createDisabledLutService,
  createLutService,
  type LutService,
} from './luts/lut-service.js';
import { createLutStaging, startLutStagingReaper } from './luts/lut-staging.js';
import { createReviewFrames, type ReviewFrames } from './luts/review-frames.js';
import { MoneyFileLoader, type MoneyFileLoaderOptions, moneyFilePath } from './money/money-file.js';
import { createServiceChargeReader } from './money/service-charges.js';
import { withMusicRuns } from './music/music-runs.js';
import { createMusicScriptRunner, type MusicScriptRunner } from './music/music-script.js';
import { createMusicService, type MusicService } from './music/music-service.js';
import { createMusicUsageLogger } from './music/music-usage.js';
import type { BriefRun } from './pipeline/brief-step.js';
import type { ClaudeRunnerOptions } from './pipeline/claude-runner.js';
import {
  createBriefStep,
  createGenerateStep,
  createRunner,
  createTranscriber,
  RunnerUnavailableError,
} from './pipeline/create-runner.js';
import { createEtaEstimator, createEtaTicker, type EtaTimers } from './pipeline/eta.js';
import { renderFakePreviewVideo } from './pipeline/fake-preview.js';
import { createFinalize } from './pipeline/finalize.js';
import type { GenerateRun } from './pipeline/generate-step.js';
import { sipsHeicToJpeg } from './pipeline/heic-to-jpeg.js';
import { createProgressTracker } from './pipeline/progress.js';
import type { Runner } from './pipeline/runner.js';
import { TranscriptionError, type VoiceTranscriber } from './pipeline/voice-transcriber.js';
import { QueueWorker, type WorkerLogger } from './pipeline/worker.js';
import { createWebPushSender, generateVapidKeys, type PushSender } from './push/push-sender.js';
import { createPushService, type PushService } from './push/push-service.js';
import { createVapidKeyStore } from './push/vapid-keys.js';
import { resolveVapidSubject } from './push/vapid-subject.js';
import type { RemoteAccess } from './remote/access.js';
import { configuredAccess } from './remote/tailnet.js';
import { reapQuickFixRuns } from './review/claude-quick-fix.js';
import { createQuickFixRunner } from './review/create-quick-fix-runner.js';
import { FakeNoteRouter } from './review/fake-fix-router.js';
import { FakeQuickFixRunner } from './review/fake-quick-fix.js';
import { ClaudeNoteRouter, type NoteRouter } from './review/fix-router.js';
import { createFixService, type FixService } from './review/fix-service.js';
import { GuardedNoteRouter } from './review/generated-route.js';
import { createNoteRouting, NO_NOTE_ROUTING } from './review/note-routing.js';
import type { QuickFixRunner } from './review/quick-fix-run.js';
import {
  createReviewService,
  type ReviewService,
  type SeriesNotesHook,
  type StyleNotesHook,
} from './review/review-service.js';
import { type FolderOpener, openInFinder } from './routes/clients.js';
import { type FileRevealer, revealInFinder } from './routes/job-sheet.js';
import { machineTimeZone } from './routes/money.js';
import { FeatureSettings } from './settings/feature-settings.js';
import { dropAssignmentOfGoneClient, pruneGoneAssignments } from './team/client-gone.js';
import { TeamService } from './team/team-service.js';
import { graphicVoiceUsage, transcribeUsage } from './usage/app-usage.js';
import { logAppUsage, readUsageLog } from './usage/usage-log.js';
import { createVersionService } from './versions/version-service.js';

export interface EngineOptions {
  config: Config;
  /** Already opened and migrated. The caller closes it, after `stop()`. */
  db: StudioDb;
  logger: WorkerLogger;
  /** Built web app folder to serve next to the API (production). */
  webDist?: string;
  /**
   * Builds the runner the config names, with the logger and the progress tracker hook (E4) for
   * the Claude runner. Replaced in tests.
   */
  createRunner?: (
    config: Config,
    options?: Pick<ClaudeRunnerOptions, 'logger' | 'track'>,
  ) => Runner;
  /**
   * Builds the Brief step (B4) that runs before every edit: by default the one that goes with
   * `config.runner` (`createBriefStep`). Tests that replace `createRunner` and not this get no
   * Brief step, so a stand-in runner never sits behind a real Claude Brief run.
   */
  createBriefStep?: (
    config: Config,
    options: {
      logger: WorkerLogger;
      series: SeriesRepository;
      /** The Graphics library, given only while `config.graphicsInEdits` is on (GR8). */
      graphics?: GraphicRepository;
    },
  ) => BriefRun;
  /**
   * Builds the Generate step (Generated videos, GN5) that runs after the Brief step for a job whose
   * brief says `production: generate`, only while `config.generate` is on: by default the one that
   * goes with `config.runner` (`createGenerateStep`). Tests that replace `createRunner` and not this
   * get no Generate step, so a stand-in runner never sits behind a Generate run.
   */
  createGenerateStep?: (
    config: Config,
    options: {
      logger: WorkerLogger;
      repo: GenerateRepository;
      /** Told whenever a job's Generate row changes; the engine publishes `job.generate` here. */
      onChanged: (jobId: string, state: GenerateState) => void;
    },
  ) => GenerateRun;
  /**
   * Builds the voice-note transcriber (W6). Default: createTranscriber, fake or real by
   * config.runner. Replaced in tests.
   */
  createTranscriber?: (config: Config, options: { logger: WorkerLogger }) => VoiceTranscriber;
  /**
   * What Send does with the notes marked Add to style. Default: the client's style (W7). Replaced in tests.
   */
  styleNotes?: StyleNotesHook;
  /** What Send does with the notes marked Series. Default: the job's series (K5). Replaced in tests. */
  seriesNotes?: SeriesNotesHook;
  /**
   * The series service. Default: the disabled one, while the Series switch is off (K2 builds the
   * real one when `config.series` is on). Replaced in tests.
   */
  series?: SeriesService;
  /**
   * Builds what writes a client's style.md.new: by default the one that goes with
   * `config.runner` (`createStyleRunner`). Replaced in tests; tests that replace `createRunner`
   * and not this get the fake one.
   */
  createStyleRunner?: (config: Config, options: { logger: WorkerLogger }) => StyleRunner;
  /**
   * What gives the sent review notes their topics for Analytics (AN4). Default: the headless
   * Claude run while the Analytics switch is on and the runner is the real one; otherwise none,
   * so the notes stay "not grouped yet". `null` means none. Replaced in tests.
   */
  noteTopicRunner?: NoteTopicRunner | null;
  /**
   * What reads the Max plan's limits for Analytics when the newest reading is stale: a tiny
   * headless run on the plan login. Default: the real one while the Analytics switch is on and the
   * runner is the real one; otherwise none, so tests and the fake runner never start Claude.
   * `null` means none. Replaced in tests.
   */
  planProbe?: PlanProbe | null;
  /**
   * Builds what makes a graphic's versions (Graphics plan): by default the one that goes with
   * `config.runner` (`createGraphicRunner`). Replaced in tests; tests that replace `createRunner`
   * and not this get the fake one, so a stand-in engine never starts a real Claude run.
   */
  createGraphicRunner?: (config: Config, options: { logger: WorkerLogger }) => GraphicRunner;
  /**
   * Runs the music script for Make another and Pick (Soundtrack): by default the real script,
   * started with the server's node outside the job folder (`createMusicScriptRunner`). Replaced in
   * tests, which must not wait for ffmpeg or reach ElevenLabs.
   */
  musicRunner?: MusicScriptRunner;
  /**
   * The built-in LUT catalog (LUTs plan): by default the one read from the installed colour-grade
   * skill (`createBuiltInLuts`). Replaced in tests, which must not depend on what is installed.
   */
  builtInLuts?: BuiltInLuts;
  /**
   * What makes the LUT preview stills (LUTs plan): by default the one that goes with
   * `config.runner` (`createLutPreviews`). Replaced in tests, which must not wait for ffmpeg.
   */
  lutPreviews?: LutPreviews;
  /**
   * What takes the frames of the paused-frame look in Review (LU11): by default the one that goes
   * with `config.runner` (`createReviewFrames`, from the round's small preview video). Replaced in tests.
   */
  reviewFrames?: ReviewFrames;
  /** The final proof of a LUT file at import (LUTs plan). Replaced in tests, which must not need ffmpeg. */
  lutProver?: LutProver;
  /** Reads a footage file's tags for the camera log it names (LU10). Replaced in tests, which must not need ffprobe. */
  cameraTagProbe?: CameraTagProbe;
  /** How long the topic pass waits after the last Send. Default 30 s. Shortened in tests. */
  noteTopicDebounceMs?: number;
  /**
   * What sorts each review note with the difficulty index while quick fixes are on (QF1). Default:
   * the headless Haiku run when the runner is the real one; otherwise the fake keyword router, so
   * a stand-in engine never starts a real Claude run. Replaced in tests.
   */
  noteRouter?: NoteRouter;
  /**
   * What fixes a quick note while quick fixes are on (QF3). Default: the headless Sonnet run when
   * the runner is the real one; otherwise the fake one, so a stand-in engine never starts a real
   * Claude run. Replaced in tests.
   */
  quickFixRunner?: QuickFixRunner;
  /** Starts the inbox side (W3). Replaced in tests, which must not start a real file watcher. */
  startInbox?: (options: StartInboxOptions) => Promise<RunningInbox>;
  /**
   * What a client's job costs, asked when a job is marked delivered.
   * Default: the price money.json gives the client (`priceForClient`: its entry in `clientPrices`,
   * else `pricePerJob`, 200 shekels until the file says otherwise). Replaced in tests.
   */
  priceFor?: PriceFor;
  /**
   * How the money.json loader watches the data folder: the debounce and the folder watcher.
   * Replaced in tests, which must not wait 300 ms or depend on the platform's file events.
   */
  moneyFile?: Pick<MoneyFileLoaderOptions, 'debounceMs' | 'watchDir'>;
  /** The clock for step timings and the ETA estimator. Replaced in tests. */
  clock?: () => Date;
  /** The interval timers of the 15 s ETA ticker (E5). Replaced in tests. */
  etaTimers?: EtaTimers;
  /** Opens a client's folder for `POST /api/clients/:clientId/reveal`. Default: macOS `open`. */
  openFolder?: FolderOpener;
  /** Shows a job's export selected for `POST /api/jobs/:id/reveal`. Default: macOS `open -R`. */
  revealFile?: FileRevealer;
  /**
   * Who may come in through Tailscale Serve, as known right now: the boot passes the tailnet's
   * (index.ts, remote/tailnet.ts). Default: what config.json's `remoteHosts` and `remoteLogins`
   * say, without asking Tailscale.
   */
  remoteAccess?: () => RemoteAccess;
  /**
   * The Settings page's feature switches (Graphics, Fonts, LUTs): where they are kept, and how the
   * engine restarts itself. The boot passes both (index.ts); left out (tests), `/api/settings` does
   * not exist.
   */
  settings?: {
    /** `<home>/.studio-engine/config.json`. */
    configPath: string;
    /** Restarts the engine, or `null` when nothing would start it again (not the launchd agent). */
    restart: (() => void) | null;
  };
  /**
   * The team (editors and which clients they see). Default: <dataDir>/team.json, read live.
   * Replaced in tests.
   */
  team?: TeamService;
  /**
   * What delivers a web push to a phone. Default: `web-push`, signed with the keys in
   * <dataDir>/push.json. Replaced in tests, which must never send a real push.
   */
  pushSender?: PushSender;
  /**
   * Clients × Instagram (IG4), used only while `config.instagram` is on. `scanner`: what reads an
   * account; default the real one (Apify, the key in .env), tests pass the fake one. `timers`: the
   * interval of the weekly check, fired by hand in tests. `timeZone`: the one Monday 06:00 is read
   * in; default the Mac's. The clock is `clock`.
   */
  instagramScan?: { scanner?: InstagramScanner; timers?: ScanTimers; timeZone?: string };
  /**
   * The Instagram DMs inbox (the DMs page). Default: the one in <dataDir>/instagram-dms, with the
   * key in .env. It reads the DMs every minute only with the real runner, so tests and stand-in
   * engines never reach Instagram on their own (Check now still does).
   */
  dmInbox?: DmInbox;
}

export interface Engine {
  readonly app: Hono;
  readonly jobs: JobRepository;
  /** Where each client's style stands (`client_styles`). */
  readonly clientStyles: ClientStyleRepository;
  /** The client folders of the inbox, with jobs or without (`GET /api/clients`). */
  readonly clientFolders: ClientFolders;
  /** The owner's review notes (`review_notes`). */
  readonly notes: NoteRepository;
  /** Every client's series (`series`); which jobs are episodes is on the jobs. */
  readonly seriesRepo: SeriesRepository;
  /** The series routes' and Send's rules; the disabled one while the Series switch is off. */
  readonly series: SeriesService;
  /** The Graphics library (`graphics`, `graphic_messages`, `graphic_uses`). */
  readonly graphicsRepo: GraphicRepository;
  /** The graphics routes' rules; the disabled one while the Graphics switch is off. */
  readonly graphics: GraphicService;
  /** Runs the graphic runs beside the edits, or `null` while the Graphics switch is off. */
  readonly graphicWorker: GraphicWorker | null;
  /** The LUTs library (`luts`, `lut_uses`). */
  readonly lutsRepo: LutRepository;
  /** The LUTs routes' rules; the disabled one while the LUTs switch is off. */
  readonly luts: LutService;
  /** The Fonts library's two small tables (`font_uses`, `font_requests`). */
  readonly fontsRepo: FontRepository;
  /** The Fonts routes' rules; the disabled one while the Fonts switch is off. */
  readonly fonts: FontService;
  /** The Generate stage of generated videos (`job_generate`). */
  readonly generateRepo: GenerateRepository;
  /** The generate route's rules; the disabled one while the Generate switch is off. */
  readonly generate: GenerateService;
  /** The jobs' music (Soundtrack), or `null` while the music switch is off. */
  readonly music: MusicService | null;
  /** The quick fixes of Review (queue, Undo, Compare), or `null` while the Quick fixes switch is off. */
  readonly fixes: FixService | null;
  /** Every client's Instagram account, scans and reels (`instagram_*`). */
  readonly instagramRepo: InstagramRepository;
  /**
   * The queue that runs the Instagram scans (the weekly check, Scan now, a saved account), or
   * `null` while the Clients × Instagram switch is off: then nothing is checked, queued or scanned.
   */
  readonly instagramScans: InstagramScanQueue | null;
  /** Every job the owner marked delivered, with its price and when it was paid (`deliveries`). */
  readonly deliveries: DeliveryRepository;
  /**
   * Stores the delivery of a job with its client's price from now, copies its review time and tells
   * the Money page. True when a row was written, false when the job had one. For the deliver route.
   */
  readonly recordDelivery: (job: Job) => boolean;
  /** money.json: the prices, subscriptions and charges, re-read when the file changes. */
  readonly moneyFile: MoneyFileLoader;
  /** The review notes' rules, their transcription, Send and Approve. */
  readonly review: ReviewService;
  /** Pushes a job's changes to the phones that turned notifications on (Mobile plan §6). */
  readonly push: PushService;
  /** The queue worker, or `null` while edits are paused because no runner is available. */
  readonly worker: QueueWorker | null;
  /** Runs the client styles' Read and Learn passes, one at a time, beside the queue worker. */
  readonly styleWorker: StyleWorker;
  /**
   * Every job change, as `job.upsert` / `job.remove`, and the client folders coming and going,
   * as `client.added` / `client.removed`; `GET /api/events` streams it to the browsers.
   */
  readonly bus: EventBus;
  /**
   * Call once the server is listening. First the inbox is reconciled with the database and
   * watched, then the worker starts editing, resuming what a crash left. Resolves once both are
   * up; never rejects because of the inbox (that is logged, and the worker starts regardless).
   */
  start(): Promise<void>;
  /**
   * Waits for a start that is still under way, then stops watching the inbox and the current edit
   * (the job stays `editing` and resumes at the next boot). A worker that was never started
   * because of this stays stopped.
   */
  stop(): Promise<void>;
}

function buildRunner(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createRunner'>,
): Runner | null {
  const { config, logger, createRunner: make = createRunner } = options;
  try {
    // E4: every run of the Claude runner gets a progress tracker that watches its edit/ folder
    // and its stream and reports the step to the worker.
    return make(config, { logger, track: createProgressTracker({ logger }) });
  } catch (err) {
    if (err instanceof RunnerUnavailableError) {
      logger.warn(
        { runner: err.runner },
        `Edits are paused: ${err.message} The API works and jobs still queue; restart after changing the runner.`,
      );
    } else {
      logger.error({ err, runner: config.runner }, 'Edits are paused: could not create the runner');
    }
    return null;
  }
}

/**
 * The Brief step for the worker: `undefined` for none (a test's stand-in runner), `null` when it
 * could not be built, which pauses edits like a missing runner: no edit may start without it.
 */
function buildBrief(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createRunner' | 'createBriefStep'>,
  series: SeriesRepository,
  /** The Graphics library for edits: given only while `config.graphicsInEdits` is on. */
  graphics: GraphicRepository | undefined,
): BriefRun | null | undefined {
  const { config, logger } = options;
  const make =
    options.createBriefStep ?? (options.createRunner === undefined ? createBriefStep : undefined);
  if (make === undefined) return undefined;
  try {
    return make(config, { logger, series, graphics });
  } catch (err) {
    logger.error(
      { err, runner: config.runner },
      'Edits are paused: could not create the Brief step',
    );
    return null;
  }
}

/**
 * The Generate step for the worker (Generated videos, GN5): `undefined` for none (the Generate
 * switch is off, or a test's stand-in runner), `null` when it could not be built, which pauses edits
 * like a missing runner: a generated job may not be edited without its footage.
 */
function buildGenerate(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createRunner' | 'createGenerateStep'>,
  repo: GenerateRepository,
  onChanged: (jobId: string, state: GenerateState) => void,
): GenerateRun | null | undefined {
  const { config, logger } = options;
  if (!config.generate) return undefined;
  const make =
    options.createGenerateStep ??
    (options.createRunner === undefined ? createGenerateStep : undefined);
  if (make === undefined) return undefined;
  try {
    return make(config, { logger, repo, onChanged });
  } catch (err) {
    logger.error(
      { err, runner: config.runner },
      'Edits are paused: could not create the Generate step',
    );
    return null;
  }
}

/**
 * The style runner. One that cannot be made (a broken `STUDIO_FAKE_SPEED`) becomes the fake one
 * at speed 1, so uploads and Finder drops still work. Tests that replace `createRunner` and not
 * this get the fake one too: a stand-in edit that ends ready sets off a Learn pass, and that must
 * never be a real Claude run.
 */
function buildStyleRunner(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createRunner' | 'createStyleRunner'>,
): StyleRunner {
  const { config, logger } = options;
  const make =
    options.createStyleRunner ??
    (options.createRunner === undefined ? createStyleRunner : undefined);
  if (make === undefined) return new FakeStyleRunner();
  try {
    return make(config, { logger });
  } catch (err) {
    logger.error(
      { err, runner: config.runner },
      'could not create the style runner; using the fake one',
    );
    return new FakeStyleRunner();
  }
}

/**
 * The graphic runner. One that cannot be made (a broken `STUDIO_FAKE_SPEED`) becomes the fake one
 * at speed 1, as for the style runner. Tests that replace `createRunner` and not this get the fake.
 */
function buildGraphicRunner(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createRunner' | 'createGraphicRunner'>,
): GraphicRunner {
  const { config, logger } = options;
  const make =
    options.createGraphicRunner ??
    (options.createRunner === undefined ? createGraphicRunner : undefined);
  if (make === undefined) return new FakeGraphicRunner();
  try {
    return make(config, { logger });
  } catch (err) {
    logger.error(
      { err, runner: config.runner },
      'could not create the graphic runner; using the fake one',
    );
    return new FakeGraphicRunner();
  }
}

/**
 * The quick fix runner (QF3): the real one only when the runner is the real one and no test replaced
 * `createRunner`; otherwise the fake one, so a stand-in engine never starts a real Claude run. One
 * that cannot be made (a broken `STUDIO_FAKE_SPEED`) becomes the fake one at speed 1.
 */
function buildQuickFixRunner(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createRunner' | 'quickFixRunner'>,
): QuickFixRunner {
  const { config, logger } = options;
  if (options.quickFixRunner !== undefined) return options.quickFixRunner;
  try {
    return createQuickFixRunner(
      options.createRunner === undefined ? config : { ...config, runner: 'fake' },
      { logger },
    );
  } catch (err) {
    logger.error(
      { err, runner: config.runner },
      'could not create the quick fix runner; using the fake one',
    );
    return new FakeQuickFixRunner({ config });
  }
}

/**
 * The voice-note transcriber. Like a missing runner, one that cannot be built does not stop the
 * boot: every voice note then fails its transcript ("failed") and the typed notes still work.
 */
function buildTranscriber(
  options: Pick<EngineOptions, 'config' | 'logger' | 'createTranscriber'>,
): VoiceTranscriber {
  const { config, logger, createTranscriber: make = createTranscriber } = options;
  try {
    return make(config, { logger });
  } catch (err) {
    logger.error(
      { err, runner: config.runner },
      'Voice notes will not be transcribed: could not create the transcriber',
    );
    return {
      kind: 'fake',
      enqueue: () =>
        Promise.reject(new TranscriptionError('failed', 'The voice transcriber is not available.')),
      stop: async () => {},
    };
  }
}

export function createEngine(options: EngineOptions): Engine {
  const { config, db, logger, webDist } = options;

  // E5: the repository asks the estimator for `etaSec` whenever it reads a queued or editing job.
  const stepRuns = new StepRunRepository(db, { clock: options.clock });
  // `settlesAt` and Release use the same settle delay as the inbox watcher (`Config.settleMs`).
  // The Review switch (`Config.review`) decides whether an edit run ends in Review: the machine
  // (the repository), the worker, the runner (it gets the whole config) and the prompts all read it
  // from here.
  const jobs = new JobRepository(db, {
    estimateEtaSec: createEtaEstimator({ stepRuns, clock: options.clock, review: config.review }),
    settleMs: config.settleMs,
    review: config.review,
    // Manual start (`Config.manualStart`): a job the inbox finds is held until the owner starts it.
    startHeld: config.manualStart,
    // Quick fixes: a job in Review says whether a note is being fixed and how many were fixed.
    quickFixes: config.quickFixes,
    // Generated videos: a job with a Generate stage says where it stands.
    generate: config.generate,
  });
  // Where each client's style stands (Phase 2); `_Style/style.md` is the document itself.
  const clientStyles = new ClientStyleRepository(db, { clock: options.clock });
  // Every client's series (Series plan §2); `_Series/<name>/series.md` is the document itself.
  const seriesRepo = new SeriesRepository(db, { clock: options.clock });
  // Clients × Instagram (IG1): every client's account, scans and reels. The tables are always
  // there; what reads or fills them (the scan, the routes, the Clients list) only while the
  // `instagram` switch is on.
  const instagramRepo = new InstagramRepository(db, { clock: options.clock });

  // Delivered jobs (Phase 4): a row per job the owner marked delivered. The price is asked from
  // `priceFor` when the job is delivered and frozen in the row.
  const deliveries = new DeliveryRepository(db);
  // money.json (Phase 4): read now, watched from `start()`, closed by `stop()`. Its prices are the
  // default `priceFor`, asked at the moment of each delivery, so an edit to the file counts at once.
  if (config.currencySymbol !== undefined) setHomeCurrencySymbol(config.currencySymbol);
  setClaudeBudgets({
    apiCreditsMonthlyUsd: config.apiCreditsMonthlyUsd,
    planMonthlyUsd: config.planMonthlyUsd,
  });
  const moneyFile = new MoneyFileLoader({
    path: moneyFilePath(config.dataDir),
    logger,
    ...(config.usdToHomeCurrency === undefined ? {} : { defaultUsdRate: config.usdToHomeCurrency }),
    ...options.moneyFile,
  });
  const priceFor: PriceFor =
    options.priceFor ??
    ((client) => {
      const money = moneyFile.get();
      return { price: priceForClient(money, client), currency: money.currency };
    });

  // One in-process bus for every job change: the routes, the queue worker and the inbox watcher
  // publish on it; the inbox watcher and the SSE stream (A2) listen to it.
  const bus = createEventBus();
  // The Money page's numbers moved: a delivery, an edit of money.json, review time.
  const publishMoneyChanged = (): void => bus.publish({ type: 'money.changed' });
  // A job marked delivered is recorded with its client's price (Phase 4 §2).
  const recordDelivery = createRecordDelivery({
    deliveries,
    jobs,
    priceFor,
    clock: options.clock,
    onRecorded: publishMoneyChanged,
  });
  // What the deliver route calls: the same record without telling the Money page, since the route
  // sends `job.upsert` first and `money.changed` after it (Phase 4 §3).
  const writeDelivery = createRecordDelivery({ deliveries, jobs, priceFor, clock: options.clock });
  const inboxLogger: WatcherLogger = {
    debug() {},
    info: (obj, msg = '') => logger.info(obj, msg),
    warn: (obj, msg = '') => logger.warn(obj, msg),
    error: (obj, msg = '') => logger.error(obj, msg),
  };
  // The client folders of the inbox, jobs or none: filled at boot, kept current by the inbox
  // watcher, and announced on the bus as `client.added` / `client.removed`.
  const clientFolders = new ClientFolders(bus);
  // Only these client folders are detected. Made on first use, from the folders in the inbox then.
  let registryReady: Promise<ClientRegistry> | undefined;
  const clientRegistry = (): Promise<ClientRegistry | null> => {
    if (!config.knownClientsOnly) return Promise.resolve(null);
    registryReady ??= ClientRegistry.open(config.dataDir, () =>
      listClientNames(config.inboxPath, { exportsDir: config.exportsDir }),
    ).then((registry) => {
      useClientRegistry(registry);
      return registry;
    });
    return registryReady;
  };

  // Style runs (Phase 2): one at a time, apart from the edits. Every change is a `client.upsert`.
  const styleWorker = new StyleWorker({
    clientStyles,
    inboxPath: config.inboxPath,
    dataDir: config.dataDir,
    runner: buildStyleRunner(options),
    onChanged: (style) => bus.publish({ type: 'client.upsert', style: toClientStyle(style) }),
    logger,
  });
  // Files dropped into a `_Style` folder in Finder: a Read pass once the folder is quiet.
  const styleDrops = new StyleDrops({
    inboxPath: config.inboxPath,
    settleMs: config.settleMs,
    enqueue: (client, pass) => styleWorker.enqueue(client, pass),
    logger: inboxLogger,
  });

  // Series (Series plan): the real service while the Series switch is on. Its passes run on the
  // style worker, and the jobs it changes go out as `job.upsert`.
  const series: SeriesService =
    options.series ??
    (config.series
      ? createSeriesService({
          inboxPath: config.inboxPath,
          jobs,
          seriesRepo,
          clientStyles,
          worker: styleWorker,
          onJobChanged: (job) => bus.publish({ type: 'job.upsert', job }),
          logger,
          clock: options.clock,
        })
      : disabledSeriesService);
  // The name rule: off while series are off, like the rest of them.
  const seriesAssign: SeriesAssignDeps = {
    enabled: series.enabled,
    jobs,
    series: seriesRepo,
    logger,
  };

  // Review notes (Phase 3): the voice notes are transcribed by W6's transcriber, outside the edit queue.
  const notes = new NoteRepository(db, { clock: options.clock });
  // The job chat (Draft & chat, DR3): built from each job's log while the switch is on.
  const feed = config.draftChat
    ? new FeedService({
        logsDir: config.logsDir,
        feedsDir: join(config.dataDir, 'feeds'),
        notes,
        pendingBriefSummary: DRAFT_PENDING_BRIEF_SUMMARY,
      })
    : null;
  // Analytics (AN4): a small background Claude pass gives every sent note a short topic, cached in
  // note-topics.json. It starts after a Send and once at boot, and only exists while the Analytics
  // switch is on; a stand-in runner (tests, the fake runner) gets none unless a test passes one.
  const noteTopicStore = new NoteTopicStore(config.dataDir);
  const noteTopicRunner =
    options.noteTopicRunner !== undefined
      ? options.noteTopicRunner
      : config.analytics && options.createRunner === undefined && config.runner === 'claude'
        ? new ClaudeNoteTopicRunner({ config, logger })
        : null;
  const noteTopicPass =
    noteTopicRunner === null
      ? null
      : new NoteTopicPass({
          notes,
          jobs,
          store: noteTopicStore,
          runner: noteTopicRunner,
          debounceMs: options.noteTopicDebounceMs,
          logger,
        });
  // The plan probe (Analytics budgets): the app's own runs no longer carry the plan's limits, so
  // the Analytics page asks for a fresh reading itself when the newest one is stale.
  const planProbe =
    options.planProbe !== undefined
      ? options.planProbe
      : config.analytics && options.createRunner === undefined && config.runner === 'claude'
        ? new PlanProbe({
            readLimits: () => readLimits(config.dataDir),
            run: claudePlanProbeRun({ config, logger }),
            clock: options.clock,
            logger,
          })
        : null;
  // Quick fixes (QF3): with the switch on, a note the router calls quick is fixed by itself while
  // the job stays in Review, one fix at a time per job, beside the edit queue. A fix waits while
  // the music is being made or picked for its job. Off, there is no service and no fix route.
  let musicOfFixes: MusicService | null = null;
  const fontsRepo = new FontRepository(db, { clock: options.clock });
  const quickFixRunner = buildQuickFixRunner(options);
  const fixes: FixService | null = config.quickFixes
    ? createFixService({
        inboxPath: config.inboxPath,
        jobs,
        notes,
        fixes: new QuickFixRepository(db, { clock: options.clock }),
        bus,
        // A font the note names (Fonts and fontsInNotes both on) is put in the job before the fix
        // starts, as for an edit or a revise run: an older job has no copy of it.
        runner:
          config.fonts && config.fontsInNotes
            ? withQuickFixFonts(
                quickFixRunner,
                {
                  catalog: () => fonts.catalog(),
                  uses: fontsRepo,
                  requests: fontsRepo,
                  publish: (event) => bus.publish(event),
                  inboxPath: config.inboxPath,
                  logger,
                },
                logger,
              )
            : quickFixRunner,
        holdOff: (jobId) => musicOfFixes?.reviewBlock(jobId) != null,
        // At boot, the Claude processes a crashed engine left running are stopped first.
        reap: () => reapQuickFixRuns(config.dataDir),
        logger,
        clock: options.clock,
      })
    : null;
  const stopFixListening = fixes?.listen(bus);
  // Quick fixes (QF1): with the switch on, every new note of a job in Review on Auto is sorted in
  // the background (pending, then routed). Off, there is no router and no note is touched.
  const noteRouting = config.quickFixes
    ? createNoteRouting({
        enabled: true,
        // Whichever router, a clip or voice note on a generated video and any note on a job with two
        // formats are kept out of a quick fix (GN6, GN7).
        router: new GuardedNoteRouter(
          options.noteRouter ??
            (config.runner === 'claude' && options.createRunner === undefined
              ? new ClaudeNoteRouter({ config, logger })
              : new FakeNoteRouter()),
          { inboxPath: config.inboxPath },
        ),
        jobs,
        notes,
        bus,
        // A note routed quick joins its job's queue of fixes (QF3).
        onRouted: (job, note) => {
          fixes?.enqueue(job, note);
        },
        logger,
      })
    : NO_NOTE_ROUTING;
  const transcriber = buildTranscriber(options);
  // Soundtrack: the jobs' music, only while the music switch is on. Make another and Pick run the
  // music script (with its fake path under the fake runner), outside the job folder; every version
  // ElevenLabs made is logged once in the usage log (never a fake one).
  // The small MP4 of the live preview, for the phone's Review: made as soon as a job reaches Review
  // (ReviewWarmup, below).
  // The fake runner's is a test-pattern clip as long as the composition (a real render would take
  // far longer than a spec waits), shrunk by the same ffmpeg step as ever.
  const previewVideos = new PreviewVideos({
    inboxPath: config.inboxPath,
    ...(config.runner === 'fake' ? { render: renderFakePreviewVideo } : {}),
  });
  // The full-quality MP4 of Export MP4 in Review, made as soon as a job reaches Review too. Approve
  // reuses it instead of rendering again.
  const reviewExports = new ReviewExports({
    inboxPath: config.inboxPath,
    ...(config.runner === 'fake' ? { render: renderFakePreviewVideo } : {}),
  });
  const publishJob = (job: Job): void => {
    bus.publish({ type: 'job.upsert', job });
  };
  // Songs: the second export, the file without the song, made by the engine after Approve's export
  // landed (SG8). Each start and end republishes the job so the sheet asks again. Off, there is none.
  const noSong = config.songs
    ? new NoSongExports({
        inboxPath: config.inboxPath,
        exportsDir: config.exportsDir,
        ...(config.runner === 'fake' ? { render: renderFakePreviewVideo } : {}),
        onChanged: (jobId) => {
          const job = jobs.get(jobId);
          if (job !== null) publishJob(job);
        },
        logger,
      })
    : null;
  const stopNoSongListening = noSong?.listen(bus);
  const music = config.music
    ? createMusicService({
        inboxPath: config.inboxPath,
        logger,
        jobs,
        publish: (event) => bus.publish(event),
        run: options.musicRunner ?? createMusicScriptRunner({ cwd: config.dataDir }),
        fake: config.runner === 'fake',
        // Make another and Pick wait while a quick fix is changing the preview (QF3).
        ...(fixes === null ? {} : { fixBlock: (jobId: string) => fixes.reviewBlock(jobId) }),
        usage: createMusicUsageLogger({
          dataDir: config.dataDir,
          home: homedir(),
          env: process.env,
          logger,
        }),
      })
    : null;
  musicOfFixes = music;
  const stopMusicListening = music?.listen(bus);
  // Approve, Send notes, going back to an earlier cut and the music wait while something is
  // changing the preview: a quick fix that is queued or running (QF3) or a version of the music
  // being made or picked (Soundtrack). The first that answers wins.
  const reviewBlock: ((job: Job) => string | null) | undefined =
    fixes === null && music === null
      ? undefined
      : (job) => fixes?.reviewBlock(job.id) ?? music?.reviewBlock(job.id) ?? null;
  // Every job published in Review, by whoever published it, gets its two videos made (the owner, 26 Oct:
  // the preview MP4 is there when they open it on the phone or wants to download it). A quick fix or
  // music still changing the preview holds it back; the job is published again when that ends.
  const reviewWarmup = new ReviewWarmup({
    videos: previewVideos,
    exports: reviewExports,
    getJob: (jobId) => jobs.get(jobId),
    ...(reviewBlock === undefined ? {} : { block: reviewBlock }),
    logger,
  });
  const stopWarmupListening = bus.subscribe((event) => {
    if (event.type === 'job.upsert') reviewWarmup.warm(event.job);
    // A removed job gets no video: one being made stops before Delete starts emptying the folder (it
    // is published before the rm), or it would make `<job>/edit` again in a folder that is going (C89).
    else if (event.type === 'job.remove') {
      previewVideos.forget(event.id);
      reviewExports.forget(event.id);
    }
  });
  const review = createReviewService({
    db,
    jobs,
    notes,
    bus,
    inboxPath: config.inboxPath,
    transcriber,
    // Notes marked Add to style become a file in the client's _Style and a Read pass (W7).
    styleNotes:
      options.styleNotes ??
      createStyleNotes({
        styleFiles: {
          inboxPath: config.inboxPath,
          clientStyles,
          worker: styleWorker,
          uploads: styleDrops,
        },
        logger,
      }),
    // Notes marked Series become a file in the series folder that waits for the episode's approval
    // (K5, C26).
    seriesNotes:
      options.seriesNotes ??
      createSeriesNotes({ inboxPath: config.inboxPath, seriesRepo, series, logger }),
    logger,
    // Approve and Send notes wait while a version of the music is being made or picked (Soundtrack)
    // or a quick fix is queued or running (QF3).
    ...(reviewBlock === undefined ? {} : { reviewBlock }),
    onSent: () => noteTopicPass?.trigger(),
    routing: noteRouting,
    // The note rules of a note with a fix: its text, its deletion (QF3).
    ...(fixes === null
      ? {}
      : {
          fixes: {
            beforeEdit: (note: ReviewNote) => fixes.beforeNoteEdit(note),
            beforeDelete: (note: ReviewNote) => fixes.beforeNoteDelete(note),
            // Send lists a fixed note with what its fix said; Send and Approve clear the round's files (QF4).
            said: (note: ReviewNote) =>
              note.fixId === null ? null : (fixes.find(note.jobId, note.fixId)?.said ?? null),
            clearRound: (jobId: string) => fixes.clearRound(jobId),
          },
        }),
    // Real transcriptions go in the usage log; the fake transcriber's don't.
    ...(transcriber.kind === 'real'
      ? {
          onTranscribed: (_note: unknown, job: Job) =>
            void logAppUsage(
              { dataDir: config.dataDir, home: homedir(), env: process.env, logger },
              transcribeUsage(job),
              null,
            ),
        }
      : {}),
    clock: options.clock,
  });
  // Graphics (Graphics plan): the library is stored whatever the switch says (the table is empty
  // while it is off); its worker and the real service exist only while it is on.
  const graphicsRepo = new GraphicRepository(db, { clock: options.clock });
  const graphicFolders = new GraphicFolders({
    inboxPath: config.inboxPath,
    dataDir: config.dataDir,
  });
  const graphicWorker = config.graphics
    ? new GraphicWorker({
        repo: graphicsRepo,
        folders: graphicFolders,
        runner: buildGraphicRunner(options),
        publish: (event) => bus.publish(event),
        // At boot, the Claude processes a crashed engine left running are stopped first.
        reapRuns: () => reapGraphicRuns(config.dataDir),
        logger,
        clock: options.clock,
      })
    : null;
  const graphics: GraphicService =
    graphicWorker === null
      ? createDisabledGraphicService()
      : createGraphicService({
          repo: graphicsRepo,
          folders: graphicFolders,
          worker: graphicWorker,
          publish: (event) => bus.publish(event),
          usedIn: config.graphicsInEdits,
          openFolder: options.openFolder ?? openInFinder,
          logger,
          clock: options.clock,
        });
  // LUTs (LUTs plan): the repository is there whatever the switch says; the real service only
  // while it is on.
  const lutsRepo = new LutRepository(db, { clock: options.clock });
  const builtInLuts = options.builtInLuts ?? createBuiltInLuts({ dataDir: config.dataDir, logger });
  const lutPreviews = options.lutPreviews ?? createLutPreviews(config, { logger });
  const reviewFrames =
    options.reviewFrames ?? createReviewFrames(config, { videos: previewVideos, logger });
  const lutStaging = createLutStaging({ dataDir: config.dataDir, clock: options.clock });
  const luts: LutService = config.luts
    ? createLutService({
        repo: lutsRepo,
        builtIn: builtInLuts,
        staging: lutStaging,
        previews: lutPreviews,
        inboxPath: config.inboxPath,
        publish: (event) => bus.publish(event),
        usedIn: config.lutsInEdits,
        // Show in Finder selects the .cube file (`open -R`), so the default is not the folder opener.
        openFolder: options.openFolder ?? revealInFinder,
        // The final proof of an import: one ffmpeg run. The fake engine has no ffmpeg to ask.
        prover:
          options.lutProver ??
          (config.runner === 'fake' ? async () => null : createFfmpegLutProver('ffmpeg')),
        dataDir: config.dataDir,
        logger,
        clock: options.clock,
      })
    : createDisabledLutService();
  // Fonts (Fonts plan): the repository is there whatever the switch says (made above, for the
  // quick fixes); the real service only while it is on.
  const fonts: FontService = config.fonts
    ? createFontService({
        repo: fontsRepo,
        inboxPath: config.inboxPath,
        dataDir: config.dataDir,
        publish: (event) => bus.publish(event),
        usedIn: config.fontsInNotes,
        // The banner for a font a note asked for names the job, as "Client · Job" (the way the
        // app names a job outside its own page); a job that is gone has no name.
        jobName: (jobId) => {
          const job = jobs.get(jobId);
          return job === null ? null : `${job.client} · ${job.name}`;
        },
        // Show in Finder selects the family's folder in its parent (`open -R`), like the LUTs' file.
        openFolder: options.openFolder ?? revealInFinder,
        logger,
        clock: options.clock,
      })
    : createDisabledFontService();
  // Generated videos (GN0): the repository is there whatever the switch says (a job's removal
  // deletes its row); the real service only while it is on.
  const generateRepo = new GenerateRepository(db, { clock: options.clock });
  // What the services cost the jobs (Higgsfield, ElevenLabs): the Money page's per-job expenses and
  // the Analytics Services section read it, worked out per request from what is recorded.
  const serviceCharges = createServiceChargeReader({
    jobs,
    generate: generateRepo,
    usage: () => readUsageLog(config.dataDir),
    // Each Instagram scan's Apify cost (IG7), whatever the switch says now: a scan that ran was paid.
    instagram: instagramRepo,
  });
  const generate: GenerateService = config.generate
    ? createGenerateService(generateRepo, {
        // The stage's History is a file of the job's edit/ folder (GN5).
        history: async (jobId) => {
          const job = jobs.get(jobId);
          return job === null
            ? []
            : readGenerateHistory(join(config.inboxPath, job.relPath, 'edit'));
        },
      })
    : disabledGenerateService;
  // A series' changes reach the browsers (K4 sends them down the stream), and an install lets the
  // client's waiting jobs join it by name (K1).
  series.onChange((change) => {
    if (change.type === 'removed') {
      bus.publish({ type: 'series.removed', seriesId: change.seriesId, clientId: change.clientId });
      return;
    }
    bus.publish({ type: 'series.changed', series: change.series });
    if (!change.installed) return;
    try {
      for (const job of assignWaitingJobs(seriesAssign, change.series.clientId)) publishJob(job);
    } catch (err) {
      logger.error({ err, seriesId: change.series.id }, 'could not let the waiting jobs join');
    }
  });
  // A job entering or leaving the queue moves the others' place in line without writing them.
  followQueuePlaces({ bus, jobs });
  // Web push (Mobile plan §6): the phones that turned notifications on hear when a job needs the owner.
  // The VAPID keys are made on first use into <dataDir>/push.json, so an engine that is never asked
  // for a key or a push writes nothing.
  const remoteAccess = options.remoteAccess ?? (() => configuredAccess(config));
  const team =
    options.team ??
    new TeamService(join(config.dataDir, TEAM_FILE_NAME), {
      onUnreadable: (err) =>
        logger.warn({ err }, 'team.json cannot be read: keeping the last good team'),
    });
  const pushDevices = new PushDeviceRepository(db, { clock: options.clock });
  const vapidKeys = createVapidKeyStore({
    dataDir: config.dataDir,
    generate: generateVapidKeys,
    clock: options.clock,
  });
  const push = createPushService({
    devices: pushDevices,
    jobs,
    // A phone hears only about the clients its owner sees (Team plan, TM2). A device with no
    // owner was registered before the team existed: it is the owner's, and so is one registered on
    // this Mac itself (`local`) or by an owner login. Someone no longer on the team hears nothing.
    canSee: (owner, clientId) => {
      if (owner === null || owner === 'local') return true;
      const login = owner.trim().toLowerCase();
      if (remoteAccess().logins.includes(login)) return true;
      const member = team.find(login);
      return member !== undefined && team.canSee({ email: login, role: member.role }, clientId);
    },
    sender:
      options.pushSender ??
      createWebPushSender({
        keys: () => vapidKeys.get(),
        subject: () => resolveVapidSubject(config.pushSubject, remoteAccess().logins[0]),
      }),
    logger,
  });
  const stopPush = push.listen(bus);
  // Every 15 s while a job edits: publishes its ETA when it moved (E5). Started with the worker.
  const etaTicker = createEtaTicker({
    bus,
    jobs,
    timers: options.etaTimers,
    onError: (err) => logger.warn({ err }, 'could not refresh the ETA'),
  });
  // Aborted by `stop()`, so shutdown does not wait for the browsers' open event streams.
  const streams = new AbortController();

  // Edits use the Graphics library only while both Graphics switches are on.
  const libraryInEdits = config.graphics && config.graphicsInEdits;
  const baseRunner = buildRunner({ config, logger, createRunner: options.createRunner });
  // While notes can name a LUT (LUTs and lutsInEdits both on), the run's notes are read first: a
  // LUT they name is copied into the job and counted, and the run is told (LU9). Off: nothing runs
  // and an `@luts/…` in a note is plain text.
  const lutsInEdits = config.luts && config.lutsInEdits;
  // Likewise a font a note names (Fonts and fontsInNotes both on): its file is made sure of in the
  // job, the use counted, and the run told (FN15). It sits inside the LUT wrapper, which hands its
  // own references down on the context and gets the fonts added to them.
  const fontRunner =
    baseRunner !== null && config.fonts && config.fontsInNotes
      ? withFontRefs(
          baseRunner,
          {
            catalog: () => fonts.catalog(),
            uses: fontsRepo,
            // A name the library lacks is written down for the Fonts page's banner (FN16).
            requests: fontsRepo,
            publish: (event) => bus.publish(event),
            inboxPath: config.inboxPath,
            logger,
          },
          logger,
        )
      : baseRunner;
  const lutJobFiles: LutJobFilesOptions = {
    luts: lutsRepo,
    // A graphics token is the run's business only while edits use the Graphics library.
    ...(libraryInEdits ? { graphics: graphicsRepo } : {}),
    builtIn: builtInLuts,
    inboxPath: config.inboxPath,
    publish: (event) => bus.publish(event),
    logger,
    clock: options.clock,
  };
  // ... and an edit run is told what its footage says about camera log, with the one Camera LUT that
  // matches (LU10).
  lutJobFiles.camera = createCameraPreparer(lutJobFiles, options.cameraTagProbe);
  const builtRunner =
    fontRunner !== null && lutsInEdits ? withLutRefs(fontRunner, lutJobFiles, logger) : fontRunner;
  // While Soundtrack is on, an edit or revise run that ends has its music looked at: the versions
  // it made go in the usage log and the page hears `job.music`; the outcome is the runner's own.
  const editRunner =
    builtRunner !== null && music !== null
      ? withMusicRuns(builtRunner, (job) => music.afterRun(job), logger)
      : builtRunner;
  // While Fonts is on, a successful edit or revise run counts the library fonts its compositions
  // use into "Used in" (FN17); the run's outcome is the runner's own.
  const usedFontsRunner =
    editRunner !== null && config.fonts
      ? withFontUses(
          editRunner,
          (job) =>
            recordFontUses(
              {
                repo: fontsRepo,
                fonts,
                usedIn: config.fontsInNotes,
                publish: (event) => bus.publish(event),
                logger,
              },
              job,
              join(config.inboxPath, job.relPath),
            ),
          logger,
        )
      : editRunner;
  // While edits use the Graphics library, a successful edit or revise run counts the library
  // graphics its edit mounted into "Used in" (GR9); the run's outcome is the runner's own.
  const runner =
    usedFontsRunner !== null && libraryInEdits
      ? withGraphicUses(
          usedFontsRunner,
          (job) =>
            recordGraphicUses(
              {
                repo: graphicsRepo,
                inboxPath: config.inboxPath,
                publish: (event) => bus.publish(event),
                logger,
              },
              job,
              join(config.inboxPath, job.relPath),
            ),
          logger,
        )
      : usedFontsRunner;
  // The Graphics library reaches the Brief step only while edits use it (GR8); off, nothing is copied.
  const brief =
    runner === null
      ? undefined
      : buildBrief(options, seriesRepo, libraryInEdits ? graphicsRepo : undefined);
  // The Generate step (GN5): only while the switch is on; a job with no footage is not edited without it.
  const generateStep =
    runner === null
      ? undefined
      : buildGenerate(options, generateRepo, (jobId, state) =>
          bus.publish({ type: 'job.generate', jobId, generate: state }),
        );
  const versions = createVersionService({ inboxPath: config.inboxPath, logger });
  const worker =
    runner === null || brief === null || generateStep === null
      ? null
      : new QueueWorker({
          jobs,
          stepRuns,
          runner,
          // The client's instructions and the owner's note become edit/brief.md before each edit (B4).
          brief,
          // A job with no footage gets its shots, voice and clips made after that (GN5).
          generate: generateStep,
          // A finished run is exported to `<exportsDir>/<Client>/<Job>.mp4` (E6).
          finalize: createFinalize({
            inboxPath: config.inboxPath,
            exportsDir: config.exportsDir,
          }),
          // Retry after a failed export exports again instead of starting a new run (CVP-84).
          reexport: { inboxPath: config.inboxPath, logsDir: config.logsDir },
          review: config.review,
          // Every run that ends in Review keeps a version of the preview (VE0).
          captureVersion: (job, preview) => versions.capture(job, preview),
          // A revise round of a generated video may have spent more of its budget (C67).
          ...(config.generate
            ? {
                afterRun: (job: Job) =>
                  syncGeneratedSpend(
                    generateRepo,
                    job.id,
                    join(config.inboxPath, job.relPath),
                    (jobId, state) => bus.publish({ type: 'job.generate', jobId, generate: state }),
                  ),
              }
            : {}),
          reuseRender: (job, signal) => reviewExports.useFor(job, signal),
          // Every finished job adds its look to its client's style (C4, C10), and an approved
          // episode with Series notes becomes its series' format (C26)...
          afterReady: withNoSongOnReady(
            createLearnOnReady({
              inboxPath: config.inboxPath,
              worker: styleWorker,
              series,
              logger,
            }),
            // ...and a job whose music is the song gets its second file, which the worker does
            // not wait for (SG8).
            noSong,
            logger,
          ),
          // ...and the next edit of that client waits for it; another client's starts at once.
          beforeStart: createLearnWait({ worker: styleWorker }),
          onJobChanged: publishJob,
          // Two jobs edit side by side while the Two jobs at once switch is on.
          atOnce: config.twoJobsAtOnce ? 2 : 1,
          logger,
        });

  // The stills of Use this look and the previews' posters (one maker, one ffmpeg per frame).
  const stills = new JobStills({ inboxPath: config.inboxPath, exportsDir: config.exportsDir });
  // Why the engine is working in a job's folder beside the edit queue right now (a quick fix, its
  // music, the file without the song): a rename of the job, or of its client, waits for it.
  const jobInUse = async (job: Job): Promise<string | null> => {
    const fixing = fixes?.reviewBlock(job.id) ?? null;
    if (fixing !== null) return fixing;
    if (music?.makingVersion(job.id) != null) {
      return 'The music is being made. Wait for it before renaming this video.';
    }
    if ((await noSong?.statusFor(job))?.state === 'making') {
      return 'The file without the song is being made. Wait for it before renaming this video.';
    }
    return null;
  };
  // Clients × Instagram (IG4), only while the switch is on: the scanner (the real one reads through
  // Apify) and the queue that runs it, one scan at a time and never in the edit queue. `start()`
  // begins its weekly check, `stop()` aborts the scan that runs. A rename or a delete of a client
  // waits while a scan of it is queued or running.
  const instagramTimeZone = options.instagramScan?.timeZone;
  const instagramScanner: InstagramScanner | null = config.instagram
    ? (options.instagramScan?.scanner ??
      createScannerFor(config, { instagram: instagramRepo, clock: options.clock }))
    : null;
  const instagramScans: InstagramScanQueue | null =
    instagramScanner === null
      ? null
      : createInstagramScanQueue({
          scanner: instagramScanner,
          instagram: instagramRepo,
          // Which clients (Settings › Instagram): every client with an account, or the ones with a
          // job added or delivered in the last 60 days.
          activeClients: () =>
            config.instagramClients === 'all'
              ? null
              : activeClientIds(
                  (options.clock ?? (() => new Date()))(),
                  jobs.getAll(),
                  deliveries.list(),
                ),
          clientExists: (clientId) =>
            findClient(clientId, { jobs, folders: clientFolders, clientStyles }) !== null,
          publish: (event) => bus.publish(event),
          clock: options.clock,
          timeZone: instagramTimeZone,
          timers: options.instagramScan?.timers,
          logger,
        });
  const instagramBusy = (clientId: string): boolean =>
    instagramScans?.isBusy(clientId) === true || instagramScanner?.isScanning(clientId) === true;

  // What @owner_account sends the studio's Instagram in a DM (the DMs page).
  const dmInbox =
    options.dmInbox ??
    new DmInbox({
      dataDir: config.dataDir,
      logger,
      ...(config.instagramDmFrom === undefined ? {} : { from: config.instagramDmFrom }),
    });
  const app = createApp({
    webDist,
    jobs: {
      jobs,
      worker,
      exportsDir: config.exportsDir,
      onJobChanged: publishJob,
      onReviewTime: publishMoneyChanged,
      onMoneyChanged: publishMoneyChanged,
      review,
      // What the engine runs for a job's music stops before the job is cancelled or deleted.
      ...(music === null ? {} : { stopMusic: (id: string) => music.stopJob(id) }),
      // ... and so do its quick fixes, their copies put back first (QF3).
      ...(fixes === null ? {} : { stopFixes: (id: string) => fixes.stopJob(id) }),
      // ... and the render of the file without the song, which `?file=no-song` of the download serves (SG8).
      ...(noSong === null ? {} : { noSong }),
      // A rename moves the folder, so it waits while the engine works in it beside the edit queue.
      inUse: jobInUse,
      inboxPath: config.inboxPath,
      logsDir: config.logsDir,
      onJobRemoved: (id) => bus.publish({ type: 'job.remove', id }),
    },
    clients: {
      jobs,
      clientStyles,
      folders: clientFolders,
      inboxPath: config.inboxPath,
      exportsDir: config.exportsDir,
      registerClient: async (name) => (await clientRegistry())?.add(name),
      // Each row's Instagram in short (IG6); no row has one while the switch is off.
      ...(!config.instagram
        ? {}
        : {
            instagram: {
              summary: (clientId: string) =>
                readClientInstagramSummary(instagramRepo, clientId, {
                  now: (options.clock ?? (() => new Date()))().getTime(),
                  timeZone: instagramTimeZone ?? machineTimeZone(),
                }),
            },
          }),
      // A client an editor makes is theirs (Team plan, TM0).
      // The folder was just made (a name already on disk is refused), so whatever the team file
      // still holds for this id is left over from an earlier client of the name: it goes first.
      onClientCreated: (client, creator) => {
        const dropped = team.removeClient(client.clientId);
        const assigned = team.autoAssign(client.clientId, client.client, creator);
        if (dropped || assigned) bus.publish({ type: 'access.changed' });
      },
      openFolder: options.openFolder ?? openInFinder,
      styles: { worker: styleWorker, uploads: styleDrops },
      // The admin's Rename: the folder, the exports, the history, the logs and every row move.
      rename: {
        exportsDir: config.exportsDir,
        dataDir: config.dataDir,
        logsDir: config.logsDir,
        jobs,
        series: seriesRepo,
        registry: clientRegistry,
        team,
        inUse: jobInUse,
        instagramBusy,
        uploads: styleDrops,
        publish: (event) => bus.publish(event),
        logger,
      },
      // The admin's Delete: the folders go to the Trash, every row and file of the client goes.
      remove: {
        exportsDir: config.exportsDir,
        dataDir: config.dataDir,
        logsDir: config.logsDir,
        jobs,
        series: seriesRepo,
        registry: clientRegistry,
        team,
        inUse: jobInUse,
        instagramBusy,
        publish: (event) => bus.publish(event),
        logger,
      },
    },
    preview: {
      jobs,
      inboxPath: config.inboxPath,
      posters: stills,
      videos: previewVideos,
      exports: reviewExports,
      // Export MP4 waits while a quick fix is changing the preview (QF3).
      ...(fixes === null ? {} : { reviewBlock: (job: Job) => fixes.reviewBlock(job.id) }),
    },
    notes: { review },
    // The preview versions and Restore (VE1): unsent notes, a music pick under way or a quick fix
    // keep a job as it is.
    versions: {
      jobs,
      versions,
      inboxPath: config.inboxPath,
      countUnsentNotes: (jobId) => notes.countUnsent(jobId),
      countFixedNotes: (jobId) => notes.listUnsent(jobId).filter(isFixedNote).length,
      ...(reviewBlock === undefined ? {} : { reviewBlock }),
      onJobChanged: publishJob,
    },
    // Mark delivered, Mark paid and their undos (Phase 4 §3).
    delivery: {
      jobs,
      deliveries,
      recordDelivery: writeDelivery,
      // Mark delivered is refused while money.json is invalid with no good version (CVP-203),
      // unless a resolver replaced the money file as the source of prices.
      moneyIsValid: () => options.priceFor !== undefined || moneyFile.hasGoodValues(),
      onJobChanged: publishJob,
      onMoneyChanged: publishMoneyChanged,
    },
    // The Money page: the deliveries and money.json, worked out per request.
    money: {
      deliveries,
      jobs,
      money: moneyFile,
      clock: options.clock,
      archivedJobIds: () => jobs.archivedIds(),
      // "Sent it to <client>?" on the phone says the price a delivery would be recorded with.
      priceFor,
      // Higgsfield's dollars and ElevenLabs' credits, in the expenses of the video that used them.
      serviceCharges,
    },
    // Use this look and the stills of its dialog (C4).
    jobStyle: {
      jobs,
      clientStyles,
      worker: styleWorker,
      stills,
    },
    // An editor's stream carries only their clients' events and ends when access changes (TM2).
    events: {
      bus,
      signal: streams.signal,
      scope: {
        canSee: (viewer, clientId) => team.canSee(viewer, clientId),
        clientOfJob: (id) => jobs.get(id)?.clientId ?? deliveries.get(id)?.clientId ?? null,
        jobs: () => jobs.getAll(),
        stillAdmin: (viewer) =>
          remoteAccess().logins.includes(viewer.email) || team.find(viewer.email)?.role === 'admin',
      },
    },
    // The phone's notifications: the key to subscribe with, its devices and the test push.
    push: { devices: pushDevices, push, publicKey: () => vapidKeys.get().publicKey },
    // The series routes (K4); `/api/health` reports whether series are on.
    series: { series },
    // The web's instant Release uses the same delay (CVP-92).
    settleMs: config.settleMs,
    // The Job sheet switch, told to the web in /api/health.
    jobSheet: config.jobSheet,
    // The Analytics switch, told to the web in /api/health; off, /api/analytics does not exist.
    analytics: config.analytics,
    // The Analytics page's numbers: worked out per request from the jobs, their timed steps, the
    // sent notes, the deliveries and the logs: the usage log, the limits log (limits.jsonl) and the
    // topic pass's note-topics.json.
    analyticsRoutes: {
      jobs,
      stepRuns,
      notes,
      deliveries,
      usage: () => readUsageLog(config.dataDir),
      limits: () => readLimits(config.dataDir),
      noteTopics: () => noteTopicStore.get(),
      // The Services section: every API, with money.json's plans and what the videos cost.
      services: { money: () => moneyFile.get(), charges: serviceCharges },
      planProbe,
      clock: options.clock,
    },
    // The Phone switch, told to the web in /api/health.
    phone: config.phone,
    // The Graphics switches, told to the web in /api/health; off, no graphics route is mounted.
    graphics: config.graphics,
    graphicsInEdits: config.graphicsInEdits,
    // The Soundtrack switch, told to the web in /api/health; off, no music route is mounted.
    music: config.music,
    ...(music === null ? {} : { musicRoutes: { jobs, music } }),
    // The LUTs switches, told to the web in /api/health; off, no LUTs route is mounted.
    luts: config.luts,
    lutsInEdits: config.lutsInEdits,
    // The look on the paused frame in Review: mounted while both LUTs switches are on (LU11).
    reviewFrame: {
      jobs,
      luts: lutsRepo,
      builtIn: builtInLuts,
      inboxPath: config.inboxPath,
      frames: reviewFrames,
    },
    lutsRoutes: {
      luts: { service: luts },
      previews: {
        luts: lutsRepo,
        builtIn: builtInLuts,
        previews: lutPreviews,
        inboxPath: config.inboxPath,
      },
    },
    // The Fonts switches, told to the web in /api/health; off, no Fonts route is mounted.
    fonts: config.fonts,
    fontsInNotes: config.fontsInNotes,
    // The Quick fixes switch, told to the web in /api/health; off (the default), nothing of it runs
    // and no fix route is mounted.
    quickFixes: config.quickFixes,
    // The Generate switch, told to the web in /api/health; off, the generate route does not exist.
    generate: config.generate,
    // The Draft & chat switch, told to the web in /api/health; off, Review keeps its notes column
    // and the chat's routes say it is off.
    draftChat: config.draftChat,
    ...(config.currencySymbol === undefined ? {} : { currencySymbol: config.currencySymbol }),
    ...(feed === null ? {} : { feedRoutes: { jobs, feed } }),
    // The Clients × Instagram switch, told to the web in /api/health; off, every Instagram route
    // says it is off.
    instagram: config.instagram,
    ...(instagramScans === null
      ? {}
      : {
          instagramRoutes: {
            clients: { jobs, folders: clientFolders, clientStyles },
            instagram: {
              repo: instagramRepo,
              clock: options.clock,
              // The days and the next Monday on the page are the queue's.
              ...(instagramTimeZone === undefined ? {} : { timeZone: () => instagramTimeZone }),
            },
            scans: instagramScans,
            dataDir: config.dataDir,
            publish: (event: ServerEvent) => bus.publish(event),
            // Link a reel to a job: the job's update (it turns Uploaded) and the client's Instagram
            // go out on the bus (IG5).
            link: {
              jobs,
              instagram: instagramRepo,
              onJobChanged: publishJob,
              onClientInstagramChanged: (clientId: string) =>
                bus.publish({ type: 'client-instagram', clientId }),
            },
          },
        }),
    ...(config.generate
      ? {
          generateRoutes: { jobs, generate },
          generateReviewRoutes: { jobs, inboxPath: config.inboxPath },
        }
      : {}),
    // The Songs switch, told to the web in /api/health; off, the note's picture routes are not
    // mounted (SG5).
    songs: config.songs,
    ...(config.songs
      ? {
          noteAttachments: {
            jobs,
            inboxPath: config.inboxPath,
            // A phone's HEIC is kept as a JPEG: the Brief run's Read tool cannot read HEIC (SG6).
            heicToJpeg: sipsHeicToJpeg,
          },
        }
      : {}),
    // The second export's status and Try again (SG8), mounted with the Songs switch.
    ...(noSong === null ? {} : { noSongRoutes: { jobs, noSong } }),
    ...(fixes === null ? {} : { fixRoutes: { jobs, fixes } }),
    fontsRoutes: { service: fonts },
    graphicsRoutes: {
      graphics: { service: graphics },
      files: {
        graphics: graphicsRepo,
        inboxPath: config.inboxPath,
        assetsDir: GRAPHICS_ASSETS_DIR,
      },
      voice: {
        transcriber,
        dataDir: config.dataDir,
        // Real transcriptions go in the usage log (`transcribe`); the fake transcriber's don't.
        ...(transcriber.kind === 'real'
          ? {
              onTranscribed: () =>
                void logAppUsage(
                  { dataDir: config.dataDir, home: homedir(), env: process.env, logger },
                  graphicVoiceUsage(),
                  null,
                ),
            }
          : {}),
      },
    },
    // The job sheet's steps, sent notes and Show in Finder (JS1); work with the switch on or off.
    jobSheetRoutes: {
      jobs,
      steps: stepRuns,
      notes,
      inboxPath: config.inboxPath,
      exportsDir: config.exportsDir,
      openFolder: options.openFolder ?? openInFinder,
      revealFile: options.revealFile ?? revealInFinder,
      // The linked reel's numbers for the sheet's "On Instagram" line, only while the switch is on.
      ...(config.instagram ? { instagram: instagramRepo } : {}),
    },
    // The Host, tailnet-login and Origin checks in front of everything (PH1), and who is asking.
    remoteAccess,
    team,
    // What an editor may reach: only the jobs, series and clients of their clients (TM1).
    scope: {
      canSee: (viewer, clientId) => team.canSee(viewer, clientId),
      clientOfJob: (id) => jobs.get(id)?.clientId ?? deliveries.get(id)?.clientId ?? null,
      clientOfSeries: (id) => seriesRepo.get(id)?.clientId ?? null,
    },
    // The feature switches of the Settings page and the restart (admin only).
    ...(options.settings
      ? {
          settingsRoutes: {
            settings: new FeatureSettings({
              configPath: options.settings.configPath,
              running: {
                graphics: config.graphics,
                fonts: config.fonts,
                luts: config.luts,
                claudePlanOnly: config.claudePlanOnly,
                draftChat: config.draftChat,
                twoJobsAtOnce: config.twoJobsAtOnce,
                quickFixes: config.quickFixes,
                instagram: config.instagram,
              },
              instagramClients: config.instagramClients,
            }),
            restart: options.settings.restart,
          },
        }
      : {}),
    // The Instagram DMs page: what came in, Check now, the files and Show in Finder.
    dmsRoutes: { inbox: dmInbox, revealFile: options.revealFile ?? revealInFinder },
    // The team API: people and who sees which client (admin only, TM3).
    teamRoutes: {
      team,
      clients: { jobs, folders: clientFolders, clientStyles },
      onChanged: () => bus.publish({ type: 'access.changed' }),
    },
  });

  // The inbox side (W3). The watcher settles jobs into the queue by publishing them on the bus, and
  // nothing else tells the worker, so a queued job on the bus wakes it.
  bus.subscribe((event) => {
    if (event.type === 'job.upsert' && event.job.state === 'queued') worker?.notify();
  });
  // A client folder that is gone for good takes its editors with it (C40), so a client made later
  // under the same name starts with nobody. The disk has the last word: a folder the watcher
  // merely failed to read keeps its assignment.
  bus.subscribe((event) => {
    if (event.type !== 'client.removed') return;
    if (dropAssignmentOfGoneClient(team, config.inboxPath, event.clientId, event.client)) {
      bus.publish({ type: 'access.changed' });
    }
  });
  // At start-up, the same for a folder that went while the engine was off: only after the inbox
  // was listed without a failure.
  const pruneGoneClients = async (): Promise<void> => {
    try {
      const present = await listClientNames(config.inboxPath, { exportsDir: config.exportsDir });
      if (pruneGoneAssignments(team, config.inboxPath, present) > 0) {
        bus.publish({ type: 'access.changed' });
      }
    } catch (err) {
      logger.warn({ err }, 'could not check the team assignments against the client folders');
    }
  };

  let inbox: RunningInbox | null = null;
  let inboxStarting: Promise<void> = Promise.resolve();
  // The Fonts index is built and `_Fonts` watched once the inbox has made the folder; the workers
  // do not wait for it (a request that comes sooner waits for the first build itself).
  let fontsStarting: Promise<void> = Promise.resolve();
  let stopped = false;
  let stopLutReaper: () => void = () => {};

  // Never throws: the API and the queue are worth having even when the inbox cannot be watched
  // (it is a drive that is not mounted, say), so the worker starts either way. The next boot
  // tries again.
  const bootInbox = async (): Promise<void> => {
    try {
      if (config.knownClientsOnly) await clientRegistry();
      const running = await (options.startInbox ?? startInbox)({
        config,
        repo: jobs,
        clientStyles,
        clientFolders,
        bus,
        logger: inboxLogger,
        // The job is already marked failed. The worker only has something to stop when the folder
        // vanishes after it started (at boot it has not started yet and finds nothing).
        onFolderRemovedWhileEditing: (job) => {
          worker?.cancel(job.id).catch((err: unknown) => {
            logger.error({ err, jobId: job.id }, 'could not stop the edit of a removed folder');
          });
        },
        onStyleEvent: (event) => styleDrops.notify(event),
        // A job the inbox finds or settles may join a series by its name (K1).
        assignSeries: (job) => assignSeries(seriesAssign, job),
      });
      if (stopped) await running.stop();
      else {
        inbox = running;
        await pruneGoneClients();
      }
    } catch (err) {
      logger.error(
        { err, inboxPath: config.inboxPath },
        'The inbox is not being watched: reconciling or watching it failed. The API and the queue still work; restart after fixing it.',
      );
    }
  };

  const noStoredStyles = (): boolean => {
    try {
      return clientStyles.list().length === 0;
    } catch (err) {
      logger.error({ err }, 'could not read the client styles');
      return false;
    }
  };

  // Never throws: a style that cannot be learned never stops the engine.
  const backfill = async (): Promise<void> => {
    try {
      await backfillStyles({ jobs, inboxPath: config.inboxPath, worker: styleWorker, logger });
    } catch (err) {
      logger.error({ err }, 'could not learn the client styles from the finished jobs');
    }
  };

  // Never throws: once, the fonts of the jobs that finished before the fonts scan existed (FN17).
  // Waits for the font index (it asks it for the library's families); writes only a marker file.
  const backfillFontUsesOnce = async (): Promise<void> => {
    if (!config.fonts) return;
    try {
      await backfillFontUses({
        jobs,
        repo: fontsRepo,
        fonts,
        inboxPath: config.inboxPath,
        dataDir: config.dataDir,
        shouldStop: () => stopped,
        logger,
      });
    } catch (err) {
      logger.error({ err }, 'could not read the fonts of the finished jobs');
    }
  };

  // Never throws: the limits log only feeds the Analytics page. Writes <dataDir>/limits.jsonl from
  // the past runs' logs on the first start with it, and does nothing after that.
  const backfillLimitsLog = async (): Promise<void> => {
    try {
      await backfillLimits({ dataDir: config.dataDir, logsDir: config.logsDir });
    } catch (err) {
      logger.error({ err }, 'could not read the Claude limits from the past runs');
    }
  };

  return {
    app,
    jobs,
    clientStyles,
    clientFolders,
    deliveries,
    recordDelivery,
    moneyFile,
    notes,
    seriesRepo,
    series,
    graphicsRepo,
    graphics,
    graphicWorker,
    lutsRepo,
    luts,
    fontsRepo,
    fonts,
    generateRepo,
    generate,
    music,
    fixes,
    instagramRepo,
    instagramScans,
    review,
    push,
    worker,
    styleWorker,
    bus,
    // The inbox goes first: reconciling removes jobs whose folder is gone and fails the editing
    // ones, which the worker would otherwise pick up (it reads the queue and the jobs left in
    // `editing` when it starts). A `notify()` that arrives before `worker.start()` is ignored, and
    // `start()` looks at the queue itself, so nothing queued by the reconciliation is missed.
    start: () => {
      // The server is up already and the inbox boot lists the client folders in a moment: until
      // then they are unknown, not none, and the client list waits for them.
      clientFolders.expectSeed();
      // An edit of money.json tells the Money page. Closed again by `stop()`.
      moneyFile.watch(publishMoneyChanged);
      // The DMs are read beside everything else, and only by a real engine.
      if (config.runner === 'claude' && options.createRunner === undefined) dmInbox.start();
      // LUT uploads waiting from before this boot are thrown away, then the old ones every hour.
      if (config.luts) stopLutReaper = startLutStagingReaper(lutStaging, logger);
      // Before the boot records the hand-made styles: no stored style at all means this is the
      // first start with client styles, which learns them from the finished jobs (C4).
      const firstWithStyles = noStoredStyles();
      // Beside the inbox, which it does not depend on; the workers wait for it below.
      const limitsLog = backfillLimitsLog();
      inboxStarting = bootInbox().then(async () => {
        if (stopped) return;
        // After the inbox on purpose: reconcile has removed the jobs whose folder is gone, and
        // their notes with them. It runs when edits are paused too.
        try {
          review.resumeTranscriptions();
        } catch (err) {
          logger.error({ err }, 'could not transcribe the voice notes left from the last run');
        }
        // Quick fixes (QF3): what an earlier engine left running is stopped, its copies put back
        // and its queue cancelled, before any note is sorted again (which can queue new fixes).
        // Never throws.
        await fixes?.start();
        if (stopped) return;
        // Notes an earlier engine left being sorted by the router (quick fixes).
        try {
          noteRouting.resume();
        } catch (err) {
          logger.error({ err }, 'could not sort the review notes left from the last run');
        }
        // Notes sent before this boot that have no topic yet (or a pass that failed last time).
        noteTopicPass?.trigger();
        if (firstWithStyles) await backfill();
        // Before any run can report its limits: a reading logged first would make the backfill skip.
        await limitsLog;
        if (stopped) return;
        // The style worker first: the edit worker asks it whether a client's style is being
        // learned, and one that never started has nothing to wait for.
        try {
          styleWorker.start();
        } catch (err) {
          logger.error({ err }, 'Style runs are paused: the style worker could not start');
        }
        // Never throws; off, the disabled service does nothing.
        fontsStarting = fonts
          .start()
          .catch((err: unknown) => {
            logger.error({ err }, 'could not start the Fonts index');
          })
          // Beside the workers, which never wait for it; `stop()` waits for it to end.
          .then(backfillFontUsesOnce);
        // Graphic runs (only while Graphics are on) go beside the edits and never wait for them.
        try {
          graphicWorker?.start();
        } catch (err) {
          logger.error({ err }, 'Graphic runs are paused: the graphic worker could not start');
        }
        try {
          worker?.start();
        } catch (err) {
          logger.error({ err }, 'Edits are paused: the queue worker could not start');
        }
        if (worker !== null) etaTicker.start();
        // The weekly Instagram scan (off with the switch): a check now, so a Mac that slept through
        // Monday 06:00 scans at once, then every 15 minutes. The inbox is up, so the clients are known.
        instagramScans?.start();
        // The running jobs' chats read their logs as they grow, so each card shows its file as
        // the run wrote it. A job in Review is read when its chat is opened.
        feed?.start(() =>
          jobs
            .getAll()
            .filter((job) => job.state === 'editing')
            .map((job) => job.id),
        );
        // A job already in Review at boot (a restart stops a render that was under way) gets its
        // videos made again, the newest first. Nothing is published for it, so nothing else asks.
        try {
          for (const job of jobs.getAll()) if (job.state === 'review') reviewWarmup.warm(job);
        } catch (err) {
          logger.error({ err }, 'could not start the videos of the jobs left in Review');
        }
        // The built-in LUTs' stills are made in the background, two at a time, niced (LU2).
        if (config.luts) void warmBuiltInLuts(builtInLuts, lutPreviews);
      });
      return inboxStarting;
    },
    stop: async () => {
      // End the browsers' event streams first, so shutdown does not wait for them.
      streams.abort();
      stopped = true;
      stopPush();
      stopWarmupListening();
      reviewWarmup.stop();
      stopMusicListening?.();
      stopFixListening?.();
      stopNoSongListening?.();
      moneyFile.close();
      stopLutReaper();
      etaTicker.stop();
      // No scan starts from here on, and the one that runs is stopped (its row says so).
      const instagramStopped = instagramScans?.stop();
      feed?.stop();
      review.stop();
      // No note is sorted from here on, and the router runs that go are stopped.
      const routingStopped = noteRouting.stop();
      // No fix starts from here on, and the one that runs is stopped, its copy put back (QF3).
      const fixesStopped = fixes?.stop();
      // No topic pass starts from here on, and the one that runs is stopped.
      const topicsStopped = noteTopicPass?.stop();
      const probeStopped = planProbe?.stop();
      await inboxStarting;
      styleDrops.stop();
      await inbox?.stop();
      try {
        await Promise.all([
          fonts.stop().then(() => fontsStarting),
          worker?.stop(),
          styleWorker.stop(),
          topicsStopped,
          routingStopped,
          probeStopped,
          graphicWorker?.stop(),
          music?.stop(),
          noSong?.stop(),
          fixesStopped,
          instagramStopped,
          dmInbox.stop(),
        ]);
      } finally {
        await transcriber.stop();
      }
    },
  };
}
