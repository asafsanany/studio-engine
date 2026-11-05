#!/usr/bin/env node
// The stock script (Stock media): how an edit run gets a sound effect from Openverse or a photo
// from Unsplash. Plain Node, no dependencies; it runs from the engine's assets/ folder in src and
// dist alike. The contract it writes is packages/shared/src/domain/stock.ts (its tests check every
// file against those schemas).
//
//   node stock.mjs sfx   "<edit dir>" "<words>" [--max-seconds N]    search sound effects (Openverse)
//   node stock.mjs photo "<edit dir>" "<words>" [--orientation landscape|portrait|squarish]
//                                                                    search photos (Unsplash)
//   node stock.mjs get   "<edit dir>" <ref>     fetch one candidate a search printed ("c3") into
//                                               edit/stock/ and record who made it and its license
//   node stock.mjs list  "<edit dir>"           what this job has fetched so far
//
// A search prints up to 8 candidates, each with a `ref`. It keeps them in edit/stock/cache.json, so
// the same words in a later run answer from the file and ask the service nothing. `get` downloads
// the file as edit/stock/<sfx-1.mp3|photo-1.jpg>, tells Unsplash a photo is used (their guidelines
// require it) and appends the item to edit/stock/stock.json. Getting the same ref twice gives the
// same item. Limits for one run (STUDIO_ENGINE_RUN): 6 searches and 8 fetches, both services
// together. Sound effects are CC0, public domain or CC BY only, at most 15 s long unless
// --max-seconds asks for more (up to 30).
//
// The keys (OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET, both optional: without them Openverse
// answers as an anonymous application with low limits; UNSPLASH_ACCESS_KEY, required for photos)
// are read from the environment, else the .env named by STUDIO_ENV_FILE, else the repo's. Never
// printed, logged or put in an argument.
//
// Output: one JSON line on stdout. {"ok":true,…} exits 0; {"ok":false,"code":…,"message":…} exits
// 1 (a request that cannot work), 2 (refused: no key, key rejected, a limit of the run) or 3 (the
// service is down or says too many requests: try again later). Tests: OPENVERSE_API_BASE and
// UNSPLASH_API_BASE (loopback http URLs only), and the `io` of runStock. STUDIO_STOCK_FAKE=1 answers
// from stock-fake.mjs instead (two sound effects and two photos for any words, placeholder files, no
// key, no network): for the fake runner, the e2e engine and a try-out.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioFileType, createOpenverse, openverseBase } from './openverse.mjs';
import {
  downloadBytes,
  LIMITS as HTTP_LIMITS,
  KEY_ENV,
  readKey,
  redact,
  StockError,
} from './stock-env.mjs';
import { fakeFetch } from './stock-fake.mjs';
import { createUnsplash, ORIENTATIONS, unsplashBase } from './unsplash.mjs';

export const EXIT = { ok: 0, failed: 1, refused: 2, down: 3 };
export const EXIT_FOR = {
  bad_request: EXIT.failed,
  not_found: EXIT.failed,
  key_missing: EXIT.refused,
  key_rejected: EXIT.refused,
  limit_reached: EXIT.refused,
  rate_limited: EXIT.down,
  unavailable: EXIT.down,
};

/** The same numbers as STOCK_LIMITS in the shared contract (a test checks they agree). */
export const LIMITS = {
  searchesPerRun: 6,
  fetchesPerRun: 8,
  resultsPerSearch: 8,
  sfxDefaultMaxSeconds: 15,
  sfxMaxSeconds: 30,
  queryMax: 120,
};

/** The same paths as STOCK_FILES in the shared contract, relative to the edit folder. */
export const FILES = { dir: 'stock', record: 'stock/stock.json', cache: 'stock/cache.json' };

const LICENSE_NAMES = {
  cc0: 'CC0',
  pdm: 'Public domain',
  by: 'CC BY',
  unsplash: 'Unsplash License',
};
const RUN_TAG_VAR = 'STUDIO_ENGINE_RUN';

const USAGE = 'Usage: stock.mjs sfx|photo|get|list "<edit dir>" … (see the top of the script).';

// --- arguments ----------------------------------------------------------------------------------

