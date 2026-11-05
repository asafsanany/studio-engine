import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GENERATE_BUDGET_USD,
  DEFAULT_GENERATE_USD_PER_CREDIT,
  DEFAULT_GENERATE_VOICE_ID,
  DEFAULT_INSTAGRAM_CLIENTS,
  INSTAGRAM_CLIENTS_CHOICES,
  type InstagramClients,
} from '@studio/shared';
import { z } from 'zod';
import { vapidSubjectOf } from './push/vapid-subject.js';
import { normaliseHostname } from './remote/tailscale-cli.js';

/**
 * Studio Engine settings, resolved once at boot.
 *
 * Merge order, later wins: built-in defaults < ~/.studio-engine/config.json < environment.
 * config.json is always read from <home>/.studio-engine/config.json, even when STUDIO_DATA_DIR
 * moves the data folder. Unknown keys in config.json are an error, so typos are not ignored.
 *
 * Environment variables (an empty value counts as unset):
 *   STUDIO_INBOX        inboxPath    folder watched for <Client>/<Job> (default ~/Studio Inbox)
 *   STUDIO_EXPORTS_DIR  exportsDir   finished MP4s (default <inbox>/_Exports)
 *   STUDIO_DATA_DIR     dataDir      app state (default ~/.studio-engine)
 *   STUDIO_DB_PATH      dbPath       SQLite file (default <data>/engine.db)
 *   STUDIO_LOGS_DIR     logsDir      log files (default <data>/logs)
 *   STUDIO_PORT         port         HTTP port (default 4310)
 *   STUDIO_HOST         host         loopback only: 127.0.0.1, localhost or ::1 (default 127.0.0.1)
 *   STUDIO_SETTLE_MS    settleMs     settle delay in ms (default 60000)
 *   STUDIO_CLAUDE_BIN   claudeBin    claude executable (default claude)
 *   STUDIO_MODEL        model        model for headless runs (default: the CLI's own default)
 *   STUDIO_RUNNER       runner       who edits: claude (headless Claude Code) or fake (default claude)
 *   STUDIO_RUN_TIMEOUT_MIN  runTimeoutMin  minutes one edit may run before it fails as timed out
 *                                         (default 90)
 *   STUDIO_MANUAL_START manualStart  a job the inbox finds waits (Held) until you start it (default
 *                                    on; 0 or false queues it by itself once its folder is quiet)
 *   STUDIO_KNOWN_CLIENTS_ONLY knownClientsOnly  only clients you added (New client) are detected; other
 *                                    folders at the top of the inbox are ignored (default on)
 *   STUDIO_REVIEW       review       Review: an edit ends as a live preview in Review (default on;
 *                                    0 or false turns it off)
 *   STUDIO_SERIES       series       Series: episodes of one show rebuilt from one format (default
 *                                    on; 0 or false turns it off)
 *   STUDIO_JOB_SHEET    jobSheet     Job sheet: a click on a job row opens a panel with everything
 *                                    about the job (default on; 0 or false turns it off)
 *   STUDIO_ANALYTICS    analytics    Analytics: a page of numbers about the work and the Claude use
 *                                    (default on; 0 or false turns it off)
 *   STUDIO_PHONE        phone        Phone layout: at phone width (under 768 px) the web app shows
 *                                    its phone layout (default on; 0 or false turns it off)
 *   STUDIO_GRAPHICS     graphics     Graphics: a library of graphics made in a chat, each by a Claude
 *                                    run (default on; 0 or false turns it off)
 *   STUDIO_GRAPHICS_IN_EDITS  graphicsInEdits  Every edit can use the Graphics library, while
 *                                    Graphics is on (default on; 0 or false turns it off)
 *   STUDIO_MUSIC        music        Soundtrack: music made for a video by ElevenLabs when the job
 *                                    asks for it (and only then), picked in Review (default on; 0
 *                                    or false turns it off)
 *   STUDIO_LUTS         luts         LUTs: a page to see, preview and import colour LUTs (default
 *                                    on; 0 or false turns it off)
 *   STUDIO_LUTS_IN_EDITS  lutsInEdits  A note can name a LUT (@luts/name) and the edit's colour
 *                                    grade uses it, while LUTs is on (default on; 0 or false
 *                                    turns it off)
 *   STUDIO_FONTS        fonts        Fonts: a page to see every font family, set in English and
 *                                    Hebrew in every weight, and to import more (default on; 0 or
 *                                    false turns it off)
 *   STUDIO_FONTS_IN_NOTES  fontsInNotes  A note can name a font by its full name (@Heebo Bold)
 *                                    and the edit uses it, while Fonts is on (default on; 0 or
 *                                    false turns it off)
 *   STUDIO_QUICK_FIXES  quickFixes   Quick fixes: with Auto effort in Review, a small pass sorts each
 *                                    note and the ones that only change the composition (a font,
 *                                    a caption's words, a colour) are fixed in Review at once
 *                                    (default on; 0 or false turns it off)
 *   STUDIO_SONGS        songs        Songs: the song Yael asks for (a screenshot, a link, a name, or
 *                                    "a trending song") gets into the edit, and Approve gives two
 *                                    MP4s (default on; 0 or false turns it off). It works only
 *                                    while music is on too: with music off, songs stays off (and
 *                                    the boot log says so when songs was asked for by name)
 *   STUDIO_GENERATE     generate     Generated videos: a job with no footage gets its voice, keyframes
 *                                    and clips made (ElevenLabs and Higgsfield) before the edit
 *                                    (default on; 0 or false turns it off)
 *   STUDIO_GENERATE_BUDGET_USD  generateBudgetUsd  dollars one generated video may spend on
 *                                    Higgsfield, the first pass and every review round (default 5;
 *                                    above 0, a number such as 5 or 4.5). The pictures and clips are
 *                                    made on the Higgsfield plan's credits through the connector (U26),
 *                                    and the dollars are those credits at the rate below
 *   STUDIO_GENERATE_USD_PER_CREDIT  generateUsdPerCredit  what one Higgsfield plan credit is worth in
 *                                    dollars (default 0.056, the 1,000 credit pack; above 0): the
 *                                    scripts book credits at it, so spend, budget and the Money page
 *                                    stay in dollars
 *   STUDIO_GENERATE_VOICE_ID  generateVoiceId  the ElevenLabs voice a generated video's voiceover
 *                                    is made with (default Kal Jones, 68RUZBDjLe2YBQvv8zFx; an ElevenLabs
 *                                    voice id: letters and digits)
 *   STUDIO_STOCK        stock        Stock media: an edit can fetch a sound effect (Openverse) or a photo
 *                                    (Unsplash) when the footage has none (default off; 1 or true
 *                                    turns it on)
 *   STUDIO_DRAFT_CHAT   draftChat    Draft & chat: an edit is one video-use run, the Draft, that reads the
 *                                    instructions itself, and Review is a chat with everything the
 *                                    run says, runs and looks at (default off; 1 or true turns it on)
 *   STUDIO_CLAUDE_PLAN_ONLY  claudePlanOnly  Claude runs bill to the claude.ai plan login only (default
 *                                    on; 0 or false lets them bill the API key in .env instead)
 *   STUDIO_TWO_JOBS_AT_ONCE  twoJobsAtOnce  the queue edits two jobs at the same time (default on;
 *                                    0 or false edits one after another)
 *   STUDIO_INSTAGRAM    instagram    Clients × Instagram: the weekly Instagram scan of each client's public
 *                                    page, the client page's Instagram section and the clients' Instagram
 *                                    photos (default on; 0 or false turns it off). The scan reads through
 *                                    Apify with `APIFY_TOKEN`, like Songs
 *   STUDIO_INSTAGRAM_CLIENTS  instagramClients  which clients the weekly Instagram scan reads: `active`
 *                                    (default; a job added or delivered in the last 60 days, or an
 *                                    account added in the last 60) or `all`
 *   STUDIO_ENV_FILE     (not in config.json)  the repo's git-ignored .env file, where the keys
 *                                    live (default <repo>/.env). Only the PATH is ever given to a
 *                                    Claude run, never a key's value
 *   STUDIO_YT_DLP       songTools.ytDlp  the yt-dlp executable Songs uses for YouTube (default
 *                                    /opt/homebrew/bin/yt-dlp: launchd has no Homebrew PATH)
 *   STUDIO_DENO         songTools.deno   the deno executable yt-dlp runs its JavaScript with
 *                                    (default /opt/homebrew/bin/deno)
 *
 * Not a setting: Generated videos read `HIGGSFIELD_API_KEY` (`id:secret`) from the repo's .env
 * (see `HIGGSFIELD_API_KEY_ENV` and `envFilePath`); the music script's ElevenLabs key stays in
 * ~/Developer/video-use/.env. Neither is in the config, in a log or in `/api/health`.
 *
 * Not a setting: Stock media reads `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET` (sound
 * effects) and `UNSPLASH_ACCESS_KEY` (photos) from the repo's .env, the same way (see
 * `OPENVERSE_CLIENT_ID_ENV`, `OPENVERSE_CLIENT_SECRET_ENV` and `UNSPLASH_ACCESS_KEY_ENV`).
 *
 * Not a setting: Songs reads Instagram and TikTok links through Apify with the key `APIFY_TOKEN`
 * (see `APIFY_TOKEN_ENV`) from the repo's git-ignored .env or the environment, when a reel needs it.
 *
 * Only in config.json (the phone over Tailscale Serve, Mobile plan §4):
 *   remoteHosts   names the engine answers besides loopback (default: the Mac's Tailscale name)
 *   remoteLogins  Tailscale logins let in through them (default: the Mac's owner)
 *   pushSubject   who the push services can write to about this engine, an email address or an
 *                 https URL (default: the Mac's owner)
 *
 * Only in config.json (your own numbers and accounts; config.example.json lists them):
 *   currencySymbol       the symbol money is shown with (default $; STUDIO_CURRENCY_SYMBOL)
 *   usdToHomeCurrency    what a dollar is worth in it, unless money.json says (default 1;
 *                        STUDIO_USD_TO_HOME)
 *   instagramDmFrom      the Instagram usernames whose DMs the DMs page keeps (default none)
 *   apiCreditsMonthlyUsd the month's API credits on Analytics (default 200)
 *   planMonthlyUsd       the Claude plan's price a month on Analytics (default 200)
 *
 * exportsDir, dbPath and logsDir follow an overridden inbox or data dir unless set explicitly.
 * Paths may start with ~/ and must be absolute once expanded.
 */

