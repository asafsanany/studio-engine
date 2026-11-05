// The Fonts caches (Fonts plan, "API"): the list (['fonts', 'list']: the families, the catalog of
// faces and the open requests) and each family's pane (['fonts', 'one', slug]). The server pushes
// every change over SSE (job-events.ts), and each event carries what changed, so the caches are
// patched in place:
//
//   font.changed   the family's summary goes into the list (A to Z) and over the cached pane. The
//                  event carries the summary only, which cannot show an added italic or a replaced
//                  file, so unless the event is only a use count that moved the catalog, the open
//                  requests (a font that arrives settles the ones that asked for it) and the pane
//                  (which holds the faces) are asked for again (`facesNeedReload`)
//   font.removed   out of the list with its faces, and the pane is reset (it asks again and gets
//                  the 404 of a family that is gone)
//   font.requested a note asked for a font the library lacks (FN16): the event carries only the
//                  name, so the list is asked for again (it has the job's name and every other
//                  open request, which the banner on top of the page shows)
//   font.request.dismissed  "Not a font" was pressed (C52): the request leaves the list at once and
//                  the list is asked for again (the job's other requests for that name went too)
//   hello          every Fonts query loads again (whatever happened while we were away)
//
// An action's answer (font-mutations.ts) goes in the same way: an import answers the families it
// added, a delete the slug that is gone. A cache that is not loaded is left alone (whoever loads
// it asks the server); one that is being fetched is asked again, since that fetch may predate the
// change.
//
// `isNew` is the server's word at the time it answered; the list does not hear when the 30 minutes
// end, so whoever shows the "New" tag works it out again from `addedAt` (`isNewFont`).

import {
  type FontChangedEvent,
  type FontFamilyDetail,
  type FontFamilySummary,
  type FontsListResponse,
  fontNameKey,
} from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { FONT_LIST_KEY, FONTS_KEY, fontKey } from './fonts-query';

/** The summary fields of a family's pane. */
export function fontSummaryOf(detail: FontFamilyDetail): FontFamilySummary {
  return {
    slug: detail.slug,
    name: detail.name,
    he: detail.he,
    style: detail.style,
    weights: detail.weights,
    weightsLabel: detail.weightsLabel,
    used: detail.used,
    usedLabel: detail.usedLabel,
    addedAt: detail.addedAt,
    isNew: detail.isNew,
  };
}

/** The order the server lists families in: A to Z, without regard to case. */
function byName(a: FontFamilySummary, b: FontFamilySummary): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
  );
}

/** The list with `summary` in it: a family that is there keeps its place, a new one goes A to Z. */
export function upsertFontSummary(
  list: FontsListResponse,
  summary: FontFamilySummary,
): FontsListResponse {
  const at = list.families.findIndex((family) => family.slug === summary.slug);
  const families =
    at >= 0
      ? list.families.map((family) => (family.slug === summary.slug ? summary : family))
      : [...list.families, summary].sort(byName);
  return { ...list, families };
}

/** The list without the family `slug`, and without its faces in the catalog. */
export function removeFontSummary(list: FontsListResponse, slug: string): FontsListResponse {
  const gone = list.families.find((family) => family.slug === slug);
  if (gone === undefined) return list;
  const key = fontNameKey(gone.name);
  return {
    ...list,
    families: list.families.filter((family) => family.slug !== slug),
    catalog: list.catalog.filter((face) => fontNameKey(face.family) !== key),
  };
}

/** Patches one cached query, or asks again while it is being fetched. */
function patch<T>(queryClient: QueryClient, key: readonly unknown[], change: (old: T) => T): void {
  if (queryClient.getQueryData<T>(key) !== undefined) {
    queryClient.setQueryData<T>(key, (old) => (old === undefined ? old : change(old)));
  }
  if (queryClient.isFetching({ queryKey: key, exact: true }) > 0) {
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
  }
}