function parseArgs(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new StockError('bad_request', `--${name} needs a value.`);
      }
      flags[name] = value;
      i += 1;
    } else {
      words.push(arg);
    }
  }
  return { words, flags };
}

function cleanQuery(text) {
  const query = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (query === '') throw new StockError('bad_request', 'Say in a few words what to look for.');
  if (query.length > LIMITS.queryMax) {
    throw new StockError(
      'bad_request',
      `Use at most ${LIMITS.queryMax} characters to say what to look for.`,
    );
  }
  return query;
}

// --- files --------------------------------------------------------------------------------------

function readJson(path, fallback, valid) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return valid(parsed) ? parsed : fallback();
  } catch {
    return fallback();
  }
}

function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const loadRecord = (editDir) =>
  readJson(
    join(editDir, FILES.record),
    () => ({ version: 1, items: [] }),
    (v) => v?.version === 1 && Array.isArray(v.items),
  );
const loadCache = (editDir) =>
  readJson(
    join(editDir, FILES.cache),
    () => ({ version: 1, searches: [] }),
    (v) => v?.version === 1 && Array.isArray(v.searches),
  );

/** "sfx-1" for the first of a kind, then "sfx-2" … (nextStockId in the shared contract). */
function nextId(record, kind) {
  const taken = record.items
    .filter((item) => item.kind === kind)
    .map((item) => Number(item.id.slice(kind.length + 1)));
  return `${kind}-${Math.max(0, ...taken) + 1}`;
}

/** The credit line of an item (stockCreditLine in the shared contract). */
export function creditLine(item) {
  const title = item.title.trim() === '' ? item.id : item.title.trim();
  const by = item.creator.trim() === '' ? '' : ` by ${item.creator.trim()}`;
  return `${title}${by} (${LICENSE_NAMES[item.license]}, ${item.source === 'openverse' ? 'Openverse' : 'Unsplash'})`;
}

// --- commands -----------------------------------------------------------------------------------

/** The Unsplash key; the fake services take any. */
function unsplashKey(ctx) {
  const key = readKey(KEY_ENV.unsplash, ctx.env, ctx.envFile);
  return key ?? (ctx.fake ? 'fake-unsplash-key' : null);
}

function shown(candidate) {
  return {
    ref: candidate.ref,
    title: candidate.title,
    creator: candidate.creator,
    license: LICENSE_NAMES[candidate.license],
    ...(candidate.durationMs === null
      ? {}
      : { seconds: Math.round(candidate.durationMs / 100) / 10 }),
    ...(candidate.width === null ? {} : { width: candidate.width, height: candidate.height }),
  };
}