/** The runners the queue worker can drive: the real `claude -p` one (E3) and the fake one (E7). */
export const RUNNERS = ['claude', 'fake'] as const;
export type RunnerKind = (typeof RUNNERS)[number];

export interface Config {
  /** The symbol money is shown with. Unset (tests): the shared default stays. */
  currencySymbol?: string | undefined;
  /** What a dollar is worth in the home currency, for a money.json that does not say. */
  usdToHomeCurrency?: number | undefined;
  /** The Instagram usernames whose DMs are kept. */
  instagramDmFrom?: readonly string[] | undefined;
  /** The month's API credits, in dollars. Unset: the shared default. */
  apiCreditsMonthlyUsd?: number | undefined;
  /** The Claude plan's price a month, in dollars. Unset: the shared default. */
  planMonthlyUsd?: number | undefined;
  inboxPath: string;
  exportsDir: string;
  dataDir: string;
  dbPath: string;
  logsDir: string;
  port: number;
  host: string;
  settleMs: number;
  claudeBin: string;
  model: string | undefined;
  runner: RunnerKind;
  /** Minutes one headless edit may run before the runner stops it and fails it as timed out. */
  runTimeoutMin: number;
  /**
   * The Review switch (Phase 3). On (the default): an edit run ends as a live composition in
   * edit/preview/ and the job waits in Review. Off (`STUDIO_REVIEW=0`, or `"review": false` in
   * config.json): edit runs render edit/final.mp4 and go straight to Ready, as before Phase 3.
   */
  review: boolean;
  /**
   * Manual start. On (the default): a job the inbox finds is Held until it is started. Off
   * (`STUDIO_MANUAL_START=0`, or `"manualStart": false` in config.json): it queues by itself once
   * its folder has been quiet for `settleMs`.
   */
  manualStart: boolean;
  /**
   * Known clients only. On (the default): a folder at the top of the inbox is a client only when
   * it is on <dataDir>/clients.json (New client adds to it); any other is ignored. Off
   * (`STUDIO_KNOWN_CLIENTS_ONLY=0`, or `"knownClientsOnly": false`): every folder is a client.
   */
  knownClientsOnly: boolean;
  /**
   * The Series switch (Series plan §7). On (the default): series work once their parts are in.
   * Off (`STUDIO_SERIES=0`, or `"series": false` in config.json): nothing of series shows or
   * happens, no job joins one, and every series route answers 404 "Series are off.".
   * `/api/health` says which.
   */
  series: boolean;
  /**
   * The Job sheet switch (Job sheet plan §3). On (the default): a click on a job row opens its
   * sheet; `/api/health` says which. Off (`STUDIO_JOB_SHEET=0`, or `"jobSheet": false` in
   * config.json): rows open nothing and `?job=` is ignored, exactly the app before the sheet.
   */
  jobSheet: boolean;
  /**
   * The Analytics switch (Analytics plan). On (the default): the Analytics page and its numbers,
   * the limits log, and the small background pass that gives each review note a topic (one short
   * Claude run after a Send and once at boot, for the notes that have none yet). Off
   * (`STUDIO_ANALYTICS=0`, or `"analytics": false` in config.json): the sidebar item stays the
   * disabled "coming in a later phase" one, `/analytics` shows Not found, `/api/analytics` does not
   * exist and no topic pass runs; `/api/health` says which.
   */
  analytics: boolean;
  /**
   * The Phone switch (Mobile plan §3). On (the default since Mobile 1 shipped): the web app shows
   * its phone layout below 768 px; the Mac layout never changes. Off (`STUDIO_PHONE=0`, or
   * `"phone": false` in config.json): the app is exactly the Mac's at every width, a narrow window
   * included. `/api/health` says which.
   */
  phone: boolean;
  /**
   * The Graphics switch (Graphics plan). On (the default): the Graphics page, its runs and
   * `<inbox>/_Graphics`. Off (`STUDIO_GRAPHICS=0`, or `"graphics": false` in config.json): no
   * Graphics page, no nav item, every `/api/graphics` route answers 404 "Graphics are off.", no
   * graphic run and no `_Graphics` folder is made. `/api/health` says which.
   */
  graphics: boolean;
  /**
   * The switch that lets edits use the Graphics library (Graphics plan, build 2). On (the default
   * since GR11): every edit gets the library, and a graphic's Details say "Used in". Off
   * (`STUDIO_GRAPHICS_IN_EDITS=0`, or `"graphicsInEdits": false` in config.json): the Brief step
   * copies no graphic and brief.md has no Graphics library section, and Details hide "Used in".
   * It acts only while `graphics` is on too. `/api/health` says which.
   */
  graphicsInEdits: boolean;
  /**
   * The Soundtrack switch (Soundtrack plan). On (the default since U22): music is made by
   * ElevenLabs only when the job asks for it (a note, the client's text, a rule in the style or the
   * series, or Make music in Review; U21), written from the brief and fitted to the cut, and Review
   * lets you make another version and pick the one that goes in; a job nobody asked music for says
   * "No music asked for" and nothing is made. Off (`STUDIO_MUSIC=0`, or `"music": false` in
   * config.json): prompts are exactly as before (the music partials render empty), there is no
   * Music button or Music row, and every `/api/jobs/:id/music` route answers 404 "Music is off.".
   * `/api/health` says which.
   */
  music: boolean;
  /**
   * The LUTs switch (LUTs plan, build 1). On (the default): the LUTs page, where the owner sees every
   * LUT, previews it on a test frame and imports their own .cube files, and `<inbox>/_LUTs`. Off
   * (`STUDIO_LUTS=0`, or `"luts": false` in config.json): no LUTs page, no nav item, every
   * `/api/luts` route answers 404 "LUTs are off." and no `_LUTs` folder is made. `/api/health`
   * says which.
   */
  luts: boolean;
  /**
   * The switch that lets notes use LUTs (LUTs plan, build 2). On (the default since LU14): a note
   * can name a LUT (`@luts/name`) and the edit's colour grade uses it; the @ picker, the chips and
   * the pane's "Used in" show. Off (`STUDIO_LUTS_IN_EDITS=0`, or `"lutsInEdits": false` in
   * config.json): no @ picker for LUTs, runs ignore `@luts/` tokens and the pane hides "Used in".
   * It acts only while `luts` is on too. `/api/health` says which.
   */
  lutsInEdits: boolean;
  /**
   * The Fonts switch (Fonts plan, build 1). On (the default): the Fonts page, where the owner sees every
   * font family in their `_Fonts` folder set in English and Hebrew in every weight, and imports more.
   * Off (`STUDIO_FONTS=0`, or `"fonts": false` in config.json): no Fonts page, no nav item and
   * every `/api/fonts` route answers 404 "Fonts are off.". Copying `_Fonts` into each job is not
   * behind it. `/api/health` says which.
   */
  fonts: boolean;
  /**
   * The switch that lets notes use fonts (Fonts plan, build 2). On (the default): a note can name a
   * font by its full name (`@Heebo Bold`) and the edit uses it, Review shows it first, and the
   * Fonts page counts which jobs used each family. Off (`STUDIO_FONTS_IN_NOTES=0`, or
   * `"fontsInNotes": false` in config.json): no font group in the @ picker, runs ignore font
   * tokens, no live preview and no "Used in". It acts only while `fonts` is on too. `/api/health`
   * says which.
   */
  fontsInNotes: boolean;
  /**
   * The Quick fixes switch (Quick fixes plan, QF0). On (the default since QF9): with Auto, the
   * effort for review rounds, a small Haiku pass sorts each note the moment it is added with the
   * difficulty index, and a note that only changes the layer on top of the cut is fixed in Review
   * by a Sonnet run, while the bigger ones wait for Send and run at the tier they need. Off
   * (`STUDIO_QUICK_FIXES=0`, or `"quickFixes": false` in config.json): Review is exactly as it
   * was before, with no Auto effort, no sorting of notes and no fix; every fix route answers 404
   * "Quick fixes are off.". `/api/health` says which.
   */
  quickFixes: boolean;
  /**
   * The Claude billing switch (the owner, 26 Oct 2026). On (the default, and what every release since
   * v0.44.4 did): every `claude` process the engine starts runs on the claude.ai plan login, and an
   * `ANTHROPIC_API_KEY` in `.env` or the environment is ignored and dropped from the engine's own
   * environment. Off (`STUDIO_CLAUDE_PLAN_ONLY=0`, or `"claudePlanOnly": false` in config.json):
   * the key is kept and given to those runs, which then bill the Anthropic API; with no key they
   * still use the plan login. The plan probe always uses the plan, whatever this says. Changed in
   * Settings, it counts after the engine restarts.
   */
  claudePlanOnly: boolean;
  /**
   * The Songs switch (Songs plan, SG0), already resolved: what was asked for (on by default since
   * U22; `STUDIO_SONGS=0`, or `"songs": false` in config.json, turns it off) and `music`. It is
   * `false` whenever `music` is, even if songs was asked for (`loadConfig` says so in its `log`).
   * On, a song asked for (a screenshot, a link, a name, or a trending song) gets into the edit and
   * Approve gives two files; nothing is fetched unless the job asks (U21). Off: nothing of Songs
   * happens, prompts, routes, files and screens are exactly as before; the music script's `song`
   * command is never called. `/api/health` says which.
   */
  songs: boolean;
  /**
   * The programs Songs runs for YouTube: yt-dlp, and deno (what yt-dlp needs to run YouTube's
   * JavaScript). Absolute paths, because the launchd agent has no Homebrew in its PATH. Each can be
   * set with `STUDIO_YT_DLP` / `STUDIO_DENO`. Nothing runs them while `songs` is off.
   */
  songTools: SongTools;
  /**
   * The Generate switch (Generated videos, GN0). On (the default since the PINEWOOD acceptance, GN11): a job whose brief says
   * `production: generate` runs the Generate stage between the Brief and the edit. Off
   * (`STUDIO_GENERATE=0`, or `"generate": false` in config.json): nothing of Generated videos shows or
   * happens, prompts, routes and screens are exactly as before, no job gets a Generate stage and
   * `GET /api/jobs/:id/generate` does not exist. `/api/health` says which.
   */
  generate: boolean;
  /**
   * What one generated video may spend on Higgsfield, in dollars: the first pass and every review
   * round, all in (default 5, above 0). A note such as "budget $5" raises it for one job. Set with
   * `STUDIO_GENERATE_BUDGET_USD` or `"generateBudgetUsd"` in config.json.
   */
  generateBudgetUsd: number;
  /**
   * What one Higgsfield plan credit is worth in dollars (default 0.056, above 0). The Generate run
   * makes pictures and clips on the plan's credits (U26) and the scripts book them at this rate, so
   * spend.json, the budget and the Money page stay in dollars. Set with
   * `STUDIO_GENERATE_USD_PER_CREDIT` or `"generateUsdPerCredit"` in config.json.
   */
  generateUsdPerCredit: number;
  /**
   * The ElevenLabs voice a generated video's voiceover is made with (default Kal Jones, from
   * ElevenLabs' voice library). Set with `STUDIO_GENERATE_VOICE_ID` or `"generateVoiceId"` in
   * config.json; the voice script reads the environment variable, so the engine hands it over.
   */
  generateVoiceId: string;
  /**
   * The Stock switch (Stock media, ST0). Off (the default until it is proven in a real edit):
   * prompts are exactly as before (the stock part renders empty) and no job gets an `edit/stock/`
   * folder. On (`STUDIO_STOCK=1`, or `"stock": true` in config.json): the edit run can fetch a
   * sound effect from Openverse and a photo from Unsplash with the stock script, and every item it
   * uses is recorded with its creator and license. `/api/health` does not mention it.
   */
  stock: boolean;
  /**
   * The Draft & chat switch (Draft & chat plan, DR1). Off (the default until the owner turns it on): an
   * edit has its Brief run and its prompt exactly as before, Review has its notes column, and
   * `/api/jobs/:id/feed` does not exist. On (`STUDIO_DRAFT_CHAT=1`, or `"draftChat": true` in
   * config.json): an edit run is the Draft (`/video-use` with the note, the engine's rules in
   * edit/studio/notes.md), a job with footage has no separate Brief run, and Review is the job's
   * chat, built from the job log. `/api/health` says which.
   */
  draftChat: boolean;
  /**
   * The Two jobs at once switch (the owner, 29 Oct 2026). On (the default): the queue worker edits the
   * first two jobs in line side by side, each its own run with its own Cancel. Off
   * (`STUDIO_TWO_JOBS_AT_ONCE=0`, or `"twoJobsAtOnce": false` in config.json): one job at a time, as
   * before. Changed in Settings, it counts after the engine restarts.
   */
  twoJobsAtOnce: boolean;
  /**
   * The Clients × Instagram switch (IG0). On (the default since the acceptance run, IG15): each
   * client with an Instagram account is scanned every Monday and its page shows how our videos do
   * next to its own reels. Off (`STUDIO_INSTAGRAM=0`, or `"instagram": false` in config.json): no
   * scan runs, the Instagram section, menu items and photo avatars do not show, and every Instagram
   * route answers 404. `/api/health` says which; changed in Settings, it counts after the engine
   * restarts.
   */
  instagram: boolean;
  /**
   * Which clients the weekly Instagram scan reads (IG4, "Which clients" in Settings › Instagram).
   * `active` (the default; `STUDIO_INSTAGRAM_CLIENTS=active`, or `"instagramClients": "active"` in
   * config.json): the clients with a job added or delivered in the last 60 days, and a client whose
   * account was added in the last 60 days, so a new account still scans. `all`: every client with an
   * account. Changed in Settings, it counts after the engine restarts.
   */
  instagramClients: InstagramClients;
  /**
   * The names, besides loopback, the engine answers (Mobile plan §4): the phone opens it at
   * https://<mac>.<tailnet>.ts.net through Tailscale Serve. Unset (the default): the Mac's own
   * Tailscale name, read from `tailscale status` at boot and every 5 minutes. Set (`"remoteHosts"`
   * in config.json): these names instead, and `[]` lets nobody in from outside this Mac.
   */
  remoteHosts?: string[];
  /**
   * The Tailscale logins let in through those names (the `Tailscale-User-Login` Serve adds). Unset
   * (the default): the Mac's owner, read from `tailscale status`. Set (`"remoteLogins"` in
   * config.json): these logins instead.
   */
  remoteLogins?: string[];
  /**
   * The VAPID subject of web push (Mobile plan §6): an email address (`mailto:` is added) or an
   * https URL. Unset (the default): the Mac's owner login, as for `remoteLogins`.
   */
  pushSubject?: string;
}

