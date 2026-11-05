// The LUTs caches (LUTs plan, "Live updates"): the list (['luts', 'list']) and each LUT's pane
// (['luts', 'one', slug]). The server pushes every change over SSE (job-events.ts), and each event
// carries what changed, so the caches are patched in place:
//
//   lut.changed   the summary goes into the list (Yours newest first; a built-in row in its place)
//                 and over the cached pane. The event carries only the summary, so when the name
//                 changed the pane is asked for again: its file moved with it (`paneNeedsReload`)
//   lut.removed   out of Yours, and the pane is reset (it asks again and gets the 404 of a LUT that
//                 is gone). A rename changes the slug, so the server sends lut.removed for the old
//                 slug and lut.changed for the new one
//   hello         every LUTs query loads again (whatever happened while we were away)
//
// An action's answer (lut-mutations.ts) is the whole LUT, or the rows an import added: they go in
// the same way. A cache that is not loaded is left alone (whoever loads it asks the server); one
// that is being fetched is asked again, since that fetch may predate the change.
//
// `isNew` is the server's word at the time it answered; the list does not hear when the 30 minutes
// end, so whoever shows the "New" tag works it out again from `addedAt` (`isNewLut`).

import type { LutChangedEvent, LutDetail, LutListResponse, LutSummary } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { LUT_LIST_KEY, LUTS_KEY, lutKey } from './luts-query';

/** The summary fields of a LUT's pane. */
export function lutSummaryOf(detail: LutDetail): LutSummary {
  return {
    slug: detail.slug,
    name: detail.name,
    kind: detail.kind,
    size: detail.size,
    owner: detail.owner,
    used: detail.used,
    usedLabel: detail.usedLabel,
    addedAt: detail.addedAt,
    isNew: detail.isNew,
  };
}

/** Newest import first, as the server lists Yours; ties keep the order they had. */
function byNewest(list: LutSummary[]): LutSummary[] {
  return list
    .map((lut, index) => ({ lut, index }))
    .sort(
      (a, b) =>
        (Date.parse(b.lut.addedAt ?? '') || 0) - (Date.parse(a.lut.addedAt ?? '') || 0) ||
        a.index - b.index,
    )
    .map(({ lut }) => lut);
}

/** The list with `summary` in it: Yours by slug, newest first; a built-in row in its place only. */
export function upsertLutSummary(list: LutListResponse, summary: LutSummary): LutListResponse {
  if (summary.owner === 'builtIn') {
    return {
      ...list,
      builtIn: list.builtIn.map((lut) => (lut.slug === summary.slug ? summary : lut)),
    };
  }
  const others = list.yours.filter((lut) => lut.slug !== summary.slug);
  const at = list.yours.findIndex((lut) => lut.slug === summary.slug);
  // One that is there keeps its place; a new one goes where its import time puts it.
  if (at >= 0)
    return { ...list, yours: list.yours.map((lut) => (lut.slug === summary.slug ? summary : lut)) };
  return { ...list, yours: byNewest([summary, ...others]) };
}

/** The list without the LUT of Yours `slug`. */
export function removeLutSummary(list: LutListResponse, slug: string): LutListResponse {
  return { ...list, yours: list.yours.filter((lut) => lut.slug !== slug) };
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

/** A LUT's summary changed: into the list, and over its cached pane. */
export function applyLutSummary(queryClient: QueryClient, summary: LutSummary): void {
  patch<LutListResponse>(queryClient, LUT_LIST_KEY, (list) => upsertLutSummary(list, summary));
  patch<LutDetail>(queryClient, lutKey(summary.slug), (detail) => ({
    ...detail,
    ...summary,
    // The count of jobs is the one fact the pane shows twice; a hidden row stays hidden.
    usedIn: detail.usedIn === null ? null : summary.used,
  }));
}

/**
 * Whether the cached pane misses something the event cannot carry: a new name moved the file's
 * name with it. Nothing is asked for a pane nobody loaded.
 */
export function paneNeedsReload(cached: LutDetail | undefined, event: LutChangedEvent): boolean {
  return cached !== undefined && cached.name !== event.lut.name;
}

/** `lut.changed`: its summary, and the pane asked for again when the event shows what it cannot carry. */
export function applyLutChanged(queryClient: QueryClient, event: LutChangedEvent): void {
  const { slug } = event.lut;
  const reload = paneNeedsReload(queryClient.getQueryData<LutDetail>(lutKey(slug)), event);
  applyLutSummary(queryClient, event.lut);
  if (reload) void queryClient.invalidateQueries({ queryKey: lutKey(slug), exact: true });
}

/**
 * An action answered the whole LUT: it is the pane, and its summary goes into the list. `replacing`
 * is the slug it had before a rename: that one leaves the list and its pane is reset.
 */
export function applyLutDetail(
  queryClient: QueryClient,
  detail: LutDetail,
  replacing?: string,
): void {
  if (replacing !== undefined && replacing !== detail.slug) removeLut(queryClient, replacing);
  queryClient.setQueryData<LutDetail>(lutKey(detail.slug), detail);
  patch<LutListResponse>(queryClient, LUT_LIST_KEY, (list) =>
    upsertLutSummary(list, lutSummaryOf(detail)),
  );
}

/** An import added these rows to Yours. */
export function applyLutsImported(queryClient: QueryClient, imported: readonly LutSummary[]): void {
  for (const summary of imported) applyLutSummary(queryClient, summary);
}

/** `lut.removed`, or a delete that went through: out of Yours, and its pane is reset. */
export function removeLut(queryClient: QueryClient, slug: string): void {
  patch<LutListResponse>(queryClient, LUT_LIST_KEY, (list) => removeLutSummary(list, slug));
  void queryClient.resetQueries({ queryKey: lutKey(slug), exact: true });
}

/** `hello`: every LUTs query loads again. */
export function reloadLuts(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: LUTS_KEY });
}