async function search(kind, args, ctx) {
  const query = cleanQuery(args.words[2]);
  let options;
  let maxSeconds = LIMITS.sfxDefaultMaxSeconds;
  if (kind === 'sfx') {
    if (args.flags['max-seconds'] !== undefined) {
      maxSeconds = Number(args.flags['max-seconds']);
      if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > LIMITS.sfxMaxSeconds) {
        throw new StockError(
          'bad_request',
          `--max-seconds is a number from 1 to ${LIMITS.sfxMaxSeconds}.`,
        );
      }
    }
    options = `max=${maxSeconds}`;
  } else {
    const orientation = args.flags.orientation;
    if (orientation !== undefined && !ORIENTATIONS.includes(orientation)) {
      throw new StockError('bad_request', `--orientation is ${ORIENTATIONS.join(', ')}.`);
    }
    options = orientation ?? '';
  }

  const cache = loadCache(ctx.editDir);
  const key = query.toLowerCase();
  const hit = cache.searches.find(
    (entry) =>
      entry.kind === kind && entry.query.toLowerCase() === key && (entry.options ?? '') === options,
  );
  if (hit) {
    return {
      ok: true,
      kind,
      query: hit.query,
      cached: true,
      candidates: hit.candidates.map(shown),
      ...(hit.candidates.length === 0
        ? { message: 'Nothing found for these words. Try other words, or go without.' }
        : {}),
    };
  }

  const done = cache.searches.filter((entry) => (entry.run ?? '') === ctx.runTag).length;
  if (done >= LIMITS.searchesPerRun) {
    throw new StockError(
      'limit_reached',
      `This run has made its ${LIMITS.searchesPerRun} searches: use what it found, or go without.`,
    );
  }

  let found;
  if (kind === 'sfx') {
    const client = createOpenverse({
      clientId: readKey(KEY_ENV.openverseId, ctx.env, ctx.envFile),
      clientSecret: readKey(KEY_ENV.openverseSecret, ctx.env, ctx.envFile),
      base: openverseBase(ctx.env),
      fetch: ctx.fetch,
      log: ctx.log,
    });
    found = await client.searchSfx(query, { maxSeconds, limit: LIMITS.resultsPerSearch });
  } else {
    const client = createUnsplash({
      accessKey: unsplashKey(ctx),
      base: unsplashBase(ctx.env),
      fetch: ctx.fetch,
      log: ctx.log,
    });
    found = await client.searchPhotos(query, {
      orientation: options || undefined,
      limit: LIMITS.resultsPerSearch,
    });
  }

  const counter = Math.max(
    0,
    ...cache.searches.flatMap((entry) => entry.candidates.map((c) => Number(c.ref.slice(1)))),
  );
  const candidates = found.map((candidate, index) => ({
    ref: `c${counter + index + 1}`,
    ...candidate,
  }));
  cache.searches.push({
    kind,
    query,
    options,
    run: ctx.runTag,
    at: new Date(ctx.now()).toISOString(),
    candidates,
  });
  mkdirSync(join(ctx.editDir, FILES.dir), { recursive: true });
  writeAtomic(join(ctx.editDir, FILES.cache), `${JSON.stringify(cache, null, 2)}\n`);
  return {
    ok: true,
    kind,
    query,
    cached: false,
    candidates: candidates.map(shown),
    ...(candidates.length === 0
      ? { message: 'Nothing found for these words. Try other words, or go without.' }
      : {}),
  };
}

const AUDIO_BY_TYPE = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
};

async function get(args, ctx) {
  const ref = args.words[2];
  if (!/^c[1-9][0-9]*$/.test(ref ?? '')) {
    throw new StockError('bad_request', 'get needs a ref a search printed, like c3.');
  }
  const cache = loadCache(ctx.editDir);
  let candidate = null;
  let kind = null;
  for (const entry of cache.searches) {
    const match = entry.candidates.find((c) => c.ref === ref);
    if (match) {
      candidate = match;
      kind = entry.kind;
    }
  }
  if (candidate === null)
    throw new StockError('not_found', `No search printed ${ref} for this job.`);

  const record = loadRecord(ctx.editDir);
  const source = kind === 'sfx' ? 'openverse' : 'unsplash';
  const have = record.items.find(
    (item) => item.source === source && item.sourceId === candidate.sourceId,
  );
  if (have) return itemAnswer(ctx.editDir, have, true);

  const taken = record.items.filter((item) => (item.run ?? '') === ctx.runTag).length;
  if (taken >= LIMITS.fetchesPerRun) {
    throw new StockError(
      'limit_reached',
      `This run has fetched its ${LIMITS.fetchesPerRun} files: use those, or go without.`,
    );
  }

  let unsplash = null;
  if (kind === 'photo') {
    unsplash = createUnsplash({
      accessKey: unsplashKey(ctx),
      base: unsplashBase(ctx.env),
      fetch: ctx.fetch,
      log: ctx.log,
    });
  }

  const { bytes, type } = await downloadBytes(ctx.fetch, candidate.downloadUrl, {
    maxBytes: kind === 'sfx' ? HTTP_LIMITS.maxSfxBytes : HTTP_LIMITS.maxPhotoBytes,
    typeOk: (t) =>
      kind === 'sfx'
        ? t.startsWith('audio/') || t === 'application/octet-stream'
        : t.startsWith('image/'),
  });
  let ext = 'jpg';
  if (kind === 'sfx') {
    ext = audioFileType(candidate.fileType) ?? AUDIO_BY_TYPE[type] ?? null;
    if (ext === null)
      throw new StockError('bad_request', 'The sound is in a format the edit cannot use.');
  }

  const id = nextId(record, kind);
  const file = `${id}.${ext}`;
  mkdirSync(join(ctx.editDir, FILES.dir), { recursive: true });
  writeAtomic(join(ctx.editDir, FILES.dir, file), bytes);

  let tracked = null;
  if (unsplash !== null) {
    try {
      await unsplash.trackDownload(candidate.trackUrl);
      tracked = true;
    } catch (error) {
      tracked = false;
      ctx.log(`could not tell Unsplash about the download: ${error.message}`);
    }
  }

  const query =
    cache.searches.find((entry) => entry.candidates.some((c) => c.ref === ref))?.query ?? '';
  const item = {
    id,
    kind,
    source,
    sourceId: candidate.sourceId,
    file,
    title: candidate.title,
    creator: candidate.creator,
    creatorUrl: candidate.creatorUrl,
    license: candidate.license,
    licenseUrl: candidate.licenseUrl,
    sourceUrl: candidate.sourceUrl,
    query,
    run: ctx.runTag,
    durationMs: candidate.durationMs,
    width: candidate.width,
    height: candidate.height,
    fetchedAt: new Date(ctx.now()).toISOString(),
  };
  record.items.push(item);
  writeAtomic(join(ctx.editDir, FILES.record), `${JSON.stringify(record, null, 2)}\n`);
  return itemAnswer(ctx.editDir, item, false, tracked);
}