/** Default for `runTimeoutMin`. The E1 sample (a 15 s clip) took 8 min; long jobs take more. */
export const DEFAULT_RUN_TIMEOUT_MIN = 90;

/** The programs Songs runs (`Config.songTools`). */
export interface SongTools {
  ytDlp: string;
  deno: string;
}

/** Where Homebrew puts yt-dlp and deno: the launchd agent has no Homebrew PATH, so never a bare name. */
export const DEFAULT_SONG_TOOLS: SongTools = {
  ytDlp: '/opt/homebrew/bin/yt-dlp',
  deno: '/opt/homebrew/bin/deno',
};

/**
 * The name of the Apify key Songs reads from the repo's .env (or the environment) for Instagram
 * and TikTok links and trending picks. Only the name lives here: the value is never logged, never
 * put in a URL and never given to a `claude` process (it goes in an Authorization header).
 */
export const APIFY_TOKEN_ENV = 'APIFY_TOKEN';

/**
 * The name of the Higgsfield key (`id:secret`) the shots script reads from the repo's .env (or the
 * environment). Only the name lives here: the value is never logged, never put in a URL and never
 * given to a `claude` process (it goes in an Authorization header).
 */
export const HIGGSFIELD_API_KEY_ENV = 'HIGGSFIELD_API_KEY';

