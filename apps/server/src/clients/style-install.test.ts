import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkNewStyle,
  installSeries,
  installStyle,
  newSeriesProblem,
  newStyleProblem,
  SERIES_BAD_TITLE,
  SERIES_EMPTY,
  SERIES_MISSING,
  STYLE_BAD_TITLE,
  STYLE_EMPTY,
  STYLE_MISSING,
} from './style-install.js';

let root: string;
let styleDir: string;
let historyFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-style-install-'));
  styleDir = join(root, 'inbox', 'Kova Coffee', '_Style');
  historyFile = join(root, 'data', 'clients', 'abc', 'history', '3.md');
  mkdirSync(styleDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (name: string, text: string) => writeFileSync(join(styleDir, name), text);
const read = (name: string) => readFileSync(join(styleDir, name), 'utf8');

describe('installStyle', () => {
  it('fails when the run wrote no style.md.new, and leaves style.md alone', async () => {
    write('style.md', '# Style: Kova Coffee\nold\n');
    expect(await installStyle({ styleDir, historyFile })).toEqual({
      ok: false,
      error: 'Style stopped: the run did not write style.md.new.',
    });
    expect(read('style.md')).toBe('# Style: Kova Coffee\nold\n');
    expect(existsSync(historyFile)).toBe(false);
  });

  it('fails for an empty style.md.new, or one of only spaces and line breaks, and removes it', async () => {
    for (const text of ['', '  \n\n\t\n']) {
      write('style.md.new', text);
      expect(await installStyle({ styleDir, historyFile })).toEqual({
        ok: false,
        error: STYLE_EMPTY,
      });
      expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
    }
    expect(STYLE_EMPTY).toBe('Style stopped: style.md.new is empty.');
  });

  it('fails when the first line is not the title, and keeps the old style', async () => {
    write('style.md', '# Style: Kova Coffee\nold\n');
    write('style.md.new', 'Here is the style you asked for:\n# Style: Kova Coffee\n');
    expect(await installStyle({ styleDir, historyFile })).toEqual({
      ok: false,
      error: 'Style stopped: style.md.new does not start with "# Style:".',
    });
    expect(read('style.md')).toBe('# Style: Kova Coffee\nold\n');
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
  });

  it('copies the old style.md to history, then puts the new one in its place', async () => {
    write('style.md', '# Style: Kova Coffee\nversion three\n');
    write('style.md.new', '# Style: Kova Coffee\nversion four\n');
    expect(await installStyle({ styleDir, historyFile })).toEqual({ ok: true });
    expect(read('style.md')).toBe('# Style: Kova Coffee\nversion four\n');
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
    expect(readFileSync(historyFile, 'utf8')).toBe('# Style: Kova Coffee\nversion three\n');
  });

  it('writes no history for the first style', async () => {
    write('style.md.new', '# Style: Kova Coffee\nfirst\n');
    expect(await installStyle({ styleDir, historyFile })).toEqual({ ok: true });
    expect(read('style.md')).toBe('# Style: Kova Coffee\nfirst\n');
    expect(existsSync(join(root, 'data'))).toBe(false);
  });
});

describe('newStyleProblem', () => {
  it('accepts a byte-order mark or blank lines before the title', () => {
    expect(newStyleProblem('﻿# Style: Kova\n')).toBeNull();
    expect(newStyleProblem('\n\n# Style: Kova\n')).toBeNull();
  });

  it('names each problem', () => {
    expect(newStyleProblem(null)).toBe(STYLE_MISSING);
    expect(newStyleProblem(' ')).toBe(STYLE_EMPTY);
    expect(newStyleProblem('# Style Kova')).toBe(STYLE_BAD_TITLE);
    expect(newStyleProblem('## Style: Kova')).toBe(STYLE_BAD_TITLE);
  });
});

describe('checkNewStyle', () => {
  it('checks style.md.new without putting it in place, and removes a rejected one', async () => {
    write('style.md', '# Style: Kova Coffee\nold\n');
    write('style.md.new', '# Style: Kova Coffee\nnew\n');
    expect(await checkNewStyle(styleDir)).toBeNull();
    expect(read('style.md')).toBe('# Style: Kova Coffee\nold\n');
    expect(read('style.md.new')).toBe('# Style: Kova Coffee\nnew\n');

    write('style.md.new', 'no title');
    expect(await checkNewStyle(styleDir)).toBe(STYLE_BAD_TITLE);
    expect(existsSync(join(styleDir, 'style.md.new'))).toBe(false);
  });
});

describe('installSeries', () => {
  let seriesDir: string;
  let seriesHistory: string;

  beforeEach(() => {
    seriesDir = join(root, 'inbox', 'Kova Coffee', '_Series', 'Weekly');
    seriesHistory = join(root, 'data', 'clients', 'abc', 'series', 'def', 'history', '1.md');
    mkdirSync(seriesDir, { recursive: true });
  });

  const writeSeries = (name: string, text: string) => writeFileSync(join(seriesDir, name), text);
  const readSeries = (name: string) => readFileSync(join(seriesDir, name), 'utf8');

  it('puts the first series.md in place, with nothing kept', async () => {
    writeSeries('series.md.new', '# Series: Weekly\nFormat from Weekly 5.\n');
    expect(await installSeries({ seriesDir, historyFile: seriesHistory })).toEqual({ ok: true });
    expect(readSeries('series.md')).toBe('# Series: Weekly\nFormat from Weekly 5.\n');
    expect(existsSync(join(seriesDir, 'series.md.new'))).toBe(false);
    expect(existsSync(seriesHistory)).toBe(false);
  });

  it('keeps the old series.md in the series history', async () => {
    writeSeries('series.md', '# Series: Weekly\nversion one\n');
    writeSeries('series.md.new', '# Series: Weekly\nversion two\n');
    expect(await installSeries({ seriesDir, historyFile: seriesHistory })).toEqual({ ok: true });
    expect(readSeries('series.md')).toBe('# Series: Weekly\nversion two\n');
    expect(readFileSync(seriesHistory, 'utf8')).toBe('# Series: Weekly\nversion one\n');
  });

  it('refuses a missing, empty or untitled series.md.new and leaves series.md alone', async () => {
    writeSeries('series.md', '# Series: Weekly\nold\n');
    expect(await installSeries({ seriesDir, historyFile: seriesHistory })).toEqual({
      ok: false,
      error: 'Series stopped: the run did not write series.md.new.',
    });
    for (const [text, error] of [
      [' \n', SERIES_EMPTY],
      ['# Style: Weekly\n', SERIES_BAD_TITLE],
    ] as const) {
      writeSeries('series.md.new', text);
      expect(await installSeries({ seriesDir, historyFile: seriesHistory })).toEqual({
        ok: false,
        error,
      });
      expect(existsSync(join(seriesDir, 'series.md.new'))).toBe(false);
    }
    expect(readSeries('series.md')).toBe('# Series: Weekly\nold\n');
    expect(existsSync(seriesHistory)).toBe(false);
  });
});

describe('newSeriesProblem', () => {
  it('wants "# Series:" first, like a style wants "# Style:"', () => {
    expect(newSeriesProblem('\uFEFF# Series: Weekly\n')).toBeNull();
    expect(newSeriesProblem('\n# Series: Weekly\n')).toBeNull();
    expect(newSeriesProblem(null)).toBe(SERIES_MISSING);
    expect(newSeriesProblem('')).toBe(SERIES_EMPTY);
    expect(newSeriesProblem('# Series Weekly')).toBe(SERIES_BAD_TITLE);
    expect(SERIES_BAD_TITLE).toBe('Series stopped: series.md.new does not start with "# Series:".');
  });
});
