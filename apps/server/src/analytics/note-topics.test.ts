import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTE_TOPICS_FILE, NoteTopicStore, normalizeTopic, noteTopicsPath } from './note-topics.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'studio-note-topics-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('NoteTopicStore', () => {
  it('keeps its topics in note-topics.json in the data folder', () => {
    expect(noteTopicsPath('/data')).toBe('/data/note-topics.json');
    expect(NOTE_TOPICS_FILE).toBe('note-topics.json');
  });

  it('has no topics until there is a file, and counts a file it cannot read as empty', () => {
    const store = new NoteTopicStore(dataDir);
    expect(store.get()).toEqual({});

    writeFileSync(noteTopicsPath(dataDir), '{ not json');
    expect(store.get()).toEqual({});
    writeFileSync(noteTopicsPath(dataDir), '["intro too long"]');
    expect(store.get()).toEqual({});
  });

  it('keeps only the entries that are a note id and a topic', () => {
    writeFileSync(
      noteTopicsPath(dataDir),
      JSON.stringify({ n1: 'intro too long', n2: 3, n3: '', n4: null, n5: 'music too loud' }),
    );
    expect(new NoteTopicStore(dataDir).get()).toEqual({
      n1: 'intro too long',
      n5: 'music too loud',
    });
  });

  it('writes the topics as one object by note id, and reads a hand-made change at once', async () => {
    const store = new NoteTopicStore(dataDir);
    expect(await store.add({ n1: 'intro too long', n2: 'music too loud' })).toBe(2);

    expect(JSON.parse(readFileSync(noteTopicsPath(dataDir), 'utf8'))).toEqual({
      n1: 'intro too long',
      n2: 'music too loud',
    });
    writeFileSync(
      noteTopicsPath(dataDir),
      JSON.stringify({ n1: 'intro cut', n2: 'music too loud' }),
    );
    expect(store.get().n1).toBe('intro cut');
  });

  it('never replaces the topic a note has, and does not write when nothing is new', async () => {
    const store = new NoteTopicStore(dataDir);
    await store.add({ n1: 'intro too long' });
    const before = readFileSync(noteTopicsPath(dataDir), 'utf8');

    expect(await store.add({ n1: 'something else' })).toBe(0);
    expect(readFileSync(noteTopicsPath(dataDir), 'utf8')).toBe(before);

    expect(await store.add({ n1: 'something else', n2: 'subtitle position' })).toBe(1);
    expect(store.get()).toEqual({ n1: 'intro too long', n2: 'subtitle position' });
  });

  it('writes atomically: no temporary file is left, and the folder is made', async () => {
    const nested = join(dataDir, 'not', 'there', 'yet');
    await new NoteTopicStore(nested).add({ n1: 'intro too long' });
    expect(readdirSync(nested)).toEqual([NOTE_TOPICS_FILE]);
  });

  it('throws when the file cannot be written', async () => {
    mkdirSync(noteTopicsPath(dataDir));
    await expect(new NoteTopicStore(dataDir).add({ n1: 'intro too long' })).rejects.toThrow();
  });
});

describe('normalizeTopic', () => {
  it('lowercases, trims and tidies a topic', () => {
    expect(normalizeTopic('  Intro   too LONG. ')).toBe('intro too long');
    expect(normalizeTopic('"music too loud"')).toBe('music too loud');
    expect(normalizeTopic('b-roll timing')).toBe('b-roll timing');
    expect(normalizeTopic('cut and pacing')).toBe('cut and pacing');
    expect(normalizeTopic('music')).toBe('music');
  });

  it('refuses what is not a short English topic', () => {
    expect(normalizeTopic('')).toBeNull();
    expect(normalizeTopic('   ')).toBeNull();
    expect(normalizeTopic(4)).toBeNull();
    expect(normalizeTopic(null)).toBeNull();
    expect(normalizeTopic('הכותרת יורדת מהר')).toBeNull();
    expect(normalizeTopic('the title leaves the screen far too quickly in the intro')).toBeNull();
    expect(normalizeTopic('x'.repeat(41))).toBeNull();
    expect(normalizeTopic('intro (too long)')).toBeNull();
    expect(normalizeTopic('cut & pacing')).toBeNull();
  });
});