/**
 * The names of the Stock media keys the stock script reads from the repo's .env (or the
 * environment): Openverse's OAuth client id and secret (sound effects) and Unsplash's access key
 * (photos). Only the names live here: the values are never logged, never put in a URL and never
 * given to a `claude` process (they go in an Authorization header).
 */
export const OPENVERSE_CLIENT_ID_ENV = 'OPENVERSE_CLIENT_ID';
export const OPENVERSE_CLIENT_SECRET_ENV = 'OPENVERSE_CLIENT_SECRET';
export const UNSPLASH_ACCESS_KEY_ENV = 'UNSPLASH_ACCESS_KEY';

/** The variable that moves the .env file (tests and a scratch engine); its value is a path. */
export const ENV_FILE_ENV = 'STUDIO_ENV_FILE';

/**
 * The absolute path of the repo's git-ignored .env file: `STUDIO_ENV_FILE` when it is set (an
 * absolute path, or `~/…`), else the .env at the root of the repo, found from this file so it is
 * the same whichever folder the server was started in. The engine gives a Claude run (and the
 * scripts it starts) only this PATH, never a key's value; the file may not exist.
 */
export function envFilePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const given = env[ENV_FILE_ENV];
  if (given !== undefined && given.trim() !== '') {
    const path = expandHome(given.trim(), home);
    if (isAbsolute(path)) return path;
  }
  // src/ and dist/ sit at the same depth, so this points at the repo root from either.
  return fileURLToPath(new URL('../../../.env', import.meta.url));
}

