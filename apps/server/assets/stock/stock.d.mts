// Types of stock.mjs, the stock script (Stock media), for its tests and the doctor. The files it
// writes match the shared contract (packages/shared/src/domain/stock.ts); these are only the
// script's own exports.

import type { FetchFn } from './stock-env.mjs';

export const EXIT: { ok: 0; failed: 1; refused: 2; down: 3 };
export const EXIT_FOR: Record<string, number>;
export const LIMITS: {
  searchesPerRun: number;
  fetchesPerRun: number;
  resultsPerSearch: number;
  sfxDefaultMaxSeconds: number;
  sfxMaxSeconds: number;
  queryMax: number;
};
export const FILES: { dir: string; record: string; cache: string };

export function creditLine(item: {
  id: string;
  title: string;
  creator: string;
  license: 'cc0' | 'pdm' | 'by' | 'unsplash';
  source: 'openverse' | 'unsplash';
}): string;

export interface StockIo {
  env?: Record<string, string | undefined>;
  fetch?: FetchFn;
  now?: () => number;
  log?: (text: string) => void;
}

export function runStock(
  argv: string[],
  io?: StockIo,
): Promise<{ line: Record<string, unknown>; exit: number }>;
