import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REVIEW_DIR_PATH,
  roundFilePath,
  VOICE_DIR_PATH,
  voiceAudioPath,
  voiceContentType,
  writeFileAtomic,
} from './review-files.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-review-files-'));
  dirs.push(dir);
  return dir;
}

describe('review paths', () => {
  it('keeps everything inside edit/, with forward slashes', () => {
    expect(REVIEW_DIR_PATH).toBe('edit/review');
    expect(VOICE_DIR_PATH).toBe('edit/review/voice');
  });

  it('names the round file after the round', () => {
    expect(roundFilePath(1)).toBe('edit/review/round-1.md');
    expect(roundFilePath(2)).toBe('edit/review/round-2.md');
  });

  it('names a recording after the note and its type', () => {
    expect(voiceAudioPath('n1', 'audio/webm')).toBe('edit/review/voice/n1.webm');
    expect(voiceAudioPath('n1', 'audio/mp4')).toBe('edit/review/voice/n1.m4a');
  });

  it('serves .m4a as audio/mp4 and anything else as audio/webm', () => {
    expect(voiceContentType('edit/review/voice/n1.m4a')).toBe('audio/mp4');
    expect(voiceContentType('edit/review/voice/N1.M4A')).toBe('audio/mp4');
    expect(voiceContentType('edit/review/voice/n1.webm')).toBe('audio/webm');
    expect(voiceContentType('edit/review/voice/n1')).toBe('audio/webm');
  });
});

describe('writeFileAtomic', () => {
  it('makes the folders and writes the text', async () => {
    const path = join(tempDir(), 'edit', 'review', 'round-1.md');

    await writeFileAtomic(path, '# Review notes\n');

    expect(readFileSync(path, 'utf8')).toBe('# Review notes\n');
    expect(readdirSync(join(path, '..'))).toEqual(['round-1.md']);
  });

  it('writes bytes as they are', async () => {
    const path = join(tempDir(), 'voice', 'n1.webm');
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);

    await writeFileAtomic(path, bytes);

    expect([...readFileSync(path)]).toEqual([...bytes]);
  });

  it('replaces an existing file and leaves no temp file', async () => {
    const dir = tempDir();
    const path = join(dir, 'round-1.md');
    writeFileSync(path, 'old');

    await writeFileAtomic(path, 'new');

    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['round-1.md']);
  });

  it('leaves no temp file when the write fails (the target is a folder)', async () => {
    const dir = tempDir();
    const path = join(dir, 'round-1.md');
    mkdirSync(path);

    await expect(writeFileAtomic(path, 'text')).rejects.toThrow();

    expect(readdirSync(dir)).toEqual(['round-1.md']);
    expect(readdirSync(path)).toEqual([]);
  });
});