export interface LoadConfigOptions {
  /** Home directory. Defaults to os.homedir(). Tests pass a temp dir. */
  home?: string;
  /** Environment. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Told about a setting that was not used as asked (songs without music). Default: silent. */
  log?: (message: string) => void;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(['Invalid configuration:', ...issues.map((issue) => `  - ${issue}`)].join('\n'));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Expands a leading `~` or `~/` to the home directory. Other strings are returned unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

// Built per load so that `~` expands against the home directory that was passed in.
function buildSchemas(home: string) {
  const nonEmpty = z.string().min(1, 'must not be empty');
  const absolutePath = nonEmpty
    .transform((path) => expandHome(path, home))
    .refine((path) => isAbsolute(path), 'must be an absolute path, or start with ~/');
  const claudeBin = nonEmpty.transform((path) => expandHome(path, home));
  const port = z.number().int().min(1).max(65535);
  const settleMs = z.number().int().min(0);
  const host = z.enum(LOOPBACK_HOSTS, {
    error: 'must be a loopback address: 127.0.0.1, localhost or ::1',
  });
  const runner = z.enum(RUNNERS, { error: 'must be claude or fake' });
  // Whole minutes, at least 1, at most a week: a typo like 9000000 should not disable the guard.
  const runTimeoutMin = z.number().int().min(1).max(10_080);
  const review = z.boolean();
  const manualStart = z.boolean();
  const knownClientsOnly = z.boolean();
  const series = z.boolean();
  const jobSheet = z.boolean();
  const analytics = z.boolean();
  const phone = z.boolean();
  const graphics = z.boolean();
  const graphicsInEdits = z.boolean();
  const music = z.boolean();
  const stock = z.boolean();
  const luts = z.boolean();
  const lutsInEdits = z.boolean();
  const fonts = z.boolean();
  const fontsInNotes = z.boolean();
  const quickFixes = z.boolean();
  const claudePlanOnly = z.boolean();
  const songs = z.boolean();
  const generate = z.boolean();
  const draftChat = z.boolean();
  const twoJobsAtOnce = z.boolean();
  const instagram = z.boolean();
  const instagramClients = z.enum(INSTAGRAM_CLIENTS_CHOICES, {
    error: 'must be active or all',
  });
  const generateBudgetUsd = z.number().positive('must be above 0');
  const currencySymbol = z.string().trim().min(1, 'must not be empty').max(4, 'is too long');
  const usdToHomeCurrency = z.number().positive('must be above 0');
  const instagramDmFrom = z.array(
    z
      .string()
      .trim()
      .regex(/^@?[A-Za-z0-9._]+$/, 'must be Instagram usernames'),
  );
  const monthlyUsd = z.number().nonnegative('must not be below 0');
  const generateUsdPerCredit = z.number().positive('must be above 0');
  const generateVoiceId = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{8,64}$/, 'must be an ElevenLabs voice id (letters and digits)');
  // As a browser sends it in the Host header: no scheme, port or path.
  const remoteHosts = z.array(
    nonEmpty
      .regex(/^[a-z0-9.-]+$/i, 'must be host names such as mac.tailnet.ts.net')
      .transform(normaliseHostname),
  );
  const remoteLogins = z.array(
    nonEmpty
      .regex(/^\S+$/, 'must be Tailscale logins such as you@example.com')
      .transform((login) => login.toLowerCase()),
  );
  // An email address or an https URL; stored the way the VAPID token wants it.
  const pushSubject = nonEmpty.transform((value, ctx) => {
    const subject = vapidSubjectOf(value);
    if (subject === null) {
      ctx.issues.push({
        code: 'custom',
        message: 'must be an email address such as you@example.com, or an https address',
        input: value,
      });
      return z.NEVER;
    }
    return subject;
  });

