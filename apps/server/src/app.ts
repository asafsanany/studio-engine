import {
  FEED_MESSAGES,
  FIX_MESSAGES,
  FONT_MESSAGES,
  GRAPHIC_MESSAGES,
  INSTAGRAM_MESSAGES,
  LUT_MESSAGES,
  type MeResponse,
  MUSIC_MESSAGES,
  SETTLE_MS,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { logger } from './logger.js';
import { accessGuard, NO_REMOTE_ACCESS, type RemoteAccess } from './remote/access.js';
import { type AppEnv, type TeamRoles, viewerMiddleware } from './remote/viewer.js';
import { type AnalyticsRouteOptions, createAnalyticsRoutes } from './routes/analytics.js';
import { type ClientsRouteOptions, createClientsRoutes } from './routes/clients.js';
import {
  createDeliveryListRoutes,
  createDeliveryRoutes,
  createPaymentRoutes,
  type DeliveryRouteOptions,
} from './routes/deliveries.js';
import { createDmsRoutes, type DmsRouteOptions } from './routes/dms.js';
import { createEventsRoutes, type EventsRouteOptions } from './routes/events.js';
import { createFeedRoutes, type FeedRouteOptions } from './routes/feed.js';
import { createFixRoutes, type FixRouteOptions } from './routes/fixes.js';
import { createFontFrameRoutes } from './routes/font-frames.js';
import { createFontsRoutes, type FontsRouteOptions } from './routes/fonts.js';
import { createGenerateRoutes, type GenerateRouteOptions } from './routes/generate.js';
import {
  createGenerateReviewRoutes,
  type GenerateReviewRouteOptions,
} from './routes/generate-review.js';
import { createGraphicFilesRoutes, type GraphicFilesRouteOptions } from './routes/graphic-files.js';
import { createGraphicVoiceRoutes, type GraphicVoiceRouteOptions } from './routes/graphic-voice.js';
import { createGraphicsRoutes, type GraphicsRouteOptions } from './routes/graphics.js';
import { createInstagramRoutes, type InstagramRouteOptions } from './routes/instagram.js';
import { createJobSheetRoutes, type JobSheetRouteOptions } from './routes/job-sheet.js';
import { createJobStyleRoutes, type JobStyleRouteOptions } from './routes/job-style.js';
import { createJobsRoutes, type JobsRouteOptions } from './routes/jobs.js';
import { createLutPreviewRoutes, type LutPreviewRouteOptions } from './routes/lut-previews.js';
import { createLutsRoutes, type LutsRouteOptions } from './routes/luts.js';
import { createMoneyRoutes, type MoneyRouteOptions } from './routes/money.js';
import { createMusicRoutes, type MusicRouteOptions } from './routes/music.js';
import { createNoSongRoutes, type NoSongRouteOptions } from './routes/no-song.js';
import {
  createNoteAttachmentRoutes,
  type NoteAttachmentRouteOptions,
} from './routes/note-attachments.js';
import { createNotesRoutes, type NotesRouteOptions } from './routes/notes.js';
import { createPreviewRoutes, type PreviewRouteOptions } from './routes/preview.js';
import { createPushRoutes, type PushRouteOptions } from './routes/push.js';
import { createReviewFrameRoutes, type ReviewFrameRouteOptions } from './routes/review-frame.js';
import { createSeriesRoutes, type SeriesRouteOptions } from './routes/series.js';
import { createSettingsRoutes, type SettingsRouteOptions } from './routes/settings.js';
import { createTeamRoutes, type TeamRouteOptions } from './routes/team.js';
import { createVersionRoutes, type VersionRouteOptions } from './routes/versions.js';
import { mountWebApp } from './static.js';
import { NO_SCOPE, type ScopeResolver, scopeGuard } from './team/scope-guard.js';
import { version } from './version.js';

/** What the three graphics route files need (Graphics plan, "API"). */
export interface GraphicsApiOptions {
  /** The graphics and their chats (routes/graphics.ts, GR1). */
  graphics: GraphicsRouteOptions;
  /** The version files, the preview host and the sample frames (routes/graphic-files.ts, GR3). */
  files: GraphicFilesRouteOptions;
  /** The composer's voice note (routes/graphic-voice.ts, GR5). */
  voice: GraphicVoiceRouteOptions;
}

/** What the two LUTs route files need (LUTs plan, "API"). */
export interface LutsApiOptions {
  /** The LUTs and their import (routes/luts.ts, LU1). */
  luts: LutsRouteOptions;
  /** The graded test stills (routes/lut-previews.ts, LU2). */
  previews: LutPreviewRouteOptions;
}

export interface AppOptions {
  /** Built web app folder (must contain index.html). Omit to serve the API only. */
  webDist?: string;
  /**
   * What `/api/jobs` needs. Always given by the boot wiring (engine.ts); left out only by tests of
   * the parts that do not touch jobs, such as the health check and the static web app.
   */
  jobs?: JobsRouteOptions;
  /** What `/api/clients` needs. Given by the boot wiring; left out by tests that do not touch clients. */
  clients?: ClientsRouteOptions;
  /**
   * What /api/jobs/:id/preview/… needs (the live preview). Given by the boot wiring; left out by
   * tests that do not need it.
   */
  preview?: PreviewRouteOptions;
  /**
   * What /api/jobs/:id/versions… needs (the preview versions and Restore). Given by the boot
   * wiring; left out by tests that do not need it.
   */
  versions?: VersionRouteOptions;
  /**
   * What /api/jobs/:id/notes… needs (the review notes). Given by the boot wiring; left out by
   * tests that do not need it.
   */
  notes?: NotesRouteOptions;
  /**
   * What /api/jobs/:id/use-look and /api/jobs/:id/still need (a job as a client's look). Given by
   * the boot wiring; left out by tests that do not need them.
   */
  jobStyle?: JobStyleRouteOptions;
  /**
   * What /api/jobs/:id/steps, /api/jobs/:id/reveal, /api/jobs/:id/sent-notes and /api/jobs/:id/stock need (the job
   * sheet's data and Show in Finder). Given by the boot wiring; left out by tests that do not need
   * them. The routes work whether the Job sheet switch (`jobSheet`) is on or off.
   */
  jobSheetRoutes?: JobSheetRouteOptions;
  /**
   * What /api/jobs/:id/deliver, /api/jobs/:id/undeliver, /api/payments, /api/payments/undo and
   * /api/deliveries/unpaid-without-job need (Mark delivered and Mark paid). Given by the boot
   * wiring; left out by tests that do not need it.
   */
  delivery?: DeliveryRouteOptions;
  /** What /api/money needs (the Money page's numbers). Given by the boot wiring; left out by tests that do not need it. */
  money?: MoneyRouteOptions;
  /**
   * What /api/analytics needs (the Analytics page's numbers). Given by the boot wiring; left out by
   * tests that do not need it. The route only exists while the Analytics switch (`analytics`) is on.
   */
  analyticsRoutes?: AnalyticsRouteOptions;
  /**
   * What /api/push needs (the phone's notifications: its key, its devices and the test push).
   * Given by the boot wiring; left out by tests that do not need it.
   */
  push?: PushRouteOptions;
  /** The live stream at /api/events. Given by the boot wiring; left out by tests that do not need it. */
  events?: EventsRouteOptions;
  /**
   * What the series routes need (Series plan §5): the series service. Given by the boot wiring;
   * left out by tests that do not need them. `/api/health` reports `series.enabled`, false without it.
   */
  series?: SeriesRouteOptions;
  /**
   * The settle delay the server runs with (`Config.settleMs`), told to the web through
   * `/api/health` so its instant Release picks arriving or queued like the server does. The boot
   * wiring passes the same value it gives the repository and the inbox watcher. Default `SETTLE_MS`.
   */
  settleMs?: number;
  /**
   * The Job sheet switch (`Config.jobSheet`), told to the web through `/api/health`. The boot
   * wiring passes it; default false (off).
   */
  jobSheet?: boolean;
  /**
   * The Analytics switch (`Config.analytics`), told to the web through `/api/health`; it also
   * decides whether `/api/analytics` exists. The boot wiring passes it (the engine's config turns it
   * on by default); left out here, as in most tests, it is off.
   */
  analytics?: boolean;
  /**
   * The Phone switch (`Config.phone`), told to the web through `/api/health`. The boot wiring
   * passes it; default false (off).
   */
  phone?: boolean;
  /**
   * The Graphics switch (`Config.graphics`), told to the web through `/api/health`; it also
   * decides whether the graphics routes are mounted. Off when not given here (the engine's config
   * is on by default since GR7), every `/api/graphics` path answers 404 "Graphics are off.".
   */
  graphics?: boolean;
  /**
   * The switch that lets edits use the Graphics library (`Config.graphicsInEdits`), told to the
   * web through `/api/health`. Off when not given here (the engine's config is on by default since
   * GR11), like `graphics`.
   */
  graphicsInEdits?: boolean;
  /**
   * The Soundtrack switch (`Config.music`), told to the web through `/api/health`; it also decides
   * whether the music routes are mounted. Off when not given here (the engine always passes its
   * config, where it is on unless turned off), every `/api/jobs/:id/music` path answers 404
   * "Music is off.".
   */
  music?: boolean;
  /** What the music routes need. Given by the boot wiring; mounted only while `music` is on. */
  musicRoutes?: MusicRouteOptions;
  /**
   * What the graphics routes need. Given by the boot wiring; mounted only while `graphics` is on.
   */
  graphicsRoutes?: GraphicsApiOptions;
  /**
   * The LUTs switch (`Config.luts`), told to the web through `/api/health`; it also decides whether
   * the LUTs routes are mounted. Off when not given here (the engine's config is on by default),
   * every `/api/luts` path answers 404 "LUTs are off.".
   */
  luts?: boolean;
  /**
   * The switch that lets notes name a LUT (`Config.lutsInEdits`), told to the web through
   * `/api/health`. Off when not given here (the engine's config is off by default until LU14).
   */
  lutsInEdits?: boolean;
  /** What the LUTs routes need. Given by the boot wiring; mounted only while `luts` is on. */
  lutsRoutes?: LutsApiOptions;
  /**
   * What the look on the paused frame needs (LU11). Given by the boot wiring; mounted only while
   * both `luts` and `lutsInEdits` are on, else `/api/jobs/:id/review/frame` answers 404 "LUTs are off.".
   */
  reviewFrame?: ReviewFrameRouteOptions;
  /**
   * The Fonts switch (`Config.fonts`), told to the web through `/api/health`; it also decides
   * whether the Fonts routes are mounted. Off when not given here (the engine's config is on by
   * default), every `/api/fonts` path answers 404 "Fonts are off.".
   */
  fonts?: boolean;
  /**
   * The switch that lets notes name a font (`Config.fontsInNotes`), told to the web through
   * `/api/health`. Off when not given here (the engine's config is on by default since FN23), like
   * `fonts`.
   */
  fontsInNotes?: boolean;
  /**
   * The Quick fixes switch (`Config.quickFixes`), told to the web through `/api/health`. Off when
   * not given here (the engine's config is off by default until QF9).
   */
  quickFixes?: boolean;
  /**
   * The Songs switch (`Config.songs`: asked for and music on), told to the web through
   * `/api/health`, and only while `music` is given on too. Off when not given here (the engine
   * always passes its config, where it is on unless turned off).
   */
  songs?: boolean;
  /**
   * The Generate switch (`Config.generate`), told to the web through `/api/health`; it also decides
   * whether `GET /api/jobs/:id/generate` exists. Off when not given here (the engine's config is
   * off by default until GN11): that path is the ordinary 404, as before Generated videos.
   */
  generate?: boolean;
  /**
   * The Draft & chat switch (`Config.draftChat`, DR1), told to the web through `/api/health`. Off
   * when not given here (the engine's config is off by default): Review keeps its notes column.
   */
  draftChat?: boolean;
  /** The symbol money is shown with, told to the web through `/api/health`. */
  currencySymbol?: string;
  /**
   * The Clients × Instagram switch (`Config.instagram`, IG0), told to the web through `/api/health`.
   * Off when not given here (the engine's config is off by default): every Instagram route answers
   * 404 "Clients × Instagram is off.".
   */
  instagram?: boolean;
  /** What the Instagram routes need (IG0). Given by the boot wiring; mounted only while `instagram` is on. */
  instagramRoutes?: InstagramRouteOptions;
  /**
   * What the Instagram DMs page needs (`/api/dms`, the admin's only). Given by the boot wiring;
   * left out, those paths do not exist.
   */
  dmsRoutes?: DmsRouteOptions;
  /** What the job chat's routes need (DR3). Given by the boot wiring; mounted only while `draftChat` is on. */
  feedRoutes?: FeedRouteOptions;
  /** What the generate route needs. Given by the boot wiring; mounted only while `generate` is on. */
  generateRoutes?: GenerateRouteOptions;
  /** What the note hints in Review read of a generated video (GN8). Mounted only while `generate` is on. */
  generateReviewRoutes?: GenerateReviewRouteOptions;
  /**
   * What the note's pictures need (`GET /api/jobs/:id/note` and the attachment routes, SG5). Given
   * by the boot wiring; mounted only while `songs` (with `music`) is on, else there is no such route.
   */
  noteAttachments?: NoteAttachmentRouteOptions;
  /**
   * What the second export's routes need (`GET` and `POST /api/jobs/:id/no-song`, SG8). Given by
   * the boot wiring; mounted only while `songs` (with `music`) is on, else there is no such route.
   */
  noSongRoutes?: NoSongRouteOptions;
  /** What the fix routes (`/api/jobs/:id/fixes…`) need. Given by the boot wiring; mounted only while `quickFixes` is on. */
  fixRoutes?: FixRouteOptions;
  /** What the Fonts routes need. Given by the boot wiring; mounted only while `fonts` is on. */
  fontsRoutes?: FontsRouteOptions;
  /**
   * Who may come in from outside this Mac, through Tailscale Serve (Mobile plan §4): the Mac's
   * Tailscale name and the logins let in, as known right now. The boot wiring passes the tailnet's
   * (remote/tailnet.ts); default: nobody, so only loopback Hosts get in.
   */
  remoteAccess?: () => RemoteAccess;
  /**
   * The team (team.json): its logins are let in through Serve besides `remoteAccess`'s, as editors
   * or admins by their role, read on every request. Given by the boot wiring; default: nobody.
   */
  team?: TeamRoles & { emails(): string[] };
  /**
   * What the scope guard needs to tell which client a job or series belongs to and whether an
   * editor sees it (team/scope-guard.ts). Given by the boot wiring; default: nobody is in scope,
   * so an editor (there are none without a team) gets only the routes open to everyone.
   */
  scope?: ScopeResolver;
  /**
   * What the team API needs (`/api/team`, `/api/clients/:id/assignees`; admin only). Given by the
   * boot wiring; left out, those paths do not exist. The owner's logins come from `remoteAccess`.
   */
  teamRoutes?: Omit<TeamRouteOptions, 'ownerLogins'>;
  /**
   * What the Settings API needs (`/api/settings`: the feature switches and the engine restart;
   * admin only). Given by the boot wiring; left out, those paths do not exist.
   */
  settingsRoutes?: SettingsRouteOptions;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono<AppEnv>();

  // Who comes in through Serve: the owner and config.json's logins (admins), and the team.
  const owner = options.remoteAccess ?? (() => NO_REMOTE_ACCESS);
  const team = options.team;
  const allowed = (): RemoteAccess => {
    const base = owner();
    if (team === undefined) return base;
    return { hosts: base.hosts, logins: [...new Set([...base.logins, ...team.emails()])] };
  };

  // Before every route and the web app's files: the Host, the tailnet login and the Origin of
  // writes (remote/access.ts).
  app.use(
    '*',
    accessGuard({
      remote: allowed,
      onRefused: (refusal) => logger.warn(refusal, 'refused a request: not allowed'),
    }),
  );
  // Right after: who is asking, as `c.var.viewer`; writes are logged with their viewer
  // (remote/viewer.ts).
  app.use('*', viewerMiddleware({ remote: owner, team, log: logger }));
  // Then what the viewer may reach: an editor gets only the routes of their clients (team/scope-guard.ts).
  app.use('*', scopeGuard({ scope: options.scope }));

  const api = new Hono<AppEnv>();
  api.get('/me', (c) => {
    const { email, name, role } = c.get('viewer');
    const body: MeResponse = { email, name, role };
    return c.json(body);
  });
  api.get('/health', (c) =>
    c.json({
      ok: true,
      version,
      settleMs: options.settleMs ?? SETTLE_MS,
      series: options.series?.series.enabled ?? false,
      jobSheet: options.jobSheet ?? false,
      analytics: options.analytics ?? false,
      phone: options.phone ?? false,
      graphics: options.graphics ?? false,
      graphicsInEdits: options.graphicsInEdits ?? false,
      music: options.music ?? false,
      luts: options.luts ?? false,
      lutsInEdits: options.lutsInEdits ?? false,
      fonts: options.fonts ?? false,
      fontsInNotes: options.fontsInNotes ?? false,
      quickFixes: options.quickFixes ?? false,
      // Songs builds on Soundtrack: never on while music is off.
      songs: (options.songs ?? false) && (options.music ?? false),
      generate: options.generate ?? false,
      draftChat: options.draftChat ?? false,
      instagram: options.instagram ?? false,
      dms: options.dmsRoutes !== undefined,
      ...(options.currencySymbol === undefined ? {} : { currencySymbol: options.currencySymbol }),
    }),
  );
  // Before the other job routes, so /jobs/:id/music is always this one's (Soundtrack).
  if (options.music && options.musicRoutes) {
    api.route('/jobs', createMusicRoutes(options.musicRoutes));
  } else {
    // Off: no music route at all, and every music path of a job says why.
    const off = (c: Context) => c.json({ error: MUSIC_MESSAGES.off }, 404);
    api.all('/jobs/:id/music', off);
    api.all('/jobs/:id/music/*', off);
  }
  // The quick fixes of a job (QF3), the same way.
  if (options.quickFixes && options.fixRoutes) {
    api.route('/jobs', createFixRoutes(options.fixRoutes));
  } else {
    const off = (c: Context) => c.json({ error: FIX_MESSAGES.off }, 404);
    api.all('/jobs/:id/fixes', off);
    api.all('/jobs/:id/fixes/*', off);
  }
  // The job's chat (Draft & chat, DR3). Off, every path of it says why.
  if (options.draftChat && options.feedRoutes) {
    api.route('/jobs', createFeedRoutes(options.feedRoutes));
  } else {
    const off = (c: Context) => c.json({ error: FEED_MESSAGES.off }, 404);
    api.all('/jobs/:id/feed', off);
    api.all('/jobs/:id/feed/*', off);
  }
  // The Generate stage of a job (Generated videos, GN0). Off, there is no such route at all.
  if (options.generate && options.generateRoutes) {
    api.route('/jobs', createGenerateRoutes(options.generateRoutes));
  }
  // The clips and voice lines Review hints at a note with (GN8), the same way.
  if (options.generate && options.generateReviewRoutes) {
    api.route('/jobs', createGenerateReviewRoutes(options.generateReviewRoutes));
  }
  // The note view and the pictures attached to a note (Songs, SG5). Off, there is no such route at
  // all: those paths answer the ordinary 404, as they did before Songs.
  if (options.songs && options.music && options.noteAttachments) {
    api.route('/jobs', createNoteAttachmentRoutes(options.noteAttachments));
  }
  // The file without the song, the second export (Songs, SG8), the same way.
  if (options.songs && options.music && options.noSongRoutes) {
    api.route('/jobs', createNoSongRoutes(options.noSongRoutes));
  }
  // The lists scope their own answer to the viewer (Team plan, TM2).
  const canSee = (options.scope ?? NO_SCOPE).canSee;
  if (options.jobs) {
    api.route(
      '/jobs',
      createJobsRoutes({ ...options.jobs, canSee, quickFixes: options.quickFixes === true }),
    );
  }
  if (options.clients) api.route('/clients', createClientsRoutes({ ...options.clients, canSee }));
  if (options.preview) api.route('/jobs', createPreviewRoutes(options.preview));
  if (options.versions) api.route('/jobs', createVersionRoutes(options.versions));
  if (options.notes) api.route('/jobs', createNotesRoutes(options.notes));
  if (options.jobStyle) api.route('/jobs', createJobStyleRoutes(options.jobStyle));
  if (options.jobSheetRoutes) api.route('/jobs', createJobSheetRoutes(options.jobSheetRoutes));
  if (options.delivery) {
    api.route('/jobs', createDeliveryRoutes(options.delivery));
    api.route('/payments', createPaymentRoutes(options.delivery));
    api.route('/deliveries', createDeliveryListRoutes({ ...options.delivery, canSee }));
  }
  if (options.money) api.route('/money', createMoneyRoutes(options.money));
  // Off: no route at all, so the engine answers /api/analytics like any path it does not have.
  if (options.analytics && options.analyticsRoutes) {
    api.route('/analytics', createAnalyticsRoutes(options.analyticsRoutes));
  }
  if (options.push) api.route('/push', createPushRoutes(options.push));
  // Under /team and /clients/:id/assignees, so mounted at the root of the API.
  if (options.teamRoutes) {
    api.route('/', createTeamRoutes({ ...options.teamRoutes, ownerLogins: () => owner().logins }));
  }
  if (options.settingsRoutes) api.route('/settings', createSettingsRoutes(options.settingsRoutes));
  if (options.dmsRoutes) api.route('/dms', createDmsRoutes(options.dmsRoutes));
  if (options.events) api.route('/events', createEventsRoutes(options.events));
  // Under /clients, /series and /jobs, so mounted at the root of the API.
  if (options.series) api.route('/', createSeriesRoutes(options.series));
  if (options.graphics && options.graphicsRoutes) {
    // The voice note and the files first: /voice and /assets/… are not graphic ids.
    api.route('/graphics', createGraphicVoiceRoutes(options.graphicsRoutes.voice));
    api.route('/graphics', createGraphicFilesRoutes(options.graphicsRoutes.files));
    api.route('/graphics', createGraphicsRoutes(options.graphicsRoutes.graphics));
  } else {
    // Off: no graphics route at all, and every path under /api/graphics says why.
    const off = (c: Context) => c.json({ error: GRAPHIC_MESSAGES.off }, 404);
    api.all('/graphics', off);
    api.all('/graphics/*', off);
  }
  if (options.luts && options.lutsRoutes) {
    api.route('/luts', createLutPreviewRoutes(options.lutsRoutes.previews));
    api.route('/luts', createLutsRoutes(options.lutsRoutes.luts));
  } else {
    // Off: no LUTs route at all, and every path under /api/luts says why.
    const off = (c: Context) => c.json({ error: LUT_MESSAGES.off }, 404);
    api.all('/luts', off);
    api.all('/luts/*', off);
  }
  // The look on the paused frame in Review: a job route, but part of the LUTs in notes (LU11).
  if (options.luts && options.lutsInEdits && options.reviewFrame) {
    api.route('/jobs', createReviewFrameRoutes(options.reviewFrame));
  } else {
    api.get('/jobs/:id/review/frame', (c) => c.json({ error: LUT_MESSAGES.off }, 404));
  }
  if (options.fonts && options.fontsRoutes) {
    // The test frames first: /frame/… is not a family slug.
    api.route('/fonts', createFontFrameRoutes());
    api.route('/fonts', createFontsRoutes(options.fontsRoutes));
  } else {
    // Off: no Fonts route at all, and every path under /api/fonts says why.
    const off = (c: Context) => c.json({ error: FONT_MESSAGES.off }, 404);
    api.all('/fonts', off);
    api.all('/fonts/*', off);
  }
  // A client's Instagram, its scan, the link of a reel to a job and the client's photo (Clients ×
  // Instagram, IG0). Off, no Instagram route at all, and every path of it says why.
  if (options.instagram && options.instagramRoutes) {
    api.route('/', createInstagramRoutes(options.instagramRoutes));
  } else {
    const off = (c: Context) => c.json({ error: INSTAGRAM_MESSAGES.off }, 404);
    api.all('/clients/:clientId/instagram', off);
    api.all('/clients/:clientId/instagram/*', off);
    api.all('/clients/:clientId/photo', off);
    api.all('/instagram/*', off);
  }
  app.route('/api', api);

  // Unknown routes answer JSON, so a mistyped /api path never gets an HTML page back.
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    logger.error({ err, method: c.req.method, path: c.req.path }, 'unhandled error in a request');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // The app is typed with its viewer here; callers and the web mount only need a Hono.
  const plain = app as unknown as Hono;
  if (options.webDist) mountWebApp(plain, options.webDist);

  return plain;
}
