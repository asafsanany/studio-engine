import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';

// Stock media (ST0): while the Stock switch is on, the edit run can fetch a sound effect from
// Openverse or a photo from Unsplash with the stock script (apps/server/assets/stock/stock.mjs),
// when the footage has none. The script is plain Node and cannot import this file, so it writes
// what these schemas read; its tests check every file it writes against them.
//
// On disk, per job (paths relative to the job's edit/ folder, `STOCK_FILES`):
//
//   stock/stock.json     the record (StockRecord): every item the run took, with who made it and
//                        under what license. Written only by the stock script.
//   stock/<id>.<ext>     the downloaded files, never changed once fetched
//   stock/cache.json     the last searches, so a revise run does not ask again (StockCache)
//
// No stock.json means a job from before Stock media, or one edited while the switch was off.

// --- files ---------------------------------------------------------------------------------------

/** The stock files, relative to a job's edit/ folder. */
export const STOCK_FILES = {
  /** The folder the stock script owns. */
  dir: 'stock',
  /** The record. */
  record: 'stock/stock.json',
  /** The cached searches. */
  cache: 'stock/cache.json',
} as const;

// --- limits --------------------------------------------------------------------------------------

export const STOCK_LIMITS = {
  /** Searches one run may make, both sources together. */
  searchesPerRun: 6,
  /** Files one run may fetch, both sources together. */
  fetchesPerRun: 8,
  /** Results a search prints for the run to choose from. */
  resultsPerSearch: 8,
  /** The longest sound effect a search offers by default, in seconds (a bed or a song is not one). */
  sfxDefaultMaxSeconds: 15,
  /** The longest the run may ask for, in seconds. */
  sfxMaxSeconds: 30,
  /** A search's words, in characters. */
  queryMax: 120,
} as const;

// --- kinds, sources and licenses ----------------------------------------------------------------

export const STOCK_KINDS = ['sfx', 'photo'] as const;
export const stockKindSchema = z.enum(STOCK_KINDS);
export type StockKind = z.infer<typeof stockKindSchema>;

/** Where each kind comes from: sound effects from Openverse, photos from Unsplash. */
export const STOCK_SOURCES = { sfx: 'openverse', photo: 'unsplash' } as const satisfies Record<
  StockKind,
  string
>;
export const stockSourceSchema = z.enum(['openverse', 'unsplash']);
export type StockSource = z.infer<typeof stockSourceSchema>;

/**
 * The Openverse licenses a sound effect may have: CC0, public domain mark and CC BY. No NC (these
 * are client deliverables) and no ND (the edit changes the sound). Unsplash photos are under
 * Unsplash's own license, written as "unsplash".
 */
export const STOCK_LICENSES = ['cc0', 'pdm', 'by', 'unsplash'] as const;
export const stockLicenseSchema = z.enum(STOCK_LICENSES);
export type StockLicense = z.infer<typeof stockLicenseSchema>;

/** The Openverse `license` filter the script sends: the licenses above that Openverse knows. */
export const OPENVERSE_LICENSE_FILTER = 'cc0,pdm,by';

/** What a license is called on the job sheet. */
export const STOCK_LICENSE_NAMES: Record<StockLicense, string> = {
  cc0: 'CC0',
  pdm: 'Public domain',
  by: 'CC BY',
  unsplash: 'Unsplash License',
};

/** Whether the license asks for the creator to be named (CC BY, and Unsplash's courtesy credit). */
export function stockNeedsCredit(license: StockLicense): boolean {
  return license === 'by' || license === 'unsplash';
}

// --- the record ----------------------------------------------------------------------------------