  // Env values arrive as strings, so digits are parsed to numbers before the range check.
  const wholeNumber = z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform((digits) => Number(digits));

  // Dollars: digits with an optional decimal part, such as 3 or 4.5. Not 1e3, not "-1".
  const dollars = z
    .string()
    .regex(/^\d+(?:\.\d+)?$/, 'must be a number of dollars such as 3 or 4.5')
    .transform((digits) => Number(digits));

  // 1/0 or true/false, any case. Anything else is an error, so a typo can't quietly leave it on.
  const onOff = z
    .string()
    .regex(/^(?:1|0|true|false)$/i, 'must be 1, 0, true or false')
    .transform((value) => value === '1' || value.toLowerCase() === 'true');

  const fileLayer = z.strictObject({
    inboxPath: absolutePath.optional(),
    exportsDir: absolutePath.optional(),
    dataDir: absolutePath.optional(),
    dbPath: absolutePath.optional(),
    logsDir: absolutePath.optional(),
    port: port.optional(),
    host: host.optional(),
    settleMs: settleMs.optional(),
    claudeBin: claudeBin.optional(),
    model: nonEmpty.optional(),
    runner: runner.optional(),
    runTimeoutMin: runTimeoutMin.optional(),
    review: review.optional(),
    manualStart: manualStart.optional(),
    knownClientsOnly: knownClientsOnly.optional(),
    series: series.optional(),
    jobSheet: jobSheet.optional(),
    analytics: analytics.optional(),
    phone: phone.optional(),
    graphics: graphics.optional(),
    graphicsInEdits: graphicsInEdits.optional(),
    music: music.optional(),
    stock: stock.optional(),
    luts: luts.optional(),
    lutsInEdits: lutsInEdits.optional(),
    fonts: fonts.optional(),
    fontsInNotes: fontsInNotes.optional(),
    quickFixes: quickFixes.optional(),
    claudePlanOnly: claudePlanOnly.optional(),
    songs: songs.optional(),
    generate: generate.optional(),
    generateBudgetUsd: generateBudgetUsd.optional(),
    generateUsdPerCredit: generateUsdPerCredit.optional(),
    generateVoiceId: generateVoiceId.optional(),
    draftChat: draftChat.optional(),
    twoJobsAtOnce: twoJobsAtOnce.optional(),
    instagram: instagram.optional(),
    instagramClients: instagramClients.optional(),
    remoteHosts: remoteHosts.optional(),
    remoteLogins: remoteLogins.optional(),
    pushSubject: pushSubject.optional(),
    currencySymbol: currencySymbol.optional(),
    usdToHomeCurrency: usdToHomeCurrency.optional(),
    instagramDmFrom: instagramDmFrom.optional(),
    apiCreditsMonthlyUsd: monthlyUsd.optional(),
    planMonthlyUsd: monthlyUsd.optional(),
  });

