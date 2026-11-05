// Types of openverse.mjs, the Openverse client of the stock script (sound effects only), for its tests.

import type { FetchFn } from './stock-env.mjs';

export const API_BASE: string;
export const API_BASE_ENV: string;
export const LICENSES: readonly string[];
export const SFX_SOURCE: string;

export interface StockCandidateShape {
  sourceId: string;
  title: string;
  creator: string;
  creatorUrl: string | null;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
  downloadUrl: string;
  trackUrl: string | null;
  fileType: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export function openverseBase(env?: Record<string, string | undefined>): string;
export function audioFileType(value: unknown): string | null;
export function toCandidate(
  result: unknown,
  options: { maxMs: number },
): StockCandidateShape | null;
export function createOpenverse(options?: {
  clientId?: string | null;
  clientSecret?: string | null;
  base?: string;
  fetch?: FetchFn;
  log?: (text: string) => void;
}): {
  searchSfx(
    query: string,
    options: { maxSeconds: number; limit: number },
  ): Promise<StockCandidateShape[]>;
};
