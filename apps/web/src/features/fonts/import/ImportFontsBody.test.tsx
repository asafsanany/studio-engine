import {
  FONT_MESSAGES,
  fontAddsMessage,
  fontConflictMessage,
  fontNewMessage,
  fontSameMessage,
} from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeFontStageItem } from '@/data/test-utils';
import type { FontImportState } from './font-import-session';
import { copyingText, importLabel } from './font-import-text';
import {
  ImportFontsBody,
  type ImportFontsBodyProps,
  importSubline,
  rowTag,
} from './ImportFontsBody';

const karantina = makeFontStageItem({ info: fontNewMessage(3, true, 210_000) });
const bebas = makeFontStageItem({
  id: 'bebas-neue',
  name: 'Bebas Neue',
  files: 1,
  he: false,
  weights: [400],
  bytes: 100_000,
  info: fontNewMessage(1, false, 100_000),
});
const rubik = makeFontStageItem({
  id: 'rubik',
  name: 'Rubik',
  files: 2,
  weights: [800, 900],
  status: 'adds',
  info: fontAddsMessage(2, 'Rubik'),
});
const heebo = makeFontStageItem({
  id: 'heebo',
  name: 'Heebo',
  files: 9,
  weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
  status: 'same',
  info: fontSameMessage(9),
});
const outfit = makeFontStageItem({
  id: 'outfit',
  name: 'Outfit',
  files: 1,
  he: false,
  weights: [700],
  status: 'conflict',
  info: fontConflictMessage('Outfit Bold'),
});
const broken = makeFontStageItem({
  id: 'broken-export-ttf',
  name: 'Broken export.ttf',
  files: 1,
  he: false,
  weights: [],
  bytes: 2_048,
  status: 'bad',
  info: FONT_MESSAGES.cutShort,
});

const stateOf = (overrides: Partial<FontImportState> = {}): FontImportState => ({
  step: 'pick',
  items: [],
  stageId: null,
  picked: 0,
  percent: 0,
  error: null,
  notice: null,
  ...overrides,
});

const noop = () => {};

function body(state: FontImportState, props: Partial<ImportFontsBodyProps> = {}): string {
  return renderToStaticMarkup(
    <ImportFontsBody
      state={state}
      offline={false}
      dragging={false}
      onFiles={noop}
      onRemove={noop}
      onRetry={noop}
      onImport={noop}
      onCancel={noop}
      {...props}
    />,
  );
}

/** The four kinds of the board plus a conflict: what FOPage start=staged shows. */
const staged = (items = [karantina, bebas, heebo, broken]) =>
  stateOf({ step: 'listed', stageId: 's1', items });

describe('importSubline (the line under the title)', () => {
  it('changes with the step', () => {
    expect(importSubline(stateOf())).toBe(
      'Pick the files. Fonts are checked before they are added.',
    );
    expect(importSubline(staged())).toBe(
      '4 items picked. Families are read from inside the files, so file and folder names don’t matter.',
    );
    expect(importSubline(staged([karantina]))).toBe(
      '1 item picked. Families are read from inside the files, so file and folder names don’t matter.',
    );
    expect(importSubline(stateOf({ step: 'sending', picked: 3 }))).toBe(
      'Please wait. This takes a few seconds.',
    );
    expect(importSubline({ ...staged(), step: 'importing' })).toBe(
      'Please wait. This takes a few seconds.',
    );
    expect(importSubline(stateOf({ step: 'failed', picked: 237 }))).toBe(
      '237 files picked. Nothing was added.',
    );
    expect(importSubline(stateOf({ step: 'failed', picked: 1 }))).toBe(
      '1 file picked. Nothing was added.',
    );
  });
});

