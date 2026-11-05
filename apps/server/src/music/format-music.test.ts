import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobFormatsOf } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyMusicToFormats } from './format-music.js';

// copyMusicToFormats: the main composition's music.mp3 into the folder of every other format that
// exists. The music service's tests cover it end to end (Pick, Make another); these are its edges.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp edit/ folder with edit/preview/music.mp3 and the other formats' folders (with an old track). */
function editFolder(options: { main?: string | null; others?: string[] } = {}): string {
  const editDir = mkdtempSync(join(tmpdir(), 'studio-format-music-'));
  dirs.push(editDir);
  mkdirSync(join(editDir, 'preview'), { recursive: true });
  if (options.main !== null)
    writeFileSync(join(editDir, 'preview', 'music.mp3'), options.main ?? 'main');
  for (const id of options.others ?? []) {
    mkdirSync(join(editDir, `preview-${id}`), { recursive: true });
    writeFileSync(join(editDir, `preview-${id}`, 'music.mp3'), 'old');
  }
  return editDir;
}

const TWO = jobFormatsOf(['1080x1920', '1080x1080']);
const THREE = jobFormatsOf(['1080x1920', '1080x1080', '1080x1350']);
const text = (path: string) => readFileSync(path, 'utf8');

describe('copyMusicToFormats', () => {
  it('copies the main music into each other format that has a folder, and says which', async () => {
    const warn = vi.fn();
    const editDir = editFolder({ others: ['1x1', '4x5'] });
    expect(await copyMusicToFormats(editDir, THREE, { warn })).toEqual(['1x1', '4x5']);
    expect(text(join(editDir, 'preview-1x1', 'music.mp3'))).toBe('main');
    expect(text(join(editDir, 'preview-4x5', 'music.mp3'))).toBe('main');
    expect(text(join(editDir, 'preview', 'music.mp3'))).toBe('main');
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives the copy a fresh modified time and leaves no temporary file', async () => {
    const editDir = editFolder({ others: ['1x1'] });
    const other = join(editDir, 'preview-1x1', 'music.mp3');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(other, past, past);
    await copyMusicToFormats(editDir, TWO, { warn: vi.fn() });
    expect(statSync(other).mtimeMs).toBeGreaterThan(past.getTime());
    expect(readdirSync(join(editDir, 'preview-1x1'))).toEqual(['music.mp3']);
  });

  it('puts the file in a folder that has none yet', async () => {
    const editDir = editFolder();
    mkdirSync(join(editDir, 'preview-1x1'));
    expect(await copyMusicToFormats(editDir, TWO, { warn: vi.fn() })).toEqual(['1x1']);
    expect(text(join(editDir, 'preview-1x1', 'music.mp3'))).toBe('main');
  });

  it('skips a format without a folder, quietly, and creates nothing', async () => {
    const warn = vi.fn();
    const editDir = editFolder();
    expect(await copyMusicToFormats(editDir, TWO, { warn })).toEqual([]);
    expect(existsSync(join(editDir, 'preview-1x1'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing without music in the main preview', async () => {
    const warn = vi.fn();
    const editDir = editFolder({ main: null, others: ['1x1'] });
    expect(await copyMusicToFormats(editDir, TWO, { warn })).toEqual([]);
    expect(text(join(editDir, 'preview-1x1', 'music.mp3'))).toBe('old');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing for a job with no formats or one, whatever folders are there', async () => {
    const warn = vi.fn();
    const editDir = editFolder({ others: ['1x1'] });
    expect(await copyMusicToFormats(editDir, undefined, { warn })).toEqual([]);
    expect(await copyMusicToFormats(editDir, [], { warn })).toEqual([]);
    expect(await copyMusicToFormats(editDir, TWO.slice(0, 1), { warn })).toEqual([]);
    expect(text(join(editDir, 'preview-1x1', 'music.mp3'))).toBe('old');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a copy that fails, carries on with the rest and never rejects', async () => {
    const warn = vi.fn();
    const editDir = editFolder({ others: ['4x5'] });
    mkdirSync(join(editDir, 'preview-1x1', 'music.mp3'), { recursive: true });
    expect(await copyMusicToFormats(editDir, THREE, { warn }, 'job1')).toEqual(['4x5']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ jobId: 'job1', format: '1x1' });
    expect(readdirSync(join(editDir, 'preview-1x1'))).toEqual(['music.mp3']);
  });
});
