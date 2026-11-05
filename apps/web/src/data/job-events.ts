// Live sync: one EventSource on /api/events keeps the cached job list equal to the server's.
//
// The server speaks `data: <json>` frames of `ServerEvent` (`hello`, `job.upsert`, `job.remove`,
// `client.upsert`, `client.added`, `client.removed`, the review notes' `note.upsert` and
// `note.remove`, and `money.changed`) and an `event: ping` every 15 s. There are no event ids and
// no replay, so:
//   - every `hello` (the first one too) reloads the list from the server, and the notes, the
//     styles, the client list and the Money page's numbers of what is on screen; whatever happened
//     while we were not connected, or before the first fetch landed, is in those answers;
//   - upserts and removes are applied to the cache by job id, as they arrive. No polling;
//   - a note event is applied to that job's notes (['notes', jobId]) when they are cached; a
//     removed job drops its notes;
//   - a client.upsert loads that client's style again (['client-style', clientId]) when it is
//     cached: the event has no markdown, and the state and style.md must arrive together;
//   - the client list (['clients']) is loaded again when a job it has not counted arrives, a job
//     is removed, a client's style changes, or a client folder is added or removed. The events
//     do not carry the rows (a job count and a last job are the server's to work out);
//   - money.changed (a job was delivered, money.json was edited, review time was added) loads the
//     Money page's months again (['money']); the event carries nothing;
//   - the unpaid videos whose folder is gone (['orphan-deliveries']) are loaded again on
//     money.changed (every payment and every Not delivered yet sends it, and a video without a job
//     has no job.upsert to say so), when a delivered job is removed (its delivery is what is left),
//     and on every hello;
//   - a job's update (job.upsert) invalidates that job's step runs (['job-steps', jobId]), and a
//     hello invalidates all of them. Only a query somebody is watching (an open job sheet) is read
//     again; the others just go stale and are read when the sheet opens;
//   - the same goes for the review notes a job's rounds were sent with (['sent-notes', jobId]):
//     a job's update invalidates that job's, a hello invalidates all of them. A sent note never
//     changes, so a job's update (Send notes is one) is all that can add to the list;
//   - the Analytics page's numbers (['analytics']) are loaded again a moment after any job event
//     (job.upsert, job.remove), money.changed and every hello (analytics-query.ts waits and joins
//     them: a running edit sends an update every few seconds). A page nobody has open, or that was
//     never opened, does nothing;
//   - series.changed and series.removed load that series and its client's series list again, and a
//     job joining, leaving or moving between series loads its client's list too (series-cache.ts);
//   - graphic.changed patches the graphics list and that graphic's page (its summary, and the chat
//     message it carries), graphic.removed takes it out of both, and a hello loads every graphics
//     query again (graphics-cache.ts);
//   - lut.changed patches the LUTs list and that LUT's pane (its summary), lut.removed takes it out of
//     both, and a hello loads every LUTs query again (luts-cache.ts);
//   - font.changed patches the Fonts list and that family's pane (its summary), font.removed takes
//     it out of both, font.requested (a note asked for a font the library lacks) loads the list
//     again for the banner, font.request.dismissed ("Not a font", C52) takes that request out of it,
//     and a hello loads every Fonts query again (fonts-cache.ts);
//   - the same goes for the status of the file without the song (['no-song', jobId], Songs): the
//     engine republishes the job when that file starts and ends, so a job's update invalidates that
//     job's, a hello invalidates all of them and a removed job drops its own (no-song.ts);
//   - job.music (Soundtrack) writes the job's music it carries into ['music', jobId] as it is, a
//     removed job drops its music, and a hello invalidates every job's music (music-query.ts);
//   - job.generate (Generated videos) writes the Generate state it carries into ['job-generate',
//     jobId] and into the cached job as it is, a removed job drops its state, and a hello
//     invalidates every job's state (generate-query.ts);
//   - job.fix (Quick fixes) writes the fix it carries into ['job-fixes', jobId] as it is, a removed
//     job drops its fixes, a hello invalidates every job's fixes, and a job whose round or state
//     changes (Send and Approve end the round) has its fixes read again (job-fixes.ts).
//   - client-instagram (Clients × Instagram) loads that client's Instagram again, in every range
//     somebody has loaded, and a hello loads every client's again (instagram-cache.ts); the event
//     carries only the client's id. The client list and the job sheets' reel numbers load again
//     with it (followers, this week and the photo are the list's), and a job update that links or
//     unlinks a reel loads that job's reel again.
//
// Reconnecting is ours, not the browser's: on any error the source is closed and a new one is
// opened after an exponentially growing delay (1 s, 2 s, 4 s, then 4 s again for as long as the
// engine stays away). The delay starts over once a `hello` shows the connection works. The browser's
// own retry would use a fixed delay, and gives up for good on an HTTP error, so it is not relied on.
//
// The cap is low on purpose: the engine is on this machine, an attempt against a dead port costs
// next to nothing, and the cap is also the longest the "Reconnecting..." notice can outlast the
// engine's return (the first `hello` of a new connection is what clears it). A longer cap would
// keep the notice up for half a minute after the engine is back.
//
// A stream can also die without a word: iOS cuts a sleeping app's connections and the EventSource
// still says it is open, so no error ever comes (Mobile plan §4). The page coming back is when it
// shows: the page is shown again (visibilitychange), restored from the back-forward cache (pageshow
// with `persisted`) or back online (online). Then, if nothing (no frame, no ping) has arrived for
// 20 s (`STALE_STREAM_MS`), the stream is taken for dead and opened again at once; its `hello`
// reloads everything. A live stream pings every 15 s, so one that is fine is left alone.
//
// The client also reports whether the engine can be reached (`EngineLink`, below), so the page can
// say so when a list that is already on screen has stopped being live:
//   - a broken stream, or a failed fetch of the list, means "out of reach";
//   - any frame on the stream, or a fetch of the list that went through, means "back". A fetch that
//     went through also ends the wait for the next reconnect: the engine is evidently up, so the
//     stream is opened at once instead of after the rest of the delay.

