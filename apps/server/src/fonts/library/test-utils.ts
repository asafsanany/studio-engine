// Test helpers for anything that needs a `_Fonts` folder with real files in it (the font index, the
// Fonts service and routes, the engine): a temp inbox whose `_Fonts` is filled from fixtures/fonts/
// the way the owner files their own fonts (`Hebrew + English/<Family>/` and `English only/<Family>/`).
// Never the real `~/Studio Inbox/_Fonts`. Not part of the server build (tsconfig.build.json).

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURE_FONTS } from '../font-test-utils.js';

export interface TempLibrary {
  /** The temp inbox. */
  inbox: string;
  /** `<inbox>/_Fonts`. */
  dir: string;
  /** Writes a file at a path inside `_Fonts` ('/' between folders) and answers its absolute path. */
  put(rel: string, bytes: Uint8Array | string): string;
  /** Copies a file of fixtures/fonts/ to a path inside `_Fonts` and answers its absolute path. */
  putFixture(rel: string, fixture: string): string;
  /** Removes a file at a path inside `_Fonts`. */
  remove(rel: string): void;
  /** Absolute path of a path inside `_Fonts`. */
  path(rel: string): string;
  /** Deletes the whole temp inbox. */
  cleanup(): void;
}

/** An empty temp inbox with an empty `_Fonts` folder. */
export function makeLibrary(): TempLibrary {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-fonts-'));
  const dir = join(inbox, '_Fonts');
  mkdirSync(dir, { recursive: true });
  const path = (rel: string): string => join(dir, ...rel.split('/'));
  return {
    inbox,
    dir,
    path,
    put(rel, bytes) {
      const target = path(rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      return target;
    },
    putFixture(rel, fixture) {
      const target = path(rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(FIXTURE_FONTS, fixture), target);
      return target;
    },
    remove(rel) {
      unlinkSync(path(rel));
    },
    cleanup() {
      rmSync(inbox, { recursive: true, force: true });
    },
  };
}

/**
 * A temp inbox with six real faces of five families in the two folders: Secular One, Bellefair and
 * Varela Round (Hebrew + English), Outfit Regular and Bold and Oswald (English only).
 */
export function makeStandardLibrary(): TempLibrary {
  const library = makeLibrary();
  library.putFixture(
    'Hebrew + English/Secular One/SecularOne-Regular.ttf',
    'SecularOne-Regular.ttf',
  );
  library.putFixture('Hebrew + English/Bellefair/Bellefair-Regular.ttf', 'Bellefair-Regular.ttf');
  library.putFixture(
    'Hebrew + English/Varela Round/VarelaRound-Regular.ttf',
    'VarelaRound-Regular.ttf',
  );
  library.putFixture('English only/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf');
  library.putFixture('English only/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf');
  library.putFixture('English only/Oswald/Oswald-Regular.ttf', 'Oswald-Regular.ttf');
  return library;
}
