import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  dialogSubline,
  ImportLutsBody,
  type ImportLutsBodyProps,
  importableCount,
  importSubline,
  rowInfo,
} from './ImportLutsBody';
import type { LutImportRow, LutImportState } from './lut-import-session';
import { lutBytesText } from './lut-import-text';

const row = (overrides: Partial<LutImportRow> = {}): LutImportRow => ({
  id: 'a',
  name: 'Golden Hour.cube',
  ok: true,
  error: null,
  size: 33,
  bytes: 1_468_006,
  kind: 'look',
  ...overrides,
});

const brokenRow = row({
  id: 'b',
  name: 'notes.cube',
  ok: false,
  error: 'Not a LUT: there is no LUT_3D_SIZE line.',
  size: null,
  bytes: 90,
  kind: null,
});

const stateOf = (overrides: Partial<LutImportState> = {}): LutImportState => ({
  step: 'pick',
  rows: [],
  stageId: null,
  percent: 0,
  error: null,
  notice: null,
  ...overrides,
});

const noop = () => {};

function body(state: LutImportState, props: Partial<ImportLutsBodyProps> = {}): string {
  return renderToStaticMarkup(
    <ImportLutsBody
      state={state}
      offline={false}
      dragging={false}
      onFiles={noop}
      onKind={noop}
      onRemove={noop}
      onRetry={noop}
      onImport={noop}
      onCancel={noop}
      {...props}
    />,
  );
}

describe('importSubline (the line under the title)', () => {
  it('changes with the step', () => {
    expect(importSubline({ step: 'pick', rows: [] })).toBe(
      'Pick the files. LUTs are checked before they are added.',
    );
    expect(importSubline({ step: 'listed', rows: [row(), brokenRow] })).toBe(
      '2 files picked. Say what each one is, so the grade uses it the right way.',
    );
    expect(importSubline({ step: 'listed', rows: [row()] })).toBe(
      '1 file picked. Say what each one is, so the grade uses it the right way.',
    );
    expect(importSubline({ step: 'importing', rows: [row()] })).toBe(
      'Please wait. This takes a few seconds.',
    );
    expect(importSubline({ step: 'failed', rows: [row(), brokenRow] })).toBe(
      '2 files picked. Nothing was added.',
    );
    expect(importSubline({ step: 'listed', rows: [brokenRow] })).toBe(
      'None of these files can be imported.',
    );
  });
});

describe('row text', () => {
  it('says the grid and the size of a good file, and the reason of a bad one', () => {
    expect(rowInfo(row())).toBe('33 × 33 × 33 · 1.4 MB');
    expect(rowInfo(brokenRow)).toBe('Not a LUT: there is no LUT_3D_SIZE line.');
    expect(rowInfo(row({ size: null, bytes: 2048 }))).toBe('2 KB');
  });

  it('writes sizes in binary units', () => {
    expect(lutBytesText(812)).toBe('812 B');
    expect(lutBytesText(98_304)).toBe('96 KB');
    expect(lutBytesText(1_468_006)).toBe('1.4 MB');
  });

  it('counts the rows that will be imported', () => {
    expect(importableCount([row(), brokenRow, row({ id: 'c' })])).toBe(2);
  });
});

