import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { historyFileFor, historyKitDirFor, historySourceFileFor } from './paths.js';
import { kitSectionLines, newestKeptKit, restoreHistoryKit } from './style-history.js';

// The kits Start a series puts back from style history (C23). Undo and the rest of the history are
// tested through the workers (style-worker.test.ts, series-worker.test.ts).

const CLIENT_ID = 'c0ffee000000';

let root: string;
let dataDir: string;
let styleDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-style-history-'));
  dataDir = join(root, 'data');
  styleDir = join(root, 'inbox', 'Kova Coffee', '_Style');
  mkdirSync(styleDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text = 'x'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Keeps a style at `version` with a kit holding `files` (none: an empty kit). */
function keep(version: number, files: string[], sourceJobId: string | null = null): void {
  write(
    historyFileFor(dataDir, CLIENT_ID, version),
    `# Style\nv${version}\n## Kit\n- v${version}\n`,
  );
  mkdirSync(historyKitDirFor(dataDir, CLIENT_ID, version), { recursive: true });
  for (const file of files) write(join(historyKitDirFor(dataDir, CLIENT_ID, version), file), file);
  if (sourceJobId !== null) {
    write(historySourceFileFor(dataDir, CLIENT_ID, version), JSON.stringify({ sourceJobId }));
  }
}

describe('kitSectionLines', () => {
  it('reads the lines under ## Kit, up to the next section', () => {
    expect(kitSectionLines('# Style\n## Kit\n- a\n- b\n\n## Reference\n- r\n')).toBe('- a\n- b');
    expect(kitSectionLines('# Style\n## Kit\r\n- a\r\n')).toBe('- a');
    expect(kitSectionLines('# Style\n## Kit\n### Title card\n- a\n')).toBe('### Title card\n- a');
  });

  it('is null for a style with no ## Kit or nothing under it', () => {
    expect(kitSectionLines('# Style\n## Look\n- a\n')).toBeNull();
    expect(kitSectionLines('# Style\n## Kit\n\n## Do\n- a\n')).toBeNull();
    expect(kitSectionLines('# Style\n### Kit\n- a\n')).toBeNull();
  });
});

describe('newestKeptKit', () => {
  it('finds the newest kit kept below the version, with its job and ## Kit lines', async () => {
    keep(1, ['composition/index.html', '.DS_Store'], 'faq');
    write(historyFileFor(dataDir, CLIENT_ID, 2), '# Style\nv2\n');
    keep(3, ['slot_title/index.html'], 'launch');

    expect(await newestKeptKit(dataDir, CLIENT_ID, 3)).toEqual({
      version: 1,
      names: ['composition'],
      sourceJobId: 'faq',
      section: '- v1',
    });
    expect(await newestKeptKit(dataDir, CLIENT_ID, 4)).toMatchObject({
      version: 3,
      names: ['slot_title'],
    });
  });

  it('answers an empty kit as one with no names, and null when none was kept', async () => {
    expect(await newestKeptKit(dataDir, CLIENT_ID, 5)).toBeNull();
    keep(2, []);
    expect(await newestKeptKit(dataDir, CLIENT_ID, 5)).toEqual({
      version: 2,
      names: [],
      sourceJobId: null,
      section: '- v2',
    });
    expect(await newestKeptKit(dataDir, CLIENT_ID, 2)).toBeNull();
  });
});

describe('restoreHistoryKit', () => {
  it('copies the kept kit in place of the kit there, and history keeps it', async () => {
    keep(1, ['composition/index.html', 'composition/compositions/wa-message.html']);
    write(join(styleDir, 'kit', 'composition', 'index.html'), 'the episode');
    write(join(styleDir, 'kit', 'slot_end', 'index.html'), 'the episode');

    await restoreHistoryKit(dataDir, CLIENT_ID, 1, styleDir);

    expect(readFileSync(join(styleDir, 'kit', 'composition', 'index.html'), 'utf8')).toBe(
      'composition/index.html',
    );
    expect(
      existsSync(join(styleDir, 'kit', 'composition', 'compositions', 'wa-message.html')),
    ).toBe(true);
    expect(existsSync(join(styleDir, 'kit', 'slot_end'))).toBe(false);
    expect(existsSync(join(styleDir, '.kit-restoring'))).toBe(false);
    expect(existsSync(join(historyKitDirFor(dataDir, CLIENT_ID, 1), 'composition'))).toBe(true);
  });

  it('leaves the kit there when the kept one can’t be copied', async () => {
    write(join(styleDir, 'kit', 'composition', 'index.html'), 'the episode');

    await expect(restoreHistoryKit(dataDir, CLIENT_ID, 7, styleDir)).rejects.toThrow();

    expect(readFileSync(join(styleDir, 'kit', 'composition', 'index.html'), 'utf8')).toBe(
      'the episode',
    );
    expect(existsSync(join(styleDir, '.kit-restoring'))).toBe(false);
  });
});