export const stockItemSchema = z.object({
  /** "sfx-1", "photo-1" …: the kind and a counter, unique inside the job. */
  id: z.string().regex(/^(sfx|photo)-[1-9][0-9]*$/),
  kind: stockKindSchema,
  source: stockSourceSchema,
  /** The source's own id (Openverse's uuid, Unsplash's photo id): getting it again gives this item. */
  sourceId: z.string().min(1),
  /** The file, relative to edit/stock/: "sfx-1.mp3", "photo-1.jpg". */
  file: z.string().min(1),
  title: z.string(),
  /** Who made it. Empty when the source does not say. */
  creator: z.string(),
  creatorUrl: z.string().nullable(),
  license: stockLicenseSchema,
  /** The license's page, when the source gives one. */
  licenseUrl: z.string().nullable(),
  /** Where it was found: the item's own page. */
  sourceUrl: z.string(),
  /** The words that found it. */
  query: z.string().max(STOCK_LIMITS.queryMax),
  /** The run that took it (STUDIO_ENGINE_RUN), so a run's fetches can be counted; empty if none. */
  run: z.string().default(''),
  /** A sound effect's length in ms; null for a photo. */
  durationMs: z.number().int().positive().nullable(),
  /** A photo's size in pixels; null for a sound effect. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  fetchedAt: isoTimestampSchema,
});
export type StockItem = z.infer<typeof stockItemSchema>;

export const stockRecordSchema = z.object({
  version: z.literal(1),
  items: z.array(stockItemSchema),
});
export type StockRecord = z.infer<typeof stockRecordSchema>;

/** A job's record before the run took anything. */
export function emptyStockRecord(): StockRecord {
  return { version: 1, items: [] };
}

/** The next id for a kind: "sfx-1" for the first, then "sfx-2" … */
export function nextStockId(record: StockRecord, kind: StockKind): string {
  const taken = record.items
    .filter((item) => item.kind === kind)
    .map((item) => Number(item.id.slice(kind.length + 1)));
  return `${kind}-${Math.max(0, ...taken) + 1}`;
}

/**
 * The credit line for an item: "Whoosh by Jane Doe (CC BY, openverse.org)". A creator the source
 * did not name is left out; the license and the source stay.
 */
export function stockCreditLine(item: StockItem): string {
  const by = item.creator.trim() === '' ? '' : ` by ${item.creator.trim()}`;
  const from = item.source === 'openverse' ? 'Openverse' : 'Unsplash';
  return `${item.title.trim() === '' ? item.id : item.title.trim()}${by} (${STOCK_LICENSE_NAMES[item.license]}, ${from})`;
}

// --- the sheet's answer -------------------------------------------------------------------------

/**
 * `GET /api/jobs/:id/stock`: what the job's runs took from Openverse and Unsplash, oldest first.
 * A job that took nothing (or was edited with the switch off) has `items: []`; the answer is the
 * same in every state of the job and with the Stock switch off, since a credit stays true.
 */
export const stockResponseSchema = z.object({
  jobId: z.string().min(1),
  items: z.array(stockItemSchema),
});
export type StockResponse = z.infer<typeof stockResponseSchema>;

// --- the cache -----------------------------------------------------------------------------------

/** One candidate a search printed, kept so `get <id>` can fetch it later in the run. */
export const stockCandidateSchema = z.object({
  /** What the run names it by in `get`: "c1", "c2" … counted over the whole job. */
  ref: z.string().regex(/^c[1-9][0-9]*$/),
  /** The source's own id (Openverse's uuid, Unsplash's photo id). */
  sourceId: z.string().min(1),
  title: z.string(),
  creator: z.string(),
  creatorUrl: z.string().nullable(),
  license: stockLicenseSchema,
  licenseUrl: z.string().nullable(),
  sourceUrl: z.string(),
  /** Where the file is downloaded from. */
  downloadUrl: z.string(),
  /** The file's type as the source says ("mp3", "wav"); null for a photo or when it does not say. */
  fileType: z.string().nullable(),
  /** Unsplash only: the endpoint that must be called when a photo is used. */
  trackUrl: z.string().nullable(),
  durationMs: z.number().int().positive().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type StockCandidate = z.infer<typeof stockCandidateSchema>;

export const stockCacheSchema = z.object({
  version: z.literal(1),
  /** Searches made so far in this job, counted against STOCK_LIMITS.searchesPerRun by the run. */
  searches: z.array(
    z.object({
      kind: stockKindSchema,
      query: z.string(),
      /** What else the search was asked ("max=15" seconds, a photo's orientation); empty if nothing. */
      options: z.string().default(''),
      /** The run that searched (STUDIO_ENGINE_RUN); empty if none. */
      run: z.string().default(''),
      at: isoTimestampSchema,
      candidates: z.array(stockCandidateSchema),
    }),
  ),
});
export type StockCache = z.infer<typeof stockCacheSchema>;

export function emptyStockCache(): StockCache {
  return { version: 1, searches: [] };
}
