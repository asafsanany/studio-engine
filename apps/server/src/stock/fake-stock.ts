// The fake runner's stock media (Stock media, ST5): with the Stock switch on, step 6 of a fake edit
// run gets a sound effect and a photo through the stock script itself, the way a real edit run does,
// with STUDIO_STOCK_FAKE=1 (two canned sound effects and photos, placeholder files, no key, no
// network). The job then comes back to Review with edit/stock/stock.json in place, so everything
// that shows what a run took can be tried without keys or a Claude run.

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { STOCK_FILES } from '@studio/shared';
import { STOCK_SCRIPT } from './stock-assets.js';

export interface FakeStockOptions {
  /** The job's absolute edit folder. */
  editDir: string;
  signal?: AbortSignal;
  /** The stock script (tests point it at another). Default: the engine's own. */
  script?: string;
  /** Variables for the script besides the fake switch. Default: the PATH only. */
  env?: Record<string, string | undefined>;
}

/** What the fake run takes: the first sound effect of one search and the first photo of another. */
export const FAKE_STOCK_CALLS: readonly (readonly string[])[] = [
  ['sfx', 'whoosh'],
  ['get', 'c1'],
  ['photo', 'street at night'],
  ['get', 'c3'],
];

function call(script: string, args: readonly string[], options: FakeStockOptions): Promise<void> {
  return new Promise((done) => {
    const [command, ...rest] = args;
    const argv = [script, command ?? '', options.editDir, ...rest];
    execFile(
      process.execPath,
      argv,
      {
        env: { ...(options.env ?? { PATH: process.env.PATH }), STUDIO_STOCK_FAKE: '1' },
        signal: options.signal,
        timeout: 30_000,
      },
      // A call that fails leaves the run going without that item, as a real run does.
      () => done(),
    );
  });
}

/** Gets the fake sound effect and photo, unless the job already has stock media. */
export async function makeFakeStock(options: FakeStockOptions): Promise<void> {
  try {
    await access(join(options.editDir, STOCK_FILES.record));
    return;
  } catch {
    // Not yet.
  }
  const script = options.script ?? STOCK_SCRIPT;
  for (const args of FAKE_STOCK_CALLS) {
    if (options.signal?.aborted) return;
    await call(script, args, options);
  }
}