function itemAnswer(editDir, item, already, tracked = null) {
  return {
    ok: true,
    already,
    item: {
      id: item.id,
      kind: item.kind,
      title: item.title,
      creator: item.creator,
      license: LICENSE_NAMES[item.license],
    },
    path: join(editDir, FILES.dir, item.file),
    credit: creditLine(item),
    ...(tracked === false
      ? { note: 'Unsplash could not be told about the download; the photo is fine to use.' }
      : {}),
  };
}

function list(ctx) {
  const record = loadRecord(ctx.editDir);
  return {
    ok: true,
    items: record.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      path: join(ctx.editDir, FILES.dir, item.file),
      credit: creditLine(item),
    })),
  };
}

// --- running ------------------------------------------------------------------------------------

function failureLine(error) {
  const code = error instanceof StockError ? error.code : 'unavailable';
  const message =
    error instanceof StockError ? error.message : redact(String(error?.message ?? error));
  return { line: { ok: false, code, message }, exit: EXIT_FOR[code] ?? EXIT.failed };
}

/**
 * Runs one command. Returns `{ line, exit }`: the JSON line to print (with any key taken out) and
 * the exit code. `io` is for tests: `env`, `fetch`, `now`, `log`.
 */
export async function runStock(argv, io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? ((text) => process.stderr.write(`${redact(`[stock] ${text}`)}\n`));
  try {
    const args = parseArgs(argv);
    const [command, editDir] = args.words;
    if (!['sfx', 'photo', 'get', 'list'].includes(command ?? ''))
      throw new StockError('bad_request', USAGE);
    if (!isAbsolute(editDir ?? '') || !existsSync(editDir) || !statSync(editDir).isDirectory()) {
      throw new StockError(
        'bad_request',
        `"${editDir ?? ''}" is not an existing absolute edit folder.`,
      );
    }
    const fake = env.STUDIO_STOCK_FAKE === '1';
    const ctx = {
      env,
      fake,
      editDir,
      envFile: undefined,
      fetch: io.fetch ?? (fake ? fakeFetch() : fetch),
      now: io.now ?? Date.now,
      log,
      runTag: (env[RUN_TAG_VAR] ?? '').trim(),
    };
    const line =
      command === 'list'
        ? list(ctx)
        : command === 'get'
          ? await get(args, ctx)
          : await search(command, args, ctx);
    return { line: JSON.parse(redact(JSON.stringify(line))), exit: EXIT.ok };
  } catch (error) {
    const answer = failureLine(error);
    return { line: JSON.parse(redact(JSON.stringify(answer.line))), exit: answer.exit };
  }
}

async function main() {
  const { line, exit } = await runStock(process.argv.slice(2));
  console.log(redact(JSON.stringify(line)));
  process.exit(exit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
