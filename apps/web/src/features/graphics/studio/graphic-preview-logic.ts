// The preview column's pure parts (GR3): the address of the host page, the lengths the player
// reports, the time label and the "showing an older version" rule. No React, so they are tested
// without a DOM.

import {
  encodeGraphicVars,
  GRAPHIC_SIZE_PIXELS,
  type GraphicBackground,
  type GraphicSize,
  type GraphicVars,
} from '@studio/shared';

/** Where the engine serves the graphics API. */
export const GRAPHICS_API_BASE = '/api/graphics';

/**
 * The time after the graphic's length that the host adds so the loop breathes: the same 0.8 s as
 * the server's HOST_TAIL_SEC (graphics/graphic-host.ts). The web cannot import the server, so the
 * player's reported length minus this is the graphic's own length.
 */
export const PREVIEW_TAIL_SEC = 0.8;

/** How long after the last keystroke in a text field the player is re-keyed. */
export const VALUES_DEBOUNCE_MS = 300;

/** What the toggles start at. */
export const DEFAULT_PREVIEW_SIZE: GraphicSize = '9x16';
export const DEFAULT_PREVIEW_BACKGROUND: GraphicBackground = 'frame';

/** `values` with its keys in a fixed order, so the same text is always the same address. */
export function sortedValues(values: GraphicVars): GraphicVars {
  const sorted: GraphicVars = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key] ?? '';
  return sorted;
}

/** The host's `vars` parameter for `values`: '' when there are none (the graphic's defaults). */
export function varsParam(values: GraphicVars): string {
  return Object.keys(values).length === 0 ? '' : encodeGraphicVars(sortedValues(values));
}

export interface GraphicHostUrlInput {
  /** The graphic's id (12 hex). */
  id: string;
  /** The version to play. */
  version: number;
  size: GraphicSize;
  background: GraphicBackground;
  /** The `vars` parameter, as `varsParam` makes it. */
  vars: string;
  /** Where the graphics API is. Default {@link GRAPHICS_API_BASE}; the dev gallery has its own. */
  apiBase?: string;
}

/**
 * The address the player loads (routes/graphic-files.ts):
 * `/api/graphics/<id>/v/<n>/host.html?size=9x16&bg=frame&vars=…`. Everything the toggles and the
 * text fields change is in the address, so changing any of them is a new address.
 */
export function graphicHostUrl({
  id,
  version,
  size,
  background,
  vars,
  apiBase = GRAPHICS_API_BASE,
}: GraphicHostUrlInput): string {
  const query = `size=${size}&bg=${background}${vars === '' ? '' : `&vars=${vars}`}`;
  return `${apiBase.replace(/\/+$/, '')}/${id}/v/${version}/host.html?${query}`;
}

/** What the player plays: the graphic's length plus the tail. `undefined` when it is not known. */
export function playDurationSec(lengthSec: number | null | undefined): number | undefined {
  if (lengthSec === null || lengthSec === undefined || !(lengthSec > 0)) return undefined;
  return Math.round((lengthSec + PREVIEW_TAIL_SEC) * 1000) / 1000;
}

/** The graphic's own length, from the length the player reports (which has the tail). */
export function graphicLengthSec(playDuration: number): number {
  return Math.max(0, Math.round((playDuration - PREVIEW_TAIL_SEC) * 1000) / 1000);
}

/**
 * The time under the picture, "1.2 / 3.0 s": the position never passes the graphic's length, so
 * the tail of the loop reads "3.0 / 3.0 s".
 */
export function timeLabel(currentSec: number, lengthSec: number): string {
  const length = Number.isFinite(lengthSec) && lengthSec > 0 ? lengthSec : 0;
  const at = Number.isFinite(currentSec) ? Math.min(Math.max(0, currentSec), length) : 0;
  return `${at.toFixed(1)} / ${length.toFixed(1)} s`;
}

/** Whether an older version is on show: "Showing v1. Edits use v2." */
export function isShowingOlder(shown: number | null, newest: number | null): boolean {
  return shown !== null && newest !== null && shown < newest;
}

/** The size's aspect ratio as the host's pixels give it (width / height). */
export function sizeRatio(size: GraphicSize): number {
  const { width, height } = GRAPHIC_SIZE_PIXELS[size];
  return width / height;
}
