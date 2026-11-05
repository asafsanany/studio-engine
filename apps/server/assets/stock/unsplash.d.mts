// Types of unsplash.mjs, the Unsplash client of the stock script (photos only), for its tests.

import type { StockCandidateShape } from './openverse.mjs';
import type { FetchFn } from './stock-env.mjs';

export const API_BASE: string;
export const API_BASE_ENV: string;
export const LICENSE_URL: string;
export const UTM: string;
export const ORIENTATIONS: readonly string[];

export function unsplashBase(env?: Record<string, string | undefined>): string;
export function withUtm(url: unknown): string | null;
export function photoFileUrl(raw: unknown, options?: { allowLoopback?: boolean }): string | null;
export function toCandidate(
  result: unknown,
  options?: { allowLoopback?: boolean },
): StockCandidateShape | null;
export function createUnsplash(options: {
  accessKey: string | null;
  base?: string;
  fetch?: FetchFn;
  log?: (text: string) => void;
}): {
  searchPhotos(
    query: string,
    options: { orientation?: string; limit: number },
  ): Promise<StockCandidateShape[]>;
  trackDownload(trackUrl: string): Promise<void>;
};