import { type Job, type ReviewNote, type ServerEvent, serverEventSchema } from '@studio/shared';
import { isCancelledError, matchQuery, type QueryClient } from '@tanstack/react-query';
import { reloadAnalytics } from './analytics-query';
import { CLIENT_STYLES_KEY, reloadClientStyle } from './client-style';
import { changesClientRow, reloadClients } from './clients-query';
import {
  applyFontChanged,
  applyFontRequestDismissed,
  applyFontRequested,
  reloadFonts,
  removeFont,
} from './fonts-cache';
import { applyJobGenerateEvent, JOB_GENERATE_KEY, jobGenerateKey } from './generate-query';
import { applyGraphicChanged, reloadGraphics, removeGraphic } from './graphics-cache';
import { jobReelKey, reloadAllClientInstagram, reloadClientInstagram } from './instagram-cache';
import { isJobActionPending } from './job-action';
import { JOB_FEED_KEY, jobFeedKey } from './job-feed';
import { applyJobFixEvent, JOB_FIXES_KEY, jobFixesKey } from './job-fixes';
import { JOB_STEPS_KEY, jobStepsKey } from './job-steps';
import { JOB_STOCK_KEY, jobStockKey } from './job-stock';
import { JOB_VERSIONS_KEY, jobVersionsKey } from './job-versions';
import { findJob, JOBS_KEY, removeJob, upsertJob } from './jobs-cache';
import { reloadJobs } from './jobs-query';
import { applyLutChanged, reloadLuts, removeLut } from './luts-cache';
import { reloadMoney } from './money-query';
import { applyJobMusicEvent, MUSIC_KEY, musicKey } from './music-query';
import { NO_SONG_KEY, noSongKey } from './no-song';
import { isNoteDeletePending } from './note-mutations';
import { NOTES_KEY, notesKey, removeNote, upsertNote } from './notes-cache';
import { reloadOrphanDeliveries } from './orphan-deliveries';
import { SENT_NOTES_KEY, sentNotesKey } from './sent-notes';
import {
  changesSeriesCounts,
  dropSeries,
  reloadClientSeries,
  reloadSeries,
  SERIES_KEY,
} from './series-cache';

