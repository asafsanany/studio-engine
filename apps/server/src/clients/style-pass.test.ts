import { describe, expect, it } from 'vitest';
import {
  type LearnPass,
  learnModeFor,
  mergePasses,
  parseStylePass,
  type ReadPass,
  readModeFor,
  summarizePass,
  withStyleState,
} from './style-pass.js';

const read = (mode: ReadPass['mode'], ...names: string[]): ReadPass => ({
  kind: 'read',
  mode,
  files: names.map((name, index) => ({ name, size: index + 1 })),
});

describe('readModeFor', () => {
  it('creates while there is no style.md, whatever was asked', () => {
    expect(readModeFor('add', false)).toBe('create');
    expect(readModeFor('replace', false)).toBe('create');
    expect(readModeFor('create', false)).toBe('create');
  });

  it('adds or replaces once there is one; a pass queued as create adds to it', () => {
    expect(readModeFor('add', true)).toBe('add');
    expect(readModeFor('replace', true)).toBe('replace');
    expect(readModeFor('create', true)).toBe('add');
  });

  it('settles a whole pass the same way', () => {
    expect(withStyleState(read('replace', 'a.png'), false)).toEqual(read('create', 'a.png'));
    expect(withStyleState(read('create', 'a.png'), true)).toEqual(read('add', 'a.png'));
  });
});

describe('mergePasses', () => {
  it("keeps the first pass's mode and the files of both, a file in both once with its later size", () => {
    const merged = mergePasses(read('replace', 'a.png', 'b.txt'), {
      kind: 'read',
      mode: 'add',
      files: [
        { name: 'c.pdf', size: 30 },
        { name: 'a.png', size: 99 },
      ],
    });
    expect(merged).toEqual({
      kind: 'read',
      mode: 'replace',
      files: [
        { name: 'a.png', size: 99 },
        { name: 'b.txt', size: 2 },
        { name: 'c.pdf', size: 30 },
      ],
    });
  });

  it('takes the decomposed and the precomposed spelling of a name for one file', () => {
    const merged = mergePasses(read('add', 'Café.png'), read('add', 'Café.png'));
    expect(merged?.kind === 'read' ? merged.files : []).toHaveLength(1);
  });
});

describe('parseStylePass', () => {
  it('reads a stored Read pass', () => {
    expect(parseStylePass(read('add', 'logo.png', 'Brand/notes.txt'))).toEqual(
      read('add', 'logo.png', 'Brand/notes.txt'),
    );
  });

  it('refuses anything else: no pass, an unknown kind, no files, a path out of the folder', () => {
    expect(parseStylePass(null)).toBeNull();
    expect(parseStylePass({ kind: 'paint' })).toBeNull();
    expect(parseStylePass({ kind: 'read', mode: 'add', files: [] })).toBeNull();
    expect(
      parseStylePass({ kind: 'read', mode: 'merge', files: [{ name: 'a', size: 1 }] }),
    ).toBeNull();
    for (const name of ['../secret.txt', '/etc/hosts', 'a//b', 'kit/../../x']) {
      expect(parseStylePass(read('add', name)), name).toBeNull();
    }
  });
});

describe('Learn passes', () => {
  const learn = (job: string, mode: LearnPass['mode'] = 'create'): LearnPass => ({
    kind: 'learn',
    mode,
    jobId: `id-${job}`,
    job,
  });

  it('reads a stored Learn pass of every mode, Hebrew job names included', () => {
    for (const mode of ['create', 'merge', 'replace'] as const) {
      expect(parseStylePass(learn('סרטון גיוס', mode))).toEqual(learn('סרטון גיוס', mode));
    }
  });

  it('refuses a job that is not one folder of the client, or a mode a Learn pass has not', () => {
    for (const job of ['', '..', '.', 'Menu/edit', '../Other/Menu']) {
      expect(parseStylePass(learn(job)), job).toBeNull();
    }
    expect(parseStylePass({ ...learn('Menu'), mode: 'add' })).toBeNull();
    expect(parseStylePass({ ...learn('Menu'), jobId: '' })).toBeNull();
  });

  it('creates while there is no style.md and merges into one once there is; replace stays', () => {
    expect(learnModeFor('create', false)).toBe('create');
    expect(learnModeFor('merge', false)).toBe('create');
    expect(learnModeFor('create', true)).toBe('merge');
    expect(learnModeFor('merge', true)).toBe('merge');
    expect(learnModeFor('replace', false)).toBe('replace');
    expect(learnModeFor('replace', true)).toBe('replace');
  });

  it('settles a whole Learn pass the same way', () => {
    expect(withStyleState(learn('Menu'), true)).toEqual(learn('Menu', 'merge'));
    expect(withStyleState(learn('Menu', 'merge'), false)).toEqual(learn('Menu', 'create'));
    expect(withStyleState(learn('Menu', 'replace'), true)).toEqual(learn('Menu', 'replace'));
  });

  it('joins a later Learn pass of the same job, replacing if either did', () => {
    expect(mergePasses(learn('A', 'replace'), learn('A', 'merge'))).toEqual(learn('A', 'replace'));
    expect(mergePasses(learn('A', 'create'), learn('A', 'merge'))).toEqual(learn('A', 'merge'));
  });

  it('never joins a Learn pass of another job: each job’s look goes into the style in turn', () => {
    expect(mergePasses(learn('A', 'replace'), learn('B'))).toBeNull();
    expect(mergePasses(learn('A', 'merge'), learn('B', 'merge'))).toBeNull();
    expect(mergePasses(learn('A'), read('add', 'a.png'))).toBeNull();
    expect(mergePasses(read('add', 'a.png'), learn('A'))).toBeNull();
  });

  it('is summed up for the web: the job of a Learn pass, the file count of a Read pass', () => {
    expect(summarizePass(learn('Menu'))).toEqual({
      kind: 'learn',
      mode: 'create',
      fileCount: 0,
      jobId: 'id-Menu',
      job: 'Menu',
    });
    expect(summarizePass(learn('Menu', 'merge'))).toMatchObject({ kind: 'learn', mode: 'merge' });
    expect(summarizePass(read('add', 'a.png', 'b.txt'))).toEqual({
      kind: 'read',
      mode: 'add',
      fileCount: 2,
      jobId: null,
      job: null,
    });
  });
});