/** A family's summary changed: into the list, and over its cached pane. */
export function applyFontSummary(queryClient: QueryClient, summary: FontFamilySummary): void {
  patch<FontsListResponse>(queryClient, FONT_LIST_KEY, (list) => upsertFontSummary(list, summary));
  patch<FontFamilyDetail>(queryClient, fontKey(summary.slug), (detail) => ({
    ...detail,
    ...summary,
    // The count of jobs is the one fact the pane shows twice; a hidden row stays hidden.
    usedIn: detail.usedIn === null ? null : summary.used,
  }));
}

function sameWeights(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((weight, index) => weight === b[index]);
}

/** Whether two summaries describe the same files, as far as a summary can: not the use count. */
function sameFiles(a: FontFamilySummary, b: FontFamilySummary): boolean {
  return (
    a.name === b.name &&
    a.he === b.he &&
    a.style === b.style &&
    a.addedAt === b.addedAt &&
    sameWeights(a.weights, b.weights)
  );
}

/**
 * Whether the cached faces (the catalog, a pane) and the open requests may miss something the
 * summary cannot carry. The server tells `font.changed` for two reasons: a family's files moved
 * (a font appeared in `_Fonts` through an import, the watcher or an upload, which also settles the
 * notes that asked for it), or a family gained a use (font-uses.ts: only `used` moves). The first
 * can add a face a summary never shows (an italic of a weight the family already has, a file
 * replaced), so everything but a use count that moved asks again; a family the list did not have
 * asks too. Nothing is asked for a cache nobody loaded.
 */
export function facesNeedReload(
  cachedList: FontsListResponse | undefined,
  summary: FontFamilySummary,
): boolean {
  if (cachedList === undefined) return false;
  const known = cachedList.families.find((family) => family.slug === summary.slug);
  if (known === undefined) return true;
  return !(known.used !== summary.used && sameFiles(known, summary));
}

/** `font.changed`: its summary, and the faces asked for again when the event shows they moved. */
export function applyFontChanged(queryClient: QueryClient, event: FontChangedEvent): void {
  const { family } = event;
  const reload = facesNeedReload(
    queryClient.getQueryData<FontsListResponse>(FONT_LIST_KEY),
    family,
  );
  applyFontSummary(queryClient, family);
  if (reload) {
    void queryClient.invalidateQueries({ queryKey: FONT_LIST_KEY, exact: true });
    void queryClient.invalidateQueries({ queryKey: fontKey(family.slug), exact: true });
  }
}

/**
 * `font.requested`: a note named a font the library does not have. Only its name comes with the
 * event, so the list (which holds the open requests, with their job names) is asked for again.
 */
export function applyFontRequested(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: FONT_LIST_KEY, exact: true });
}

/**
 * "Not a font" (C52), from the answer to the page's own press or the `font.request.dismissed`
 * event of another page: the request leaves the open requests at once. The server dismissed the
 * job's other requests for the same name with it, so the list is asked for again as well.
 */
export function applyFontRequestDismissed(queryClient: QueryClient, requestId: string): void {
  patch<FontsListResponse>(queryClient, FONT_LIST_KEY, (list) => ({
    ...list,
    requests: list.requests.filter((request) => request.id !== requestId),
  }));
  void queryClient.invalidateQueries({ queryKey: FONT_LIST_KEY, exact: true });
}

/**
 * An import added or changed these families: their summaries go in, and the catalog (their faces),
 * the open requests (an import can answer one) and the panes loaded for them are asked for again.
 */
export function applyFontsImported(
  queryClient: QueryClient,
  imported: readonly FontFamilySummary[],
): void {
  for (const summary of imported) applyFontSummary(queryClient, summary);
  void queryClient.invalidateQueries({ queryKey: FONT_LIST_KEY, exact: true });
  for (const { slug } of imported) {
    void queryClient.invalidateQueries({ queryKey: fontKey(slug), exact: true });
  }
}

/** `font.removed`, or a delete that went through: out of the list, and its pane is reset. */
export function removeFont(queryClient: QueryClient, slug: string): void {
  patch<FontsListResponse>(queryClient, FONT_LIST_KEY, (list) => removeFontSummary(list, slug));
  void queryClient.resetQueries({ queryKey: fontKey(slug), exact: true });
}

/** `hello`: every Fonts query loads again. */
export function reloadFonts(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: FONTS_KEY });
}