describe('rowTag', () => {
  it('is New, Adds N, Already here and Can’t import', () => {
    expect(rowTag(karantina)).toEqual({ label: 'New', tone: 'good' });
    expect(rowTag(rubik)).toEqual({ label: 'Adds 2', tone: 'good' });
    expect(rowTag(heebo)).toEqual({ label: 'Already here', tone: 'same' });
    expect(rowTag(broken)).toEqual({ label: 'Can’t import', tone: 'bad' });
  });

  it('is Can’t import for a conflict too', () => {
    expect(rowTag(outfit)).toEqual({ label: 'Can’t import', tone: 'bad' });
  });

  it('counts the different weights an item adds', () => {
    expect(rowTag(makeFontStageItem({ status: 'adds', weights: [700] })).label).toBe('Adds 1');
    expect(rowTag(makeFontStageItem({ status: 'adds', weights: [400, 400, 700] })).label).toBe(
      'Adds 2',
    );
  });
});

describe('step 1', () => {
  const html = body(stateOf());

  it('has the dashed zone, its words and the two buttons', () => {
    expect(html).toContain('Drop .ttf, .otf, .woff or .woff2 files here');
    expect(html).toContain('One file, a whole family’s folder, or your entire fonts folder');
    expect(html).toContain('Choose files…');
    expect(html).toContain('Choose a folder…');
    expect(html).toContain('border-dashed');
  });

  it('has a files input for the four formats and a folder input', () => {
    expect(html).toContain('accept=".ttf,.otf,.woff,.woff2"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('webkitdirectory=""');
  });

  it('shows the footer line, Cancel and an Import that is off', () => {
    expect(html).toContain(
      'Copied into _Fonts in your Studio Inbox, sorted into Hebrew + English or English only, so the originals can move.',
    );
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
  });

  it('lights the zone while files are dragged over', () => {
    expect(body(stateOf(), { dragging: true })).toContain('data-dragging="true"');
    expect(html).not.toContain('data-dragging');
  });

  it('says why nothing was picked', () => {
    const notice = body(
      stateOf({ notice: 'There are no .ttf, .otf, .woff or .woff2 files in there.' }),
    );
    expect(notice).toContain('role="alert"');
    expect(notice).toContain('There are no .ttf, .otf, .woff or .woff2 files in there.');
  });
});

describe('offline', () => {
  const html = body(stateOf(), { offline: true });

  it('turns the buttons off and says importing waits', () => {
    expect(html).toContain('Importing waits until the engine is back.');
    expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-disabled="true"');
  });

  it('does not light the zone for a drag', () => {
    expect(body(stateOf(), { offline: true, dragging: true })).toContain('border-foreground/20');
  });
});

describe('step 2, the four kinds of item', () => {
  const html = body(staged([karantina, bebas, rubik, heebo, outfit, broken]));

  it('lists each with its name and the engine’s line', () => {
    expect(html).toContain('aria-label="Fonts to import"');
    for (const item of [karantina, bebas, rubik, heebo, outfit, broken]) {
      expect(html).toContain(item.name);
    }
    expect(html).toContain('3 files · Hebrew + English · 0.2 MB');
    expect(html).toContain('1 file · English only · 0.1 MB');
    expect(html).toContain('Adds 2 weights to Rubik.');
    expect(html).toContain('Already here with the same 9 weights. Skipped.');
    expect(html).toContain(
      'You already have a different Outfit Bold. Delete it first to replace it.',
    );
    expect(html).toContain('Not a font: the file is cut short.');
  });

  it('tags each: New, Adds N, Already here, Can’t import (twice: a bad file and a conflict)', () => {
    const tags = [...html.matchAll(/data-slot="font-import-tag"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tags).toEqual(['New', 'New', 'Adds 2', 'Already here', 'Can’t import', 'Can’t import']);
  });

  it('dims an item that is already here, and shows a bad one in red', () => {
    const rows = html.split('<li ').slice(1);
    const sameRow = rows.find((row) => row.includes('data-status="same"')) ?? '';
    expect(sameRow).toContain('opacity-60');
    for (const status of ['bad', 'conflict']) {
      const row = rows.find((one) => one.includes(`data-status="${status}"`)) ?? '';
      expect(row).toContain('text-red-300');
      expect(row).toContain('text-destructive');
    }
    const newRow = rows.find((row) => row.includes('data-status="new"')) ?? '';
    expect(newRow).not.toContain('opacity-60');
    expect(newRow).not.toContain('text-red-300');
  });

  it('has a remove button on every row', () => {
    for (const item of [karantina, bebas, rubik, heebo, outfit, broken]) {
      expect(html).toContain(`aria-label="Remove ${item.name} from the list"`);
    }
    for (const button of html.match(/<button[^>]*aria-label="Remove[^>]*>/g) ?? []) {
      expect(button).not.toContain('disabled=""');
    }
  });

  it('gives the buttons type=button, so Enter on one submits nothing', () => {
    expect(html).not.toContain('<form');
    for (const button of html.match(/<button[^>]*>/g) ?? []) {
      expect(button).toContain('type="button"');
    }
  });

  it('shows no drop zone any more', () => {
    expect(html).not.toContain('font-import-zone');
  });
});

describe('the Import button', () => {
  it('counts the new and adds items, and nothing else', () => {
    expect(body(staged())).toContain('>Import 2 fonts<');
    expect(body(staged([karantina, bebas, rubik, heebo, outfit, broken]))).toContain(
      '>Import 3 fonts<',
    );
    expect(importLabel(1)).toBe('Import 1 font');
    expect(body(staged([bebas, heebo, broken]))).toContain('>Import 1 font<');
  });

  it('is on when there is something to import', () => {
    expect(body(staged())).not.toMatch(/<button[^>]*disabled=""[^>]*>Import 2 fonts</);
  });

  it('is off, and just says Import, when nothing can be imported', () => {
    for (const items of [[heebo], [broken], [outfit], [heebo, outfit, broken]]) {
      expect(body(staged(items))).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
    }
  });
});

describe('step 3, importing', () => {
  const html = body({ ...staged([karantina, bebas, heebo, broken]), step: 'importing' });

  it('says what is happening with the spinner', () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('Checking and copying 2 fonts…');
    expect(copyingText(1)).toBe('Checking and copying 1 font…');
    expect(html).toContain('animate-spin');
  });

  it('turns Cancel and every remove button off, and the filled button says Importing…', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    const removes = html.match(/<button[^>]*aria-label="Remove[^>]*>/g) ?? [];
    expect(removes).toHaveLength(4);
    for (const button of removes) expect(button).toContain('disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Importing…<\/button>/);
  });

  it('dims the item that can’t be imported, as well as the one already here', () => {
    const rows = html.split('<li ').slice(1);
    expect(rows.find((row) => row.includes('data-status="bad"'))).toContain('opacity-50');
    expect(rows.find((row) => row.includes('data-status="same"'))).toContain('opacity-60');
  });
});

describe('while the files go up', () => {
  const html = body(stateOf({ step: 'sending', picked: 237, percent: 40 }));

  it('says how many are being checked, with a bar, and no list', () => {
    expect(html).toContain('Checking 237 files…');
    expect(html).toContain('aria-label="Upload progress"');
    expect(html).not.toContain('<li');
    expect(html).not.toContain('font-import-zone');
  });

  it('keeps Cancel, so the upload can be given up, and has the Import button off', () => {
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel</);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
  });
});

describe('an error', () => {
  it('after a failed upload shows the sentence and offers Try again', () => {
    const html = body(stateOf({ step: 'failed', picked: 3, error: FONT_MESSAGES.stageTooLarge }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('The upload is too large: at most 400 MB at once.');
    expect(html).toContain('>Try again<');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Try again</);
  });

  it('after a refused import stays on the list and shows the sentence', () => {
    const html = body({ ...staged(), error: FONT_MESSAGES.stageNotFound });
    expect(html).toContain('That upload is gone. Choose the files again.');
    expect(html).toContain('Karantina');
    expect(html).toContain('>Import 2 fonts<');
  });
});
