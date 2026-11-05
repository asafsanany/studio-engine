// The graphics queries (Graphics plan, "Web"): whether Graphics are on, the list, and one graphic
// with its chat. While the Graphics switch is off (`/api/health` says `graphics: false`, and until
// its answer is in) nothing is asked: every graphics route would only answer 404 "Graphics are
// off.". The caches and their events are graphics-cache.ts; the actions graphic-mutations.ts.
//
//   ['graphics']               every graphics query (hello invalidates them all)
//   ['graphics', 'list']       the list (GET /api/graphics), newest change first
//   ['graphics', 'one', id]    one graphic and its chat (GET /api/graphics/:id)
//
// Both are fresh forever: `graphic.changed` and `graphic.removed` patch them as they come.

import type { GraphicDetail, GraphicSummary } from '@studio/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { type GraphicsApi, graphicsApi } from './graphics-api';
import { graphicsEnabled, healthQueryOptions } from './health-query';

/** Every graphics query starts with this. */
export const GRAPHICS_KEY = ['graphics'] as const;

/** The list: ['graphics', 'list']. */
export const GRAPHIC_LIST_KEY = ['graphics', 'list'] as const;

/** One graphic and its chat: ['graphics', 'one', id]. */
export function graphicKey(id: string): readonly ['graphics', 'one', string] {
  return ['graphics', 'one', id] as const;
}

/** A 4xx (an unknown or deleted graphic, Graphics off) will not change by asking again. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Options of the list query. `enabled` is whether Graphics are on. */
export function graphicsQueryOptions(client: GraphicsApi, enabled = true) {
  return queryOptions<GraphicSummary[], ApiError>({
    queryKey: GRAPHIC_LIST_KEY,
    queryFn: ({ signal }) => client.listGraphics(signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/** Options of one graphic's query; one that is gone answers 404 and is not asked again. */
export function graphicQueryOptions(client: GraphicsApi, id: string, enabled = true) {
  return queryOptions<GraphicDetail, ApiError>({
    queryKey: graphicKey(id),
    queryFn: ({ signal }) => client.getGraphic(id, signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * Whether Graphics are on (`/api/health`): false until the answer is in, so nothing of Graphics
 * shows on a page that has not heard yet: no sidebar item, and /graphics is Not found.
 */
export function useGraphicsEnabled(): boolean {
  return graphicsEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * The graphics that are not empty, newest change first. `data` is `undefined` until the first
 * answer, and stays so while Graphics are off (nothing is asked).
 */
export function useGraphics() {
  const enabled = useGraphicsEnabled();
  return useQuery(graphicsQueryOptions(graphicsApi, enabled));
}

/**
 * One graphic and its chat. `data` is `undefined` until the first answer, and stays so while
 * Graphics are off. Kept current by the graphic events.
 */
export function useGraphic(id: string) {
  const enabled = useGraphicsEnabled();
  return useQuery(graphicQueryOptions(graphicsApi, id, enabled));
}

/**
 * A graphic's name for the breadcrumb, from what is cached (its page, else the list), without
 * asking the server: `undefined` until either has it, for no id, and while Graphics are off.
 */
export function useGraphicName(id: string | undefined): string | undefined {
  const enabled = useGraphicsEnabled();
  const detail = useQuery({ ...graphicQueryOptions(graphicsApi, id ?? ''), enabled: false });
  const list = useQuery({ ...graphicsQueryOptions(graphicsApi), enabled: false });
  if (!enabled || id === undefined) return undefined;
  return detail.data?.name ?? list.data?.find((graphic) => graphic.id === id)?.name;
}
