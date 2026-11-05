// The graphics caches (Graphics plan, "Live updates"): the list (['graphics', 'list']) and each
// graphic's page (['graphics', 'one', id]). The server pushes every change over SSE
// (job-events.ts), and each event carries what changed, so the caches are patched in place:
//
//   graphic.changed   the summary goes into the list (out of it when the graphic is empty) and
//                     over the cached page; the message, when there is one, goes into the page's
//                     chat by its id (a new one at the end). The event carries only those two, so
//                     when a new version, a finished or failed run or a new name shows, the page
//                     is asked for again: its text fields, "when edits use it" and folder changed
//                     with it (`detailNeedsReload`). An edit that used the graphic also carries
//                     how many videos have used it, which goes over the page's "Used in"
//   graphic.removed   out of the list, and the page is reset (it asks again and gets the 404 of
//                     a graphic that is gone)
//   hello             every graphics query loads again (whatever happened while we were away)
//
// An action's answer (graphic-mutations.ts) is the whole graphic: it replaces the page and its
// summary goes into the list. A cache that is not loaded is left alone (whoever loads it asks the
// server); one that is being fetched is asked again, since that fetch may predate the change.

import type {
  GraphicChangedEvent,
  GraphicDetail,
  GraphicMessage,
  GraphicSummary,
} from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { GRAPHIC_LIST_KEY, GRAPHICS_KEY, graphicKey } from './graphics-query';

/** The summary fields of a graphic's page. */
export function summaryOf(detail: GraphicDetail): GraphicSummary {
  return {
    id: detail.id,
    name: detail.name,
    kind: detail.kind,
    lengthSec: detail.lengthSec,
    version: detail.version,
    uses: detail.uses,
    status: detail.status,
    makingVersion: detail.makingVersion,
    failedVersion: detail.failedVersion,
    updatedAt: detail.updatedAt,
  };
}

/** Newest change first, as the server lists them; ties keep the order they had. */
function byNewest(list: GraphicSummary[]): GraphicSummary[] {
  return list
    .map((graphic, index) => ({ graphic, index }))
    .sort(
      (a, b) =>
        Date.parse(b.graphic.updatedAt) - Date.parse(a.graphic.updatedAt) || a.index - b.index,
    )
    .map(({ graphic }) => graphic);
}

/** The list with `summary` in it (by id), newest change first; without it when it is empty. */
export function upsertGraphicSummary(
  list: readonly GraphicSummary[],
  summary: GraphicSummary,
): GraphicSummary[] {
  const others = list.filter((graphic) => graphic.id !== summary.id);
  return summary.status === 'empty' ? others : byNewest([summary, ...others]);
}

/** The list without the graphic `id`. */
export function removeGraphicSummary(
  list: readonly GraphicSummary[],
  id: string,
): GraphicSummary[] {
  return list.filter((graphic) => graphic.id !== id);
}

/** The chat with `message` in it: in its place when it is there, at the end when it is new. */
export function upsertGraphicMessage(
  messages: readonly GraphicMessage[],
  message: GraphicMessage,
): GraphicMessage[] {
  const at = messages.findIndex((known) => known.id === message.id);
  if (at < 0) return [...messages, message];
  return messages.map((known, index) => (index === at ? message : known));
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

/** A graphic's summary changed: into the list, and over its cached page. */
export function applyGraphicSummary(queryClient: QueryClient, summary: GraphicSummary): void {
  patch<GraphicSummary[]>(queryClient, GRAPHIC_LIST_KEY, (list) =>
    upsertGraphicSummary(list, summary),
  );
  patch<GraphicDetail>(queryClient, graphicKey(summary.id), (detail) => ({
    ...detail,
    ...summary,
  }));
}

/** One message of a graphic's chat changed (or is new): into its cached page. */
export function applyGraphicMessage(
  queryClient: QueryClient,
  graphicId: string,
  message: GraphicMessage,
): void {
  patch<GraphicDetail>(queryClient, graphicKey(graphicId), (detail) => ({
    ...detail,
    messages: upsertGraphicMessage(detail.messages, message),
  }));
}

/**
 * Whether the cached page misses something the event cannot carry. A new version, a new name, or a
 * message that is now done or failed (and was not in the page): its variables, "when edits use it"
 * and folder moved with it. Nothing is asked for a page nobody loaded.
 */
export function detailNeedsReload(
  cached: GraphicDetail | undefined,
  event: GraphicChangedEvent,
): boolean {
  if (cached === undefined) return false;
  const { graphic, message } = event;
  if (graphic.version !== cached.version || graphic.name !== cached.name) return true;
  if (message === undefined || (message.status !== 'done' && message.status !== 'failed')) {
    return false;
  }
  return cached.messages.find((known) => known.id === message.id)?.status !== message.status;
}

/** How many videos have used the graphic, into its cached page ("Used in"). */
export function applyGraphicUsedIn(
  queryClient: QueryClient,
  graphicId: string,
  usedIn: number,
): void {
  patch<GraphicDetail>(queryClient, graphicKey(graphicId), (detail) => ({ ...detail, usedIn }));
}

/**
 * `graphic.changed`: its summary, its message when it carries one, and how many videos used it when
 * an edit just did. The page is asked for again when the event shows what it cannot carry
 * (`detailNeedsReload`).
 */
export function applyGraphicChanged(queryClient: QueryClient, event: GraphicChangedEvent): void {
  const { id } = event.graphic;
  const reload = detailNeedsReload(queryClient.getQueryData<GraphicDetail>(graphicKey(id)), event);
  applyGraphicSummary(queryClient, event.graphic);
  if (event.message !== undefined) applyGraphicMessage(queryClient, id, event.message);
  if (event.usedIn !== undefined) applyGraphicUsedIn(queryClient, id, event.usedIn);
  if (reload) void queryClient.invalidateQueries({ queryKey: graphicKey(id), exact: true });
}

/** An action answered the whole graphic: it is the page, and its summary goes into the list. */
export function applyGraphicDetail(queryClient: QueryClient, detail: GraphicDetail): void {
  queryClient.setQueryData<GraphicDetail>(graphicKey(detail.id), detail);
  patch<GraphicSummary[]>(queryClient, GRAPHIC_LIST_KEY, (list) =>
    upsertGraphicSummary(list, summaryOf(detail)),
  );
}

/** `graphic.removed`, or a delete that went through: out of the list, and its page is reset. */
export function removeGraphic(queryClient: QueryClient, id: string): void {
  patch<GraphicSummary[]>(queryClient, GRAPHIC_LIST_KEY, (list) => removeGraphicSummary(list, id));
  void queryClient.resetQueries({ queryKey: graphicKey(id), exact: true });
}

/** `hello`: every graphics query loads again. */
export function reloadGraphics(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: GRAPHICS_KEY });
}