describe('step 1', () => {
  const html = body(stateOf());

  it('has the dashed zone, its words and the two buttons', () => {
    expect(html).toContain('Drop .cube or .3dl files here');
    expect(html).toContain('One file, or a whole folder of them');
    expect(html).toContain('Choose files…');
    expect(html).toContain('Choose a folder…');
    expect(html).toContain('border-dashed');
  });

  it('has a files input for .cube and .3dl and a folder input', () => {
    expect(html).toContain('accept=".cube,.3dl"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('webkitdirectory=""');
  });

  it('shows the footer line, Cancel and an Import that is off', () => {
    expect(html).toContain('Copied into _LUTs in your Studio Inbox, so the originals can move.');
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
  });

  it('lights the zone while files are dragged over', () => {
    expect(body(stateOf(), { dragging: true })).toContain('data-dragging="true"');
    expect(html).not.toContain('data-dragging');
  });

  it('says why nothing was picked', () => {
    const notice = body(stateOf({ notice: 'There are no .cube or .3dl files in there.' }));
    expect(notice).toContain('role="alert"');
    expect(notice).toContain('There are no .cube or .3dl files in there.');
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

describe('step 2', () => {
  const html = body(stateOf({ step: 'listed', rows: [row(), brokenRow] }));

  it('lists the files with their facts', () => {
    expect(html).toContain('aria-label="Files to import"');
    expect(html).toContain('Golden Hour.cube');
    expect(html).toContain('33 × 33 × 33 · 1.4 MB');
  });

  it('has Look, Camera and Fix on a good file, the chosen kind pressed', () => {
    expect(html).toContain('aria-label="What is it?"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Look</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Camera</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Fix</);
    const camera = body(stateOf({ step: 'listed', rows: [row({ kind: 'camera' })] }));
    expect(camera).toMatch(/aria-pressed="true"[^>]*>Camera</);
  });

  it('gives the buttons type=button, so Enter on one submits nothing', () => {
    expect(html).not.toContain('<form');
    for (const button of html.match(/<button[^>]*>/g) ?? []) {
      expect(button).toContain('type="button"');
    }
  });

  it('shows a bad file with its reason in red and no kind control', () => {
    expect(html).toContain('Not a LUT: there is no LUT_3D_SIZE line.');
    expect(html).toContain('text-red-300');
    expect(html.match(/aria-label="What is it\?"/g)).toHaveLength(1);
  });

  it('has a remove button on every row', () => {
    expect(html).toContain('aria-label="Remove Golden Hour.cube from the list"');
    expect(html).toContain('aria-label="Remove notes.cube from the list"');
  });

  it('counts the good files on the filled button', () => {
    expect(html).toContain('>Import 1 LUT<');
    const two = body(stateOf({ step: 'listed', rows: [row(), row({ id: 'c' })] }));
    expect(two).toContain('>Import 2 LUTs<');
    expect(two).not.toMatch(/<button[^>]*disabled=""[^>]*>Import 2 LUTs</);
  });

  it('turns Import off when nothing is good', () => {
    const none = body(stateOf({ step: 'listed', rows: [brokenRow] }));
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
  });

  it('shows what went wrong with the request', () => {
    const failed = body(stateOf({ step: 'listed', rows: [row()], error: 'That upload is gone.' }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('That upload is gone.');
  });
});

describe('step 3', () => {
  const html = body(stateOf({ step: 'importing', rows: [row(), row({ id: 'c' }), brokenRow] }));

  it('says what is happening with the spinner', () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('Checking and copying 2 LUTs…');
    expect(html).toContain('animate-spin');
  });

  it('turns Cancel, every remove button and every kind off', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    const removes = html.match(/<button[^>]*aria-label="Remove[^>]*>/g) ?? [];
    expect(removes).toHaveLength(3);
    for (const button of removes) expect(button).toContain('disabled=""');
    const kinds = html.match(/<button[^>]*aria-pressed[^>]*>/g) ?? [];
    expect(kinds).toHaveLength(6);
    for (const button of kinds) expect(button).toContain('disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Importing…<\/button>/);
  });
});

describe('while the files go up', () => {
  const html = body(
    stateOf({ step: 'sending', percent: 40, rows: [row({ size: null, kind: null })] }),
  );

  it('lists them with a status line and a bar, and no controls', () => {
    expect(html).toContain('Checking 1 file…');
    expect(html).toContain('aria-label="Upload progress"');
    expect(html).not.toContain('aria-label="What is it?"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove/);
  });
});

describe('after an upload that failed', () => {
  const html = body(
    stateOf({
      step: 'failed',
      error: "Couldn't reach the engine. Nothing was added.",
      rows: [row({ size: null, kind: null, bytes: 2048 })],
    }),
  );

  it('keeps the files, says nothing was added and offers Try again', () => {
    expect(html).toContain('Couldn&#x27;t reach the engine. Nothing was added.');
    expect(html).toContain('Golden Hour.cube');
    expect(html).toContain('>2 KB<');
    expect(html).toContain('>Try again<');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Try again</);
  });

  it('has no kind control for a file the engine has not looked at', () => {
    expect(html).not.toContain('aria-label="What is it?"');
  });
});

describe('the dialog’s line when it was opened for a job that waits for a camera LUT (LU10)', () => {
  const forJob = { subline: 'For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT.' };

  it('says what is being looked for at step 1', () => {
    expect(dialogSubline(stateOf(), forJob)).toBe(forJob.subline);
  });

  it('says what it always did at every later step, and without a job', () => {
    expect(dialogSubline(stateOf(), null)).toBe(importSubline(stateOf()));
    expect(dialogSubline(stateOf())).toBe(importSubline(stateOf()));
    for (const step of ['sending', 'listed', 'failed', 'importing'] as const) {
      const state = stateOf({ step, rows: [row()] });
      expect(dialogSubline(state, forJob)).toBe(importSubline(state));
    }
  });
});
