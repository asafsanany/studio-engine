// Temp folders for the server tests (C45). Not part of the server build (see tsconfig.build.json).
//
// `makeTempDir('studio-engine-money-')` makes a folder under the temp dir and removes it for the
// test file, so a test no longer keeps its own list of homes and its own `rmSync` loop:
//   - a folder made while a test runs (in the test or in a `beforeEach`) goes when that test ends,
//     after the file's own `afterEach` hooks (they stop the engines first: Vitest runs the "after"
//     hooks in reverse order, and this module registers its hooks when it is imported);
//   - a folder made outside a test (a `beforeAll`, or at the top of the file) goes after the last
//     test of the file.
// A folder that is busy or not empty yet is retried; one that still cannot go is tried again after
// the last test and then named on stderr, never thrown (a leftover folder must not fail a test).
// After the last test every folder of the file is removed once more, for a background job that
// made one again after it was removed.
//
// An engine that is booted with the built-in LUTs on starts their preview stills (ffmpeg) at the end
// of `start()`, and `engine.stop()` does not wait for them: they write `.studio-engine/lut-previews`
// into the home after it was removed, which leaves a folder behind however well the test cleans up.
// An engine test that is not about the stills boots with `builtInLuts: noBuiltInLuts()`; one that
// needs a (fake) colour-grade skill wraps it: `withoutLutStills(createBuiltInLuts({ skillDir }))`;
// one that imports LUTs through the engine also boots with `lutPreviews: noLutPreviews()`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { createBuiltInLuts } from './luts/lut-builtin.js';
import type { LutPreviews } from './luts/lut-previews.js';
import type { BuiltInLuts } from './luts/lut-service.js';

/** Made while a test runs: removed when that test ends. */
const forTest = new Set<string>();
/** Made outside a test (a `beforeAll`, the top of the file): removed after the last test. */
const forFile = new Set<string>();
/** Every folder of this file, for the last sweep. */
const everMade = new Set<string>();
let inTest = false;

function removeAll(dirs: Set<string>, final: boolean): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      dirs.delete(dir);
    } catch (err) {
      if (final) {
        dirs.delete(dir);
        console.warn(`test-temp: could not remove ${dir}: ${String(err)}`);
      }
    }
  }
}

beforeEach(() => {
  inTest = true;
});

afterEach(() => {
  inTest = false;
  removeAll(forTest, false);
});

afterAll(() => {
  // Every folder of the file, the ones removed already too: a background job that outlived its test
  // may have made one again.
  removeAll(everMade, true);
});

/** A new folder `<temp dir>/<prefix>XXXXXX`, removed for you after the test (or the file). */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  (inTest ? forTest : forFile).add(dir);
  everMade.add(dir);
  return dir;
}

/**
 * The built-in LUTs of a Mac that has no colour-grade skill: nothing is available, so the engine
 * starts no preview stills in the background (see the note at the top). Pass it as
 * `createEngine({ builtInLuts: noBuiltInLuts() })`.
 */
export function noBuiltInLuts(): BuiltInLuts {
  return createBuiltInLuts({ skillDir: join(tmpdir(), 'studio-no-such-skill') });
}

/**
 * The built-in LUTs of a (fake) skill, as they are, except that no file is found to start their
 * stills (and the Cinematic bake, which runs python) from: the list, the details and the files an
 * edit uses stay; `warmBuiltInLuts` finds nothing to warm.
 */
export function withoutLutStills(builtIn: BuiltInLuts): BuiltInLuts {
  return { ...builtIn, cubeFile: async () => null };
}

/**
 * A stills maker that makes nothing (`warm` does nothing, `still` rejects): for a test that imports
 * or adds LUTs through the engine, which starts the stills of every LUT it takes in.
 */
export function noLutPreviews(): LutPreviews {
  return {
    still: () => Promise.reject(new Error('This test makes no LUT stills.')),
    warm: () => {},
  };
}