export const EVENTS_URL = '/api/events';

export const RECONNECT_INITIAL_MS = 1_000;
/** The longest wait between two attempts, so also about the longest the notice outlasts the outage. */
export const RECONNECT_MAX_MS = 4_000;

/** How long to wait before reconnect number `failures + 1` (`failures` = errors since the last hello). */
export function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** failures);
}

/**
 * How long a stream may stay silent before the page coming back opens it again. The server pings
 * every 15 s, so a live stream never stays silent this long.
 */
export const STALE_STREAM_MS = 20_000;

/** The part of the browser's `EventSource` the client uses; a test passes a fake. */
export interface EventSourceLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  /** For the server's `ping` events, which never reach `onmessage`. */
  addEventListener(type: 'ping', listener: () => void): void;
  close(): void;
}

/**
 * What tells the client the page may have been asleep: `visibilitychange` on the document, and
 * `pageshow` and `online` on the window. The browser's own by default; a test passes its own.
 */
export interface PageEvents {
  document: EventTarget & { readonly visibilityState: string };
  window: EventTarget;
}

function browserPageEvents(): PageEvents | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return { document, window };
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface ReconnectTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: ReconnectTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * How long the engine has to stay out of reach before the page says so. A dropped connection that
 * comes back inside this time (a blip, a quick `pnpm agent:restart`) never shows anything.
 */
export const RECONNECTING_DELAY_MS = 2_000;

/** Whether the page should say "Reconnecting to the engine...". Observable, for `useSyncExternalStore`. */
export interface EngineLink {
  /** The engine answered: clears the notice at once and cancels one that is still waiting. */
  markUp(): void;
  /** The engine is out of reach. The notice appears when it still is after {@link RECONNECTING_DELAY_MS}. */
  markDown(): void;
  /** True from the end of that delay until the engine answers again. */
  isReconnecting(): boolean;
  /**
   * When the first bad news of the present outage came (ms since the epoch, before the wait
   * above), or null while the engine is reachable. Whoever waits longer than that wait (the phone's
   * offline screen) counts from here.
   */
  downSince(): number | null;
  /** When the engine last answered (ms since the epoch), or null if it has not yet. */
  lastHeardAt(): number | null;
  subscribe(listener: () => void): () => void;
}

export interface EngineLinkOptions {
  /** Default {@link RECONNECTING_DELAY_MS}. */
  delayMs?: number;
  /** Default: the global timers. Tests pass their own. */
  timers?: ReconnectTimers;
  /** The clock for {@link EngineLink.downSince} and {@link EngineLink.lastHeardAt}. Default `Date.now`. */
  now?: () => number;
}