  const envLayer = z
    .object({
      STUDIO_INBOX: absolutePath.optional(),
      STUDIO_EXPORTS_DIR: absolutePath.optional(),
      STUDIO_DATA_DIR: absolutePath.optional(),
      STUDIO_DB_PATH: absolutePath.optional(),
      STUDIO_LOGS_DIR: absolutePath.optional(),
      STUDIO_PORT: wholeNumber.pipe(port).optional(),
      STUDIO_HOST: host.optional(),
      STUDIO_SETTLE_MS: wholeNumber.pipe(settleMs).optional(),
      STUDIO_CLAUDE_BIN: claudeBin.optional(),
      STUDIO_MODEL: nonEmpty.optional(),
      STUDIO_RUNNER: runner.optional(),
      STUDIO_RUN_TIMEOUT_MIN: wholeNumber.pipe(runTimeoutMin).optional(),
      STUDIO_REVIEW: onOff.optional(),
      STUDIO_MANUAL_START: onOff.optional(),
      STUDIO_KNOWN_CLIENTS_ONLY: onOff.optional(),
      STUDIO_SERIES: onOff.optional(),
      STUDIO_JOB_SHEET: onOff.optional(),
      STUDIO_ANALYTICS: onOff.optional(),
      STUDIO_PHONE: onOff.optional(),
      STUDIO_GRAPHICS: onOff.optional(),
      STUDIO_GRAPHICS_IN_EDITS: onOff.optional(),
      STUDIO_MUSIC: onOff.optional(),
      STUDIO_STOCK: onOff.optional(),
      STUDIO_LUTS: onOff.optional(),
      STUDIO_LUTS_IN_EDITS: onOff.optional(),
      STUDIO_FONTS: onOff.optional(),
      STUDIO_FONTS_IN_NOTES: onOff.optional(),
      STUDIO_QUICK_FIXES: onOff.optional(),
      STUDIO_CLAUDE_PLAN_ONLY: onOff.optional(),
      STUDIO_SONGS: onOff.optional(),
      STUDIO_GENERATE: onOff.optional(),
      STUDIO_GENERATE_BUDGET_USD: dollars.pipe(generateBudgetUsd).optional(),
      STUDIO_GENERATE_USD_PER_CREDIT: dollars.pipe(generateUsdPerCredit).optional(),
      STUDIO_GENERATE_VOICE_ID: generateVoiceId.optional(),
      STUDIO_CURRENCY_SYMBOL: currencySymbol.optional(),
      STUDIO_USD_TO_HOME: dollars.pipe(usdToHomeCurrency).optional(),
      STUDIO_DRAFT_CHAT: onOff.optional(),
      STUDIO_TWO_JOBS_AT_ONCE: onOff.optional(),
      STUDIO_INSTAGRAM: onOff.optional(),
      STUDIO_INSTAGRAM_CLIENTS: instagramClients.optional(),
      STUDIO_YT_DLP: absolutePath.optional(),
      STUDIO_DENO: absolutePath.optional(),
    })
    .transform(
      (env): Partial<Config> => ({
        inboxPath: env.STUDIO_INBOX,
        exportsDir: env.STUDIO_EXPORTS_DIR,
        dataDir: env.STUDIO_DATA_DIR,
        dbPath: env.STUDIO_DB_PATH,
        logsDir: env.STUDIO_LOGS_DIR,
        port: env.STUDIO_PORT,
        host: env.STUDIO_HOST,
        settleMs: env.STUDIO_SETTLE_MS,
        claudeBin: env.STUDIO_CLAUDE_BIN,
        model: env.STUDIO_MODEL,
        runner: env.STUDIO_RUNNER,
        runTimeoutMin: env.STUDIO_RUN_TIMEOUT_MIN,
        review: env.STUDIO_REVIEW,
        manualStart: env.STUDIO_MANUAL_START,
        knownClientsOnly: env.STUDIO_KNOWN_CLIENTS_ONLY,
        series: env.STUDIO_SERIES,
        jobSheet: env.STUDIO_JOB_SHEET,
        analytics: env.STUDIO_ANALYTICS,
        phone: env.STUDIO_PHONE,
        graphics: env.STUDIO_GRAPHICS,
        graphicsInEdits: env.STUDIO_GRAPHICS_IN_EDITS,
        music: env.STUDIO_MUSIC,
        stock: env.STUDIO_STOCK,
        luts: env.STUDIO_LUTS,
        lutsInEdits: env.STUDIO_LUTS_IN_EDITS,
        fonts: env.STUDIO_FONTS,
        fontsInNotes: env.STUDIO_FONTS_IN_NOTES,
        quickFixes: env.STUDIO_QUICK_FIXES,
        claudePlanOnly: env.STUDIO_CLAUDE_PLAN_ONLY,
        songs: env.STUDIO_SONGS,
        generate: env.STUDIO_GENERATE,
        generateBudgetUsd: env.STUDIO_GENERATE_BUDGET_USD,
        generateUsdPerCredit: env.STUDIO_GENERATE_USD_PER_CREDIT,
        generateVoiceId: env.STUDIO_GENERATE_VOICE_ID,
        currencySymbol: env.STUDIO_CURRENCY_SYMBOL,
        usdToHomeCurrency: env.STUDIO_USD_TO_HOME,
        draftChat: env.STUDIO_DRAFT_CHAT,
        twoJobsAtOnce: env.STUDIO_TWO_JOBS_AT_ONCE,
        instagram: env.STUDIO_INSTAGRAM,
        instagramClients: env.STUDIO_INSTAGRAM_CLIENTS,
        songTools:
          env.STUDIO_YT_DLP === undefined && env.STUDIO_DENO === undefined
            ? undefined
            : {
                ytDlp: env.STUDIO_YT_DLP ?? DEFAULT_SONG_TOOLS.ytDlp,
                deno: env.STUDIO_DENO ?? DEFAULT_SONG_TOOLS.deno,
              },
      }),
    );

  return { fileLayer, envLayer };
}

