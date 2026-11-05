import { setHomeCurrencySymbol } from '@studio/shared';
// The health query: what the page needs to know about the server besides the jobs. Today that is
// the settle delay (`STUDIO_SETTLE_MS`), which the instant Release uses to pick arriving or queued
// the way the server does (job-action.ts).
//
// A held job cannot tell the page this itself: only an `arriving` job carries `settlesAt`, and a
// held one has `settlesAt: null`. So the server says it in `/api/health`.

import { type HealthResponse, SETTLE_MS } from '@studio/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';

/** The TanStack Query key of the server's health answer. */
export const HEALTH_KEY = ['health'] as const;

/**
 * How long a health answer counts as fresh. The settle delay only changes when the engine restarts
 * with another `STUDIO_SETTLE_MS`, which a page that stays open does not hear about; asking again
 * when the window gets focus after this long picks the new value up.
 */
export const HEALTH_STALE_MS = 60_000;

/** A page that cannot get the answer (an engine too old to give it) tries a few times, then waits. */
const HEALTH_RETRIES = 2;

/** Options of the `['health']` query. */
export function healthQueryOptions(api: Api) {
  return queryOptions<HealthResponse, ApiError>({
    queryKey: HEALTH_KEY,
    queryFn: async ({ signal }) => {
      const health = await api.getHealth(signal);
      if (health.currencySymbol !== undefined) setHomeCurrencySymbol(health.currencySymbol);
      return health;
    },
    staleTime: HEALTH_STALE_MS,
    retry: HEALTH_RETRIES,
  });
}

/**
 * Whether the Job sheet is on, from the server's health answer: false until it is in (and for an
 * answer that cannot be read), so a page that has not heard yet behaves as before the sheet.
 */
export function jobSheetEnabled(health: HealthResponse | undefined): boolean {
  return health?.jobSheet ?? false;
}

/**
 * Whether Analytics is on, from the server's health answer: false until it is in (and for an
 * answer that cannot be read), so a page that has not heard yet behaves as before Analytics: the
 * sidebar item stays the disabled one.
 */
export function analyticsEnabled(health: HealthResponse | undefined): boolean {
  return health?.analytics ?? false;
}

/**
 * Whether the phone layout is switched on, from the server's health answer: false until it is in
 * (and for an answer that cannot be read), so a page that has not heard yet is today's app. The
 * phone layout itself also needs a narrow window: see `usePhoneLayout()`.
 */
export function phoneEnabled(health: HealthResponse | undefined): boolean {
  return health?.phone ?? false;
}

/**
 * Whether Graphics are on, from the server's health answer: false until it is in (and for an
 * answer that cannot be read), so a page that has not heard yet is today's app: no Graphics item
 * in the sidebar, and /graphics shows Not found.
 */
export function graphicsEnabled(health: HealthResponse | undefined): boolean {
  return health?.graphics ?? false;
}

/**
 * Whether LUTs are on, from the server's health answer: false until it is in (and for an answer
 * that cannot be read), so a page that has not heard yet is today's app: no LUTs item in the
 * sidebar, and /luts shows Not found.
 */
export function lutsEnabled(health: HealthResponse | undefined): boolean {
  return health?.luts ?? false;
}

/**
 * Whether notes can name a LUT (`@luts/name`), from the server's health answer: both LUTs switches
 * are on (the second acts only while the first is). False until the answer is in.
 */
export function lutsInEditsEnabled(health: HealthResponse | undefined): boolean {
  return (health?.luts ?? false) && (health?.lutsInEdits ?? false);
}

/**
 * Whether Fonts are on, from the server's health answer: false until it is in (and for an answer
 * that cannot be read), so a page that has not heard yet is today's app: no Fonts item in the
 * sidebar, and /fonts shows Not found.
 */
export function fontsEnabled(health: HealthResponse | undefined): boolean {
  return health?.fonts ?? false;
}

/**
 * Whether notes can name a font (`@Heebo Bold`), from the server's health answer: both Fonts
 * switches are on (the second acts only while the first is). False until the answer is in.
 */
export function fontsInNotesEnabled(health: HealthResponse | undefined): boolean {
  return (health?.fonts ?? false) && (health?.fontsInNotes ?? false);
}

/**
 * Whether Quick fixes are on, from the server's health answer: false until it is in (and for an
 * answer that cannot be read), so a page that has not heard yet is today's app: no Auto effort,
 * no sorting of notes and no fix in Review.
 */
export function quickFixesEnabled(health: HealthResponse | undefined): boolean {
  return health?.quickFixes ?? false;
}

/**
 * Whether Soundtrack is on, from the server's health answer: false until it is in (and for an
 * answer that cannot be read), so a page that has not heard yet is today's app: no Music button
 * in Review and no Music row in the job sheet.
 */
export function musicEnabled(health: HealthResponse | undefined): boolean {
  return health?.music ?? false;
}

/**
 * Whether Songs are on, from the server's health answer: Soundtrack and Songs both on (the engine
 * already combines them in `songs`; the check is for a stand-in that does not). False until the
 * answer is in, for an engine from before Songs, and for an answer that cannot be read, so a page
 * that has not heard yet is today's app: no song anywhere.
 */
export function songsEnabled(health: HealthResponse | undefined): boolean {
  return (health?.music ?? false) && (health?.songs ?? false);
}

/**
 * Whether Generated videos are on, from the server's health answer: false until it is in, for an
 * engine from before them, and for an answer that cannot be read, so a page that has not heard yet
 * is today's app: no Generate step, no Generated section.
 */
export function generateEnabled(health: HealthResponse | undefined): boolean {
  return health?.generate ?? false;
}

/**
 * Whether Draft & chat is on, from the server's health answer: false until it is in (and for an
 * answer that cannot be read), so a page that has not heard yet is today's app: Review has its
 * notes column and opens only in Review.
 */
export function draftChatEnabled(health: HealthResponse | undefined): boolean {
  return health?.draftChat ?? false;
}

/**
 * Whether Clients × Instagram is on, from the server's health answer: false until it is in, for an
 * engine from before it, and for an answer that cannot be read, so a page that has not heard yet is
 * today's app: no Instagram section, no Instagram menu items, no photo avatars.
 */
export function instagramEnabled(health: HealthResponse | undefined): boolean {
  return health?.instagram ?? false;
}

/**
 * Whether the engine has the Instagram DMs page, from its health answer: false until it is in and
 * for an engine from before it, so the sidebar has no DMs item then and /dms is Not found.
 */
export function dmsEnabled(health: HealthResponse | undefined): boolean {
  return health?.dms ?? false;
}

/**
 * The settle delay to use right now: the server's, once its health answer is in, and the default
 * 60 s (`SETTLE_MS`) until then (or if it never comes).
 */
export function cachedSettleMs(queryClient: QueryClient): number {
  return queryClient.getQueryData<HealthResponse>(HEALTH_KEY)?.settleMs ?? SETTLE_MS;
}