export function createEngineLink({
  delayMs = RECONNECTING_DELAY_MS,
  timers = globalTimers,
  now = Date.now,
}: EngineLinkOptions = {}): EngineLink {
  let reconnecting = false;
  let pending: unknown = null;
  let downSince: number | null = null;
  let lastHeardAt: number | null = null;
  const listeners = new Set<() => void>();

  function setReconnecting(next: boolean): void {
    if (next === reconnecting) return;
    reconnecting = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    markDown() {
      // Already waiting, or already showing: more bad news changes nothing, and must not restart the wait.
      if (pending !== null || reconnecting) return;
      downSince = now();
      pending = timers.setTimeout(() => {
        pending = null;
        setReconnecting(true);
      }, delayMs);
    },
    markUp() {
      if (pending !== null) timers.clearTimeout(pending);
      pending = null;
      downSince = null;
      lastHeardAt = now();
      setReconnecting(false);
    },
    isReconnecting: () => reconnecting,
    downSince: () => downSince,
    lastHeardAt: () => lastHeardAt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app's one link: the events client (mounted in App) feeds it, the header reads it. */
export const engineLink: EngineLink = createEngineLink();

export interface JobEventsClientOptions {
  queryClient: QueryClient;
  eventSourceFactory: EventSourceFactory;
  /** Default {@link EVENTS_URL}. */
  url?: string;
  /** Default: the global timers. Tests pass their own to see the delays. */
  timers?: ReconnectTimers;
  /** Told whether the engine can be reached. Default: nobody is told. */
  link?: EngineLink;
  /** A frame that is not a valid `ServerEvent` was ignored. */
  onUnreadableEvent?: (error: unknown) => void;
  /** Where the page says it came back. Default: the browser's document and window; none outside one. */
  page?: PageEvents | null;
  /** The clock for {@link STALE_STREAM_MS}. Default `Date.now`. */
  now?: () => number;
}

export interface JobEventsClient {
  /** Opens the connection. Does nothing when already started. */
  start(): void;
  /** Closes the connection and cancels a pending reconnect. The client can be started again. */
  stop(): void;
}

export function createJobEventsClient({
  queryClient,
  eventSourceFactory,
  url = EVENTS_URL,
  timers = globalTimers,
  link,
  onUnreadableEvent,
  page = browserPageEvents(),
  now = Date.now,
}: JobEventsClientOptions): JobEventsClient {
  let running = false;
  let source: EventSourceLike | null = null;
  let retryHandle: unknown = null;
  let unsubscribeCache: (() => void) | null = null;
  let unsubscribePage: (() => void) | null = null;
  /** Errors since the last hello. */
  let failures = 0;
  /** When the stream last said anything (a frame or a ping), or was opened. */
  let lastHeard = 0;

  /**
   * Applies a change of one job to the cached list, unless it cannot or should not be:
   *  - an action on this job is on its way: its answer (and the reload after it) is the truth, and
   *    a stale event must not flip the optimistic state back;
   *  - there is no list yet: whatever is loading may have read the server before this event, so it
   *    is loaded again;
   *  - the list is being fetched right now: that fetch may predate the event too; same remedy.
   */
  function apply(id: string, patch: (list: Job[]) => Job[]): void {
    if (isJobActionPending(queryClient, id)) return;
    if (queryClient.getQueryData<Job[]>(JOBS_KEY) === undefined) {
      void reloadJobs(queryClient);
      return;
    }
    queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && patch(list));
    if (queryClient.isFetching({ queryKey: JOBS_KEY }) > 0) void reloadJobs(queryClient);
  }

  /**
   * Applies a change to one job's cached notes. No list cached: nothing to change, whoever loads it
   * reads the server. A fetch of the notes in flight may predate the event, so it is made again.
   */
  function applyNotes(jobId: string, patch: (list: ReviewNote[]) => ReviewNote[]): void {
    const key = notesKey(jobId);
    if (queryClient.getQueryData<ReviewNote[]>(key) !== undefined) {
      queryClient.setQueryData<ReviewNote[]>(key, (list) => list && patch(list));
    }
    if (queryClient.isFetching({ queryKey: key }) > 0) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }

  function handleFrame(data: unknown): void {
    let event: ServerEvent;
    try {
      event = serverEventSchema.parse(JSON.parse(String(data)));
    } catch (error) {
      onUnreadableEvent?.(error);
      return;
    }
    switch (event.type) {
      case 'hello':
        failures = 0;
        void reloadJobs(queryClient);
        // Note events missed while disconnected.
        void queryClient.invalidateQueries({ queryKey: NOTES_KEY });
        // Style events missed while disconnected.
        void queryClient.invalidateQueries({ queryKey: CLIENT_STYLES_KEY });
        // Client folders, job counts and style states changed while disconnected.
        void reloadClients(queryClient);
        // Deliveries, money.json edits and review time while disconnected (the boot backfill of
        // deliveries does not publish money.changed either).
        void reloadMoney(queryClient);
        // Payments, Not delivered yet and removed jobs while disconnected.
        void reloadOrphanDeliveries(queryClient);
        // Series and their episode counts changed while disconnected.
        void queryClient.invalidateQueries({ queryKey: SERIES_KEY });
        // Step runs changed while disconnected (only an open job sheet reads them again).
        void queryClient.invalidateQueries({ queryKey: JOB_STEPS_KEY });
        // Cuts may have been made or restored while disconnected (only an open job sheet reads them again).
        void queryClient.invalidateQueries({ queryKey: JOB_VERSIONS_KEY });
        // Rounds of notes may have been sent while disconnected.
        void queryClient.invalidateQueries({ queryKey: SENT_NOTES_KEY });
        // Runs may have taken stock media while disconnected (only an open job sheet reads it again).
        void queryClient.invalidateQueries({ queryKey: JOB_STOCK_KEY });
        // Runs went on while disconnected: the open chats read their logs again (Draft & chat).
        void queryClient.invalidateQueries({ queryKey: JOB_FEED_KEY });
        // Anything in the Analytics numbers may have moved while disconnected.
        reloadAnalytics(queryClient);
        // Graphics made, changed or deleted while disconnected.
        void reloadGraphics(queryClient);
        // LUTs imported, changed or deleted while disconnected.
        void reloadLuts(queryClient);
        // Fonts imported, changed or deleted while disconnected.
        void reloadFonts(queryClient);
        // Music made or picked while disconnected (only what is on screen is read again).
        void queryClient.invalidateQueries({ queryKey: MUSIC_KEY });
        // Fixes made, undone or cancelled while disconnected (only what is on screen is read again).
        void queryClient.invalidateQueries({ queryKey: JOB_FIXES_KEY });
        // A second file (Songs) made or lost while disconnected (only an open sheet reads it again).
        void queryClient.invalidateQueries({ queryKey: NO_SONG_KEY });
        // Generate progress made while disconnected (only what is on screen is read again).
        void queryClient.invalidateQueries({ queryKey: JOB_GENERATE_KEY });
        // Scans and links made while disconnected (only what is on screen is read again).
        void reloadAllClientInstagram(queryClient);
        return;
      case 'job.upsert': {
        // Before the job is applied: the question is whether the list already held it.
        const known = findJob(queryClient.getQueryData<Job[]>(JOBS_KEY), event.job.id);
        if (changesClientRow(known, event.job)) void reloadClients(queryClient);
        if (changesSeriesCounts(known, event.job)) {
          void reloadClientSeries(queryClient, event.job.clientId);
        }
        apply(event.job.id, (list) => upsertJob(list, event.job));
        // A new round (Send, Approve) leaves the fixes of the one before behind, and a job that
        // comes back to Review has new ones to make.
        if (
          known === undefined ||
          known.round !== event.job.round ||
          known.state !== event.job.state
        ) {
          void queryClient.invalidateQueries({ queryKey: jobFixesKey(event.job.id) });
        }
        // The Money page lists every job, delivered or not (it costs money before it earns any): a
        // new job, one that moved on, or one that spent money on its shots is a new row or number.
        if (
          known === undefined ||
          known.state !== event.job.state ||
          known.generate?.spendUsd !== event.job.generate?.spendUsd
        ) {
          void reloadMoney(queryClient);
        }
        // The job moved on (a step started or ended, a run began): its step runs may have too.
        void queryClient.invalidateQueries({ queryKey: jobStepsKey(event.job.id) });
        // A run that ends in Review makes a version, and a restore changes the live one.
        void queryClient.invalidateQueries({ queryKey: jobVersionsKey(event.job.id) });
        // Send notes changes the job (its round): the notes it sent may have too.
        void queryClient.invalidateQueries({ queryKey: sentNotesKey(event.job.id) });
        // A run that took a sound effect or a photo changes the job (a step, a state): so may its credits.
        void queryClient.invalidateQueries({ queryKey: jobStockKey(event.job.id) });
        // A reel linked to the job or taken off it (its delivery gains or loses `uploadedAt`): the
        // sheet's "On Instagram" line reads the reel again. A progress tick changes neither.
        if (
          known?.delivery?.uploadedAt !== event.job.delivery?.uploadedAt ||
          known?.delivery?.reelUrl !== event.job.delivery?.reelUrl
        ) {
          void queryClient.invalidateQueries({ queryKey: jobReelKey(event.job.id) });
        }
        // A run started or ended, or a round was sent: the job's chat has new lines (Draft & chat).
        void queryClient.invalidateQueries({ queryKey: jobFeedKey(event.job.id) });
        // The engine republishes the job when the file without the song starts and ends (Songs).
        void queryClient.invalidateQueries({ queryKey: noSongKey(event.job.id) });
        // Finishing, approving and every step change the Analytics numbers.
        reloadAnalytics(queryClient);
        return;
      }
      case 'job.remove': {
        const removed = findJob(queryClient.getQueryData<Job[]>(JOBS_KEY), event.id);
        apply(event.id, (list) => removeJob(list, event.id));
        queryClient.removeQueries({ queryKey: notesKey(event.id) });
        queryClient.removeQueries({ queryKey: musicKey(event.id) });
        queryClient.removeQueries({ queryKey: noSongKey(event.id) });
        queryClient.removeQueries({ queryKey: jobFixesKey(event.id) });
        queryClient.removeQueries({ queryKey: jobGenerateKey(event.id) });
        void reloadClients(queryClient);
        // A job that goes leaves the Money page's list (a delivered one stays, as an orphan).
        void reloadMoney(queryClient);
        // A delivered job whose folder is gone leaves its delivery behind: a video to pay for.
        if (removed === undefined || removed.delivery !== null) {
          void reloadOrphanDeliveries(queryClient);
        }
        // An episode that is gone no longer counts.
        if (removed !== undefined && removed.seriesId !== null) {
          void reloadClientSeries(queryClient, removed.clientId);
        }
        reloadAnalytics(queryClient);
        return;
      }
      case 'note.upsert':
        // A delete on its way: the note must not come back before the server has answered.
        if (isNoteDeletePending(queryClient, event.note.id)) return;
        applyNotes(event.note.jobId, (list) => upsertNote(list, event.note));
        return;
      case 'note.remove':
        applyNotes(event.jobId, (list) => removeNote(list, event.noteId));
        return;
      case 'client.upsert':
        void reloadClientStyle(queryClient, event.style.clientId);
        // The client's row carries its style state and when it changed.
        void reloadClients(queryClient);
        return;
      case 'client.added':
      case 'client.removed':
        // A client folder appeared or went (made in the app or in Finder): the list is the truth.
        void reloadClients(queryClient);
        return;
      case 'money.changed':
        // No payload: every month on screen is asked for again.
        void reloadMoney(queryClient);
        // And the videos without a folder: a payment or a take-back of one has no job.upsert.
        void reloadOrphanDeliveries(queryClient);
        // Deliveries and review time are in the Analytics numbers.
        reloadAnalytics(queryClient);
        return;
      case 'series.changed':
        // The event has no markdown: the series is asked for again, with its client's list.
        reloadSeries(queryClient, event.series);
        return;
      case 'series.removed':
        dropSeries(queryClient, event.seriesId, event.clientId);
        return;
      case 'graphic.changed':
        // The event carries the summary and the message that changed: both go in as they are.
        applyGraphicChanged(queryClient, event);
        return;
      case 'graphic.removed':
        removeGraphic(queryClient, event.id);
        return;
      case 'lut.changed':
        // The event carries the summary: it goes in as it is.
        applyLutChanged(queryClient, event);
        return;
      case 'lut.removed':
        removeLut(queryClient, event.slug);
        return;
      case 'font.changed':
        // The event carries the summary: it goes in as it is.
        applyFontChanged(queryClient, event);
        return;
      case 'font.removed':
        removeFont(queryClient, event.slug);
        return;
      case 'font.requested':
        // Only the name comes: the list has the job's name and the other open requests.
        applyFontRequested(queryClient);
        return;
      case 'font.request.dismissed':
        // "Not a font" was pressed on this page or another: the request goes, the list is re-asked.
        applyFontRequestDismissed(queryClient, event.id);
        return;
      case 'job.music':
        // The event carries the whole answer: it goes in as it is.
        applyJobMusicEvent(queryClient, event);
        return;
      case 'job.fix':
        // The event carries the whole fix: it goes in as it is.
        applyJobFixEvent(queryClient, event);
        return;
      case 'job.generate':
        // The event carries the whole state: it goes in as it is, into the job too.
        applyJobGenerateEvent(queryClient, event);
        return;
      case 'client-instagram':
        // Only whose changed: the numbers are the range's to work out, so the page asks again.
        void reloadClientInstagram(queryClient, event.clientId);
        return;
      case 'access.changed':
        // Who may see what changed; nothing on screen depends on it yet.
        return;
    }
  }

  function connect(): void {
    retryHandle = null;
    const current = eventSourceFactory(url);
    source = current;
    lastHeard = now();
    // A callback of a source we already let go of must not act.
    current.onmessage = (event) => {
      if (source !== current) return;
      lastHeard = now();
      link?.markUp(); // whatever it says, the engine is there
      handleFrame(event.data);
    };
    current.addEventListener('ping', () => {
      if (source !== current) return;
      lastHeard = now();
      link?.markUp();
    });
    current.onerror = () => {
      if (source !== current) return;
      current.close();
      source = null;
      retryHandle = timers.setTimeout(connect, reconnectDelay(failures));
      failures += 1;
      link?.markDown();
    };
  }

  /** Lets go of the open source, if any, so none of its callbacks act again. */
  function closeSource(): void {
    if (source === null) return;
    source.onmessage = null;
    source.onerror = null;
    source.close();
    source = null;
  }

  /**
   * The page came back. A stream that has said nothing for {@link STALE_STREAM_MS} is dead (or a
   * reconnect is waiting that long), so it is opened again now; anything fresher is left alone.
   */
  function onPageBack(): void {
    if (!running || now() - lastHeard < STALE_STREAM_MS) return;
    closeSource();
    if (retryHandle !== null) timers.clearTimeout(retryHandle);
    connect();
  }

  function watchPage(events: PageEvents): () => void {
    const { document: doc, window: win } = events;
    const onVisibility = (): void => {
      if (doc.visibilityState === 'visible') onPageBack();
    };
    // Only a page restored from the back-forward cache: a fresh load opens its own stream.
    const onPageShow = (event: Event): void => {
      if ((event as PageTransitionEvent).persisted) onPageBack();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pageshow', onPageShow);
    win.addEventListener('online', onPageBack);
    return () => {
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pageshow', onPageShow);
      win.removeEventListener('online', onPageBack);
    };
  }

  /** Ends the wait for the next reconnect and connects now. Does nothing when none is waiting. */
  function connectNow(): void {
    if (retryHandle === null) return;
    timers.clearTimeout(retryHandle);
    connect();
  }

  /**
   * Watches the fetches of the list. A failed attempt (`failed`: the query retries for ever, so
   * each attempt is reported; `error`: one that gave up) means the engine is out of reach; a fetch
   * that went through means it is back. Two things are not about the engine and are skipped: a
   * fetch we cancelled ourselves (a reload replacing it), and `setQueryData` (an optimistic update,
   * an SSE upsert), which the cache also reports as a success, marked `manual`.
   */
  function watchFetches(): () => void {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || !matchQuery({ queryKey: JOBS_KEY }, event.query)) return;
      const { action } = event;
      if (
        action.type === 'failed' ||
        (action.type === 'error' && !isCancelledError(action.error))
      ) {
        link?.markDown();
      } else if (action.type === 'success' && !action.manual) {
        link?.markUp();
        connectNow();
      }
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      unsubscribeCache = watchFetches();
      unsubscribePage = page === null ? null : watchPage(page);
      connect();
    },
    stop() {
      running = false;
      unsubscribeCache?.();
      unsubscribeCache = null;
      unsubscribePage?.();
      unsubscribePage = null;
      link?.markUp(); // not watching any more: nothing to report
      if (retryHandle !== null) timers.clearTimeout(retryHandle);
      retryHandle = null;
      closeSource();
    },
  };
}