type Schemas = ReturnType<typeof buildSchemas>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${prefix}${field}${issue.message}`;
  });
}

function readConfigFile(
  path: string,
  schema: Schemas['fileLayer'],
  issues: string[],
): Partial<Config> {
  if (!existsSync(path)) return {};

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    issues.push(`${path}: cannot be read as JSON (${errorMessage(err)})`);
    return {};
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    issues.push(...formatIssues(result.error, `${path}: `));
    return {};
  }
  return result.data;
}

function readEnv(
  env: Record<string, string | undefined>,
  schema: Schemas['envLayer'],
  issues: string[],
): Partial<Config> {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

  const result = schema.safeParse(set);
  if (!result.success) {
    issues.push(...formatIssues(result.error, ''));
    return {};
  }
  return result.data;
}

/**
 * Resolves the config from defaults, config.json and the environment.
 * Throws ConfigError listing every problem found, so the user can fix them in one pass.
 */
export function loadConfig({
  home = homedir(),
  env = process.env,
  log,
}: LoadConfigOptions = {}): Config {
  const schemas = buildSchemas(home);
  const configPath = join(home, '.studio-engine', 'config.json');
  const issues: string[] = [];

  const file = readConfigFile(configPath, schemas.fileLayer, issues);
  const fromEnv = readEnv(env, schemas.envLayer, issues);
  if (issues.length > 0) throw new ConfigError(issues);

  // Each field: environment, then config.json, then the default. The derived paths only fall
  // back to their default when nothing set them, so an overridden inbox or data dir moves them.
  const dataDir = fromEnv.dataDir ?? file.dataDir ?? join(home, '.studio-engine');
  const inboxPath = fromEnv.inboxPath ?? file.inboxPath ?? join(home, 'Studio Inbox');

  // Songs builds on Soundtrack's record, files and Music list, so it works only with music on.
  // Both are on by default (U22), so with music turned off, songs falling back to off is the
  // expected result and is not worth a log line; only a songs setting someone wrote is told about.
  const music = fromEnv.music ?? file.music ?? true;
  const songsSet = fromEnv.songs ?? file.songs;
  const songsAsked = songsSet ?? true;
  if (songsSet && !music) {
    log?.('songs is on but music is off: songs stays off. Turn on STUDIO_MUSIC (or "music") too.');
  }

  return {
    inboxPath,
    exportsDir: fromEnv.exportsDir ?? file.exportsDir ?? join(inboxPath, '_Exports'),
    dataDir,
    dbPath: fromEnv.dbPath ?? file.dbPath ?? join(dataDir, 'engine.db'),
    logsDir: fromEnv.logsDir ?? file.logsDir ?? join(dataDir, 'logs'),
    port: fromEnv.port ?? file.port ?? 4310,
    host: fromEnv.host ?? file.host ?? '127.0.0.1',
    settleMs: fromEnv.settleMs ?? file.settleMs ?? 60_000,
    claudeBin: fromEnv.claudeBin ?? file.claudeBin ?? 'claude',
    model: fromEnv.model ?? file.model,
    runner: fromEnv.runner ?? file.runner ?? 'claude',
    runTimeoutMin: fromEnv.runTimeoutMin ?? file.runTimeoutMin ?? DEFAULT_RUN_TIMEOUT_MIN,
    review: fromEnv.review ?? file.review ?? true,
    manualStart: fromEnv.manualStart ?? file.manualStart ?? true,
    knownClientsOnly: fromEnv.knownClientsOnly ?? file.knownClientsOnly ?? true,
    series: fromEnv.series ?? file.series ?? true,
    jobSheet: fromEnv.jobSheet ?? file.jobSheet ?? true,
    analytics: fromEnv.analytics ?? file.analytics ?? true,
    phone: fromEnv.phone ?? file.phone ?? true,
    graphics: fromEnv.graphics ?? file.graphics ?? true,
    graphicsInEdits: fromEnv.graphicsInEdits ?? file.graphicsInEdits ?? true,
    music,
    stock: fromEnv.stock ?? file.stock ?? false,
    luts: fromEnv.luts ?? file.luts ?? true,
    lutsInEdits: fromEnv.lutsInEdits ?? file.lutsInEdits ?? true,
    fonts: fromEnv.fonts ?? file.fonts ?? true,
    fontsInNotes: fromEnv.fontsInNotes ?? file.fontsInNotes ?? true,
    quickFixes: fromEnv.quickFixes ?? file.quickFixes ?? true,
    claudePlanOnly: fromEnv.claudePlanOnly ?? file.claudePlanOnly ?? true,
    songs: songsAsked && music,
    songTools: fromEnv.songTools ?? { ...DEFAULT_SONG_TOOLS },
    generate: fromEnv.generate ?? file.generate ?? true,
    generateBudgetUsd:
      fromEnv.generateBudgetUsd ?? file.generateBudgetUsd ?? DEFAULT_GENERATE_BUDGET_USD,
    generateUsdPerCredit:
      fromEnv.generateUsdPerCredit ?? file.generateUsdPerCredit ?? DEFAULT_GENERATE_USD_PER_CREDIT,
    generateVoiceId: fromEnv.generateVoiceId ?? file.generateVoiceId ?? DEFAULT_GENERATE_VOICE_ID,
    draftChat: fromEnv.draftChat ?? file.draftChat ?? false,
    twoJobsAtOnce: fromEnv.twoJobsAtOnce ?? file.twoJobsAtOnce ?? true,
    instagram: fromEnv.instagram ?? file.instagram ?? true,
    instagramClients:
      fromEnv.instagramClients ?? file.instagramClients ?? DEFAULT_INSTAGRAM_CLIENTS,
    currencySymbol: fromEnv.currencySymbol ?? file.currencySymbol ?? '$',
    usdToHomeCurrency: fromEnv.usdToHomeCurrency ?? file.usdToHomeCurrency ?? 1,
    instagramDmFrom: file.instagramDmFrom ?? [],
    apiCreditsMonthlyUsd: file.apiCreditsMonthlyUsd,
    planMonthlyUsd: file.planMonthlyUsd,
    remoteHosts: file.remoteHosts,
    remoteLogins: file.remoteLogins,
    pushSubject: file.pushSubject,
  };
}

/** Creates the inbox, exports, data and logs folders. Silent: there is no first-run screen. */
export function ensureDirs(
  config: Pick<Config, 'inboxPath' | 'exportsDir' | 'dataDir' | 'logsDir'>,
): void {
  for (const dir of [config.inboxPath, config.exportsDir, config.dataDir, config.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
