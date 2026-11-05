import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editProgressStep,
  hasEditProgress,
  snapshotEditStep,
  snapshotHasEditProgress,
} from './progress-evidence.js';
import { scanEditDir } from './progress-watcher.js';

let root: string;
let editDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-evidence-'));
  editDir = join(root, 'edit');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content = 'x'): void {
  const full = join(editDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('hasEditProgress', () => {
  it('is false when edit/ is not there, or empty', async () => {
    expect(await hasEditProgress(editDir)).toBe(false);
    mkdirSync(editDir);
    expect(await hasEditProgress(editDir)).toBe(false);
  });

  it('is false for what the Brief step writes: brief.json, brief.md and its voice-note transcripts', async () => {
    put('brief.json', '{}');
    put('brief.md', '# Brief');
    put('brief/transcripts/note.json', '{}');
    expect(await hasEditProgress(editDir)).toBe(false);
  });

  it('is false for the client style the Brief step copies in, kit slots and all', async () => {
    put('brief.json', '{}');
    put('style/style.md', '# Style: Acme');
    put('style/preview.mp4');
    put('style/kit/slot_1/index.html');
    put('style/kit/slot_1/render.mov');
    expect(await hasEditProgress(editDir)).toBe(false);
    expect(await editProgressStep(editDir)).toBeNull();
  });

  it.each([
    ['a transcript', 'transcripts/a.json'],
    ['takes_packed.md', 'takes_packed.md'],
    ['project.md', 'project.md'],
    ['edl.json', 'edl.json'],
    ['a graphics slot', 'animations/slot_1/index.html'],
    ['a preview', 'preview.mp4'],
    ['a final render', 'final.mp4'],
    ['a named final render', 'final_v2.mp4'],
  ])('is true once %s is there', async (_what, path) => {
    put('brief.json', '{}');
    put(path);
    expect(await hasEditProgress(editDir)).toBe(true);
  });

  it('is false for things that are not the edit’s own work', async () => {
    // Filmstrips of the sources before any preview, a folder with no transcript in it, files
    // with other names, and what HyperFrames and the runners keep in dot-named files.
    put('verify/src_full.png');
    put('transcripts/notes.txt');
    put('.hyperframes/cache.json');
    put('.final.mp4.partial');
    put('notes.md');
    expect(await hasEditProgress(editDir)).toBe(false);
  });

  it('rejects when edit/ cannot be read, so the caller decides', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    mkdirSync(editDir);
    put('takes_packed.md');
    chmodSync(editDir, 0o000);
    try {
      await expect(hasEditProgress(editDir)).rejects.toThrow();
    } finally {
      chmodSync(editDir, 0o755);
    }
  });
});

describe('snapshotHasEditProgress', () => {
  it('is false for an empty look', () => {
    expect(snapshotHasEditProgress(new Map())).toBe(false);
  });
});

// CVP-138: the step the edit's work reached, which the resume and retry prompts name for a job
// whose stored step is Brief (1).
describe('editProgressStep', () => {
  const REACHED: [string, string[], number][] = [
    ['a transcript', ['transcripts/a.json'], 2],
    ['takes_packed.md', ['transcripts/a.json', 'takes_packed.md'], 3],
    ['the plan', ['transcripts/a.json', 'takes_packed.md', 'project.md'], 4],
    ['the EDL', ['takes_packed.md', 'project.md', 'edl.json'], 5],
    [
      'a graphics slot being rendered',
      ['takes_packed.md', 'project.md', 'edl.json', 'animations/slot_1/index.html'],
      5,
    ],
    ['a preview', ['takes_packed.md', 'project.md', 'edl.json', 'preview.mp4'], 6],
    [
      'check frames of the preview',
      ['takes_packed.md', 'project.md', 'edl.json', 'preview.mp4', 'verify/p_1.jpg'],
      7,
    ],
    ['a final render', ['takes_packed.md', 'project.md', 'edl.json', 'final.mp4'], 8],
  ];

  it.each(REACHED)('is the step %s shows', async (_what, paths, step) => {
    put('brief.json', '{}');
    for (const path of paths) put(path);
    expect(await editProgressStep(editDir)).toBe(step);
  });

  it('is Transcribe for project.md alone: the plan is not proven, but it is the edit’s file', async () => {
    put('project.md');
    expect(await editProgressStep(editDir)).toBe(2);
  });

  it('is null when there is no work of the edit: not there, empty, or only the Brief’s files', async () => {
    expect(await editProgressStep(editDir)).toBeNull();
    mkdirSync(editDir);
    expect(await editProgressStep(editDir)).toBeNull();
    put('brief.json', '{}');
    put('brief.md', '# Brief');
    put('brief/transcripts/note.json', '{}');
    put('verify/src_full.png');
    expect(await editProgressStep(editDir)).toBeNull();
  });

  it('agrees with hasEditProgress on what counts as work', async () => {
    for (const paths of [[], ['project.md'], ['transcripts/a.json'], ['verify/src_full.png']]) {
      rmSync(editDir, { recursive: true, force: true });
      for (const path of paths) put(path);
      expect(await editProgressStep(editDir)).toBe((await hasEditProgress(editDir)) ? 2 : null);
    }
  });

  it('is null for an empty look', () => {
    expect(snapshotEditStep(new Map())).toBeNull();
  });
});

// W2: a run that ends in Review leaves a live composition in edit/preview/. For such a run its
// index.html is the Preview; for a run that delivers final.mp4 it is nothing.
describe("the composition of a run that ends in Review (finish: 'preview')", () => {
  const PLANNED = ['takes_packed.md', 'project.md', 'edl.json'];

  it('counts preview/index.html as the Preview (6)', async () => {
    put('brief.json', '{}');
    for (const path of PLANNED) put(path);
    put('preview/index.html');
    put('preview/cut.mp4');
    expect(await editProgressStep(editDir, 'preview')).toBe(6);
  });

  it('counts the check frames of a composition as Check (7)', async () => {
    for (const path of PLANNED) put(path);
    put('preview/index.html');
    put('verify/f_1.jpg');
    expect(await editProgressStep(editDir, 'preview')).toBe(7);
  });

  it('does not count it with the default finish: the folder says nothing of a run that delivers final.mp4', async () => {
    for (const path of PLANNED) put(path);
    put('preview/index.html');
    expect(await editProgressStep(editDir)).toBe(5);
    expect(await editProgressStep(editDir, 'final')).toBe(5);
  });

  it('is work of the edit on its own, for a preview run', async () => {
    put('preview/index.html');
    expect(await editProgressStep(editDir, 'preview')).toBe(6);
    expect(await editProgressStep(editDir)).toBeNull();
    expect(await hasEditProgress(editDir)).toBe(false);
  });

  it('snapshotEditStep takes the finish too', async () => {
    put('preview/index.html');
    const snapshot = await scanEditDir(editDir);
    expect(snapshotEditStep(snapshot, 'preview')).toBe(6);
    expect(snapshotEditStep(snapshot)).toBeNull();
  });

  it('ignores final.mp4 for a preview run: it never reaches Render (8)', async () => {
    for (const path of PLANNED) put(path);
    put('preview/index.html');
    put('final.mp4');
    expect(await editProgressStep(editDir, 'preview')).toBe(6);
    expect(await editProgressStep(editDir)).toBe(8);
  });
});

// Generated videos (GN5): the Generate run writes its assumptions to edit/project.md before the edit
// has begun, so for a generated job that file alone is not the edit's work.
describe('a generated job (Generated videos)', () => {
  it('does not take project.md alone, nor the Generate folder, for work of the edit', async () => {
    put('project.md', '# Assumptions of the Generate run');
    put('generate/plan.json', '{}');
    put('generate/voice.mp3');
    put('generate/shots.json', '{}');

    expect(await hasEditProgress(editDir)).toBe(true);
    expect(await hasEditProgress(editDir, { generated: true })).toBe(false);
    expect(await editProgressStep(editDir, 'final', { generated: true })).toBeNull();
    expect(snapshotHasEditProgress(await scanEditDir(editDir), { generated: true })).toBe(false);
  });

  it('still takes everything that moves the edit past Transcribe, and transcripts, as work', async () => {
    put('project.md', '# Assumptions');
    put('transcripts/voice.json', '{}');
    expect(await hasEditProgress(editDir, { generated: true })).toBe(true);

    rmSync(join(editDir, 'transcripts'), { recursive: true });
    expect(await hasEditProgress(editDir, { generated: true })).toBe(false);
    put('takes_packed.md', '# takes');
    put('edl.json', '{}');
    expect(await hasEditProgress(editDir, { generated: true })).toBe(true);
  });
});
