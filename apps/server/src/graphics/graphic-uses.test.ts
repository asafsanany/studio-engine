import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GraphicChangedEvent, Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { GraphicRepository } from '../db/graphic-repository.js';
import { fakeClock, memoryDb, rawRow } from '../db/test-utils.js';
import { makeJob } from '../events/test-utils.js';
import type { RunContext, Runner, RunOutcome } from '../pipeline/runner.js';
import { graphicDir, graphicVersionDir } from './graphic-folders.js';
import {
  copyVersion,
  EDIT_GRAPHICS_DIR,
  recordGraphicUses,
  scanGraphicMounts,
  withGraphicUses,
} from './graphic-uses.js';

// "Used in" (GR9): the scan of an edit's compositions for the library graphics they mount, the
// version told from the edit's copy, the rows and events it leaves, and the hook after a run.
// Real files in a temp inbox, a real repository on an in-memory database.

const PILL = 'a1b2c3d4e5f6';
const TITLE = '0123456789ab';
const LOGO = 'abcdefabcdef';

let root: string;
let db: StudioDb;
let repo: GraphicRepository;
let events: GraphicChangedEvent[];
const warn = vi.fn();
const logger = { info: vi.fn(), warn, error: vi.fn() };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-graphic-uses-'));
  db = memoryDb();
  repo = new GraphicRepository(db, { clock: fakeClock() });
  events = [];
  warn.mockClear();
});

afterEach(async () => {
  if (db.sqlite.open) db.close();
  await rm(root, { recursive: true, force: true });
});

const inbox = () => join(root, 'inbox');
const jobDir = (name = 'Spring') => join(inbox(), 'Acme', name);
const editDir = (name?: string) => join(jobDir(name), 'edit');

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** The composition of a graphic at a version: it says which version it is. */
function composition(id: string, version: number): string {
  return `<template id="lib-${id}"><div data-composition-id="lib-${id}">v${version}</div></template>`;
}

/** A version folder of the library, as the worker leaves it: the graphic, its font and its answer. */
async function makeVersion(
  folder: string,
  id: string,
  version: number,
  { same }: { same?: number } = {},
): Promise<string> {
  const dir = graphicVersionDir(graphicDir(inbox(), folder), version);
  const shown = same ?? version;
  await put(join(dir, 'compositions', `lib-${id}.html`), composition(id, shown));
  await put(join(dir, 'lib', id, 'fonts', 'Heebo.woff2'), `font of v${shown}`);
  await put(join(dir, 'about.json'), JSON.stringify({ reply: `Made v${version}.` }));
  await put(join(dir, 'index.html'), '<html></html>');
  return dir;
}

/** A graphic in the library whose versions 1..`current` are on disk; v`same[n]` repeats an older one. */
async function makeGraphic(
  id: string,
  name: string,
  current: number,
  repeats: Record<number, number> = {},
): Promise<void> {
  repo.create({ id, name });
  for (let version = 1; version <= current; version += 1) {
    await makeVersion(name, id, version, { same: repeats[version] });
  }
  repo.setVersion(id, { version: current });
}

/** What the Brief step does: a whole version folder, copied into the edit. */
async function copyIntoEdit(
  id: string,
  folder: string,
  version: number,
  name?: string,
): Promise<void> {
  await cp(
    graphicVersionDir(graphicDir(inbox(), folder), version),
    join(editDir(name), EDIT_GRAPHICS_DIR, id),
    { recursive: true },
  );
}

const mount = (id: string) =>
  `<div data-composition-id="x" data-composition-src="compositions/lib-${id}.html"></div>`;

async function writeMounts(ids: string[], file = 'preview/index.html', name?: string) {
  await put(join(editDir(name), file), `<html>${ids.map(mount).join('\n')}</html>`);
}

function record(job: Pick<Job, 'id'> = { id: 'job000000001' }, name?: string) {
  return recordGraphicUses(
    { repo, inboxPath: inbox(), publish: (event) => events.push(event), logger },
    job,
    jobDir(name),
  );
}

/** The `graphic_uses` rows as [graphic, job, version], by graphic and then job. */
const useRows = () =>
  (rawRow(db, 'graphic_uses') as { graphic_id: string; job_id: string; version: number }[])
    .map((row) => [row.graphic_id, row.job_id, row.version] as const)
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

describe('scanGraphicMounts', () => {
  it('finds nothing in an edit with no compositions, or none that mount a graphic', async () => {
    expect(await scanGraphicMounts(editDir())).toEqual([]);
    await put(join(editDir(), 'preview', 'index.html'), '<html>own work</html>');
    await put(join(editDir(), 'animations', 'title', 'index.html'), '<html>a title</html>');
    expect(await scanGraphicMounts(editDir())).toEqual([]);
  });

  it('finds the one graphic a preview mounts', async () => {
    await writeMounts([PILL]);
    expect(await scanGraphicMounts(editDir())).toEqual([PILL]);
  });

  it('finds two graphics, in the preview and in the animations, sorted', async () => {
    await writeMounts([PILL]);
    await writeMounts([LOGO, TITLE], 'animations/end/index.html');
    expect(await scanGraphicMounts(editDir())).toEqual([TITLE, PILL, LOGO]);
  });

  it('counts a graphic mounted twice, in one file and in two, once', async () => {
    await writeMounts([PILL, PILL]);
    await writeMounts([PILL], 'preview/compositions/outro.html');
    await writeMounts([PILL], 'animations/a/index.html');
    expect(await scanGraphicMounts(editDir())).toEqual([PILL]);
  });

  it('finds a mount however the path is written', async () => {
    await put(
      join(editDir(), 'preview', 'compositions', 'scene.html'),
      `<div data-composition-src="../compositions/lib-${PILL}.html"></div>
       <div data-composition-src='./compositions/lib-${TITLE}.html'></div>`,
    );
    expect(await scanGraphicMounts(editDir())).toEqual([TITLE, PILL]);
  });

  it('does not count a copy of the graphic nobody mounts, nor the graphic’s own file', async () => {
    await put(
      join(editDir(), 'preview', 'compositions', `lib-${PILL}.html`),
      `<template>/* compositions/lib-${PILL}.html */</template>`,
    );
    expect(await scanGraphicMounts(editDir())).toEqual([]);
  });

  it('looks only at the preview and the animations, and only at HTML', async () => {
    await writeMounts([PILL], 'graphics/anything.html');
    await writeMounts([PILL], 'brief.html');
    await put(join(editDir(), 'preview', 'notes.md'), mount(PILL));
    await put(join(editDir(), 'preview', 'main.js'), mount(PILL));
    await writeMounts([PILL], 'preview/node_modules/pkg/index.html');
    await writeMounts([PILL], 'preview/.cache/index.html');
    expect(await scanGraphicMounts(editDir())).toEqual([]);
  });

  it('takes only twelve lowercase hex characters for an id', async () => {
    await put(
      join(editDir(), 'preview', 'index.html'),
      [
        'compositions/lib-a1b2c3d4e5f.html',
        'compositions/lib-A1B2C3D4E5F6.html',
        'compositions/lib-a1b2c3d4e5f67.html',
        'compositions/lib-name.html',
      ].join('\n'),
    );
    expect(await scanGraphicMounts(editDir())).toEqual([]);
  });
});

describe('copyVersion', () => {
  it('tells the version whose files the copy has, not the newest', async () => {
    await makeGraphic(PILL, 'Pill', 3);
    await copyIntoEdit(PILL, 'Pill', 2);

    const told = await copyVersion(
      join(editDir(), EDIT_GRAPHICS_DIR, PILL),
      graphicDir(inbox(), 'Pill'),
      PILL,
      3,
    );

    expect(told).toEqual({ version: 2, guessed: false });
  });

  it('prefers the current version when an older one is the same graphic (a version used again)', async () => {
    await makeGraphic(PILL, 'Pill', 3, { 3: 1 });
    await copyIntoEdit(PILL, 'Pill', 1);
    const copy = join(editDir(), EDIT_GRAPHICS_DIR, PILL);

    expect((await copyVersion(copy, graphicDir(inbox(), 'Pill'), PILL, 3))?.version).toBe(3);
    expect((await copyVersion(copy, graphicDir(inbox(), 'Pill'), PILL, 2))?.version).toBe(3);
  });

  it('sees a changed asset as another version', async () => {
    await makeGraphic(PILL, 'Pill', 2);
    await put(
      join(graphicVersionDir(graphicDir(inbox(), 'Pill'), 2), 'compositions', `lib-${PILL}.html`),
      composition(PILL, 1),
    );
    await copyIntoEdit(PILL, 'Pill', 1);

    const told = await copyVersion(
      join(editDir(), EDIT_GRAPHICS_DIR, PILL),
      graphicDir(inbox(), 'Pill'),
      PILL,
      2,
    );

    // the same composition, but v2 has v2's font: only v1 has the copy's
    expect(told).toEqual({ version: 1, guessed: false });
  });

  it('is not put off by hidden files or by what the copy has besides the graphic', async () => {
    await makeGraphic(PILL, 'Pill', 2);
    await copyIntoEdit(PILL, 'Pill', 1);
    const copy = join(editDir(), EDIT_GRAPHICS_DIR, PILL);
    await put(join(copy, '.DS_Store'), 'finder');
    await put(join(copy, 'lib', PILL, '.DS_Store'), 'finder');
    await put(join(copy, 'copied.json'), '{}');

    expect(await copyVersion(copy, graphicDir(inbox(), 'Pill'), PILL, 2)).toEqual({
      version: 1,
      guessed: false,
    });
  });

  it('says the current version, guessed, when no version has the copy’s files', async () => {
    await makeGraphic(PILL, 'Pill', 2);
    await copyIntoEdit(PILL, 'Pill', 2);
    const copy = join(editDir(), EDIT_GRAPHICS_DIR, PILL);
    await put(join(copy, 'compositions', `lib-${PILL}.html`), 'edited by hand');

    expect(await copyVersion(copy, graphicDir(inbox(), 'Pill'), PILL, 2)).toEqual({
      version: 2,
      guessed: true,
    });
  });

  it('says the current version, guessed, when the library has no versions folder any more', async () => {
    await makeGraphic(PILL, 'Pill', 2);
    await copyIntoEdit(PILL, 'Pill', 2);
    await rm(join(graphicDir(inbox(), 'Pill'), 'versions'), { recursive: true });

    expect(
      await copyVersion(
        join(editDir(), EDIT_GRAPHICS_DIR, PILL),
        graphicDir(inbox(), 'Pill'),
        PILL,
        2,
      ),
    ).toEqual({ version: 2, guessed: true });
  });

  it('says nothing for a folder that holds no copy of the graphic', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    expect(
      await copyVersion(
        join(editDir(), EDIT_GRAPHICS_DIR, PILL),
        graphicDir(inbox(), 'Pill'),
        PILL,
        1,
      ),
    ).toBeNull();
    await put(join(editDir(), EDIT_GRAPHICS_DIR, PILL, 'about.json'), '{}');
    expect(
      await copyVersion(
        join(editDir(), EDIT_GRAPHICS_DIR, PILL),
        graphicDir(inbox(), 'Pill'),
        PILL,
        1,
      ),
    ).toBeNull();
  });
});

describe('recordGraphicUses', () => {
  it('records nothing for an edit that mounts no graphic', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await put(join(editDir(), 'preview', 'index.html'), '<html></html>');

    expect(await record()).toEqual([]);

    expect(useRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('records nothing for a job that has no edit folder yet', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    expect(await record()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('records one graphic at the version of the edit’s copy, and tells the browsers how many videos', async () => {
    await makeGraphic(PILL, 'Pill', 3);
    await copyIntoEdit(PILL, 'Pill', 2);
    await writeMounts([PILL]);

    const recorded = await record();

    expect(recorded).toEqual([{ graphicId: PILL, version: 2, guessed: false }]);
    expect(useRows()).toEqual([[PILL, 'job000000001', 2]]);
    expect(events).toEqual([{ type: 'graphic.changed', graphic: repo.summary(PILL), usedIn: 1 }]);
    expect(repo.detail(PILL, { usedIn: true })?.usedIn).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records two graphics, each with its own version and event', async () => {
    await makeGraphic(PILL, 'Pill', 2);
    await makeGraphic(TITLE, 'Title', 1);
    await copyIntoEdit(PILL, 'Pill', 1);
    await copyIntoEdit(TITLE, 'Title', 1);
    await writeMounts([PILL]);
    await writeMounts([TITLE], 'animations/intro/index.html');

    await record();

    expect(useRows()).toEqual([
      [TITLE, 'job000000001', 1],
      [PILL, 'job000000001', 1],
    ]);
    expect(events.map((event) => [event.graphic.id, event.usedIn])).toEqual([
      [TITLE, 1],
      [PILL, 1],
    ]);
  });

  it('records a graphic mounted twice once', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await copyIntoEdit(PILL, 'Pill', 1);
    await writeMounts([PILL, PILL]);
    await writeMounts([PILL], 'animations/end/index.html');

    const recorded = await record();

    expect(recorded).toHaveLength(1);
    expect(useRows()).toEqual([[PILL, 'job000000001', 1]]);
    expect(events).toHaveLength(1);
    expect(repo.usesCount(PILL)).toBe(1);
  });

  it('counts each video once, however many runs it had, and adds to it after a revise', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await makeGraphic(TITLE, 'Title', 1);
    await copyIntoEdit(PILL, 'Pill', 1);
    await copyIntoEdit(TITLE, 'Title', 1);
    await writeMounts([PILL]);
    await record();
    // another video used the Pill too
    repo.addUse(PILL, 'job000000002', 1);
    events.length = 0;

    // the revise run: the edit now mounts the Title as well, and keeps the Pill
    await writeMounts([PILL, TITLE]);
    await record();

    expect(useRows()).toEqual([
      [TITLE, 'job000000001', 1],
      [PILL, 'job000000001', 1],
      [PILL, 'job000000002', 1],
    ]);
    expect(repo.usesCount(PILL)).toBe(2);
    expect(repo.usesCount(TITLE)).toBe(1);
    expect(events.map((event) => [event.graphic.id, event.usedIn])).toEqual([
      [TITLE, 1],
      [PILL, 2],
    ]);
  });

  it('keeps the version the edit was made from when the graphic has changed since', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await copyIntoEdit(PILL, 'Pill', 1);
    await writeMounts([PILL]);
    await record();

    // The owner changes the graphic while the video is in Review; the revise run keeps the old copy
    await makeVersion('Pill', PILL, 2);
    repo.setVersion(PILL, { version: 2 });
    await record();

    expect(useRows()).toEqual([[PILL, 'job000000001', 1]]);
  });

  it('takes the version of a later edit run, which copies the library again', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await copyIntoEdit(PILL, 'Pill', 1);
    await writeMounts([PILL]);
    await record();

    await makeVersion('Pill', PILL, 2);
    repo.setVersion(PILL, { version: 2 });
    await rm(join(editDir(), EDIT_GRAPHICS_DIR), { recursive: true });
    await copyIntoEdit(PILL, 'Pill', 2);
    await record();

    expect(useRows()).toEqual([[PILL, 'job000000001', 2]]);
    expect(repo.usesCount(PILL)).toBe(1);
  });

  it('skips a graphic that is not in the library, one that was deleted, and one the edit has no copy of', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await makeGraphic(TITLE, 'Title', 1);
    await copyIntoEdit(TITLE, 'Title', 1);
    repo.softDelete(TITLE);
    await writeMounts([PILL, TITLE, LOGO]);

    expect(await record()).toEqual([]);

    expect(useRows()).toEqual([]);
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ graphicId: PILL });
  });

  it('records the current version, and says so, when no version matches the copy', async () => {
    await makeGraphic(PILL, 'Pill', 2);
    await copyIntoEdit(PILL, 'Pill', 2);
    await put(
      join(editDir(), EDIT_GRAPHICS_DIR, PILL, 'compositions', `lib-${PILL}.html`),
      'edited',
    );
    await writeMounts([PILL]);

    expect(await record()).toEqual([{ graphicId: PILL, version: 2, guessed: true }]);

    expect(useRows()).toEqual([[PILL, 'job000000001', 2]]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('goes on with the other graphics when one cannot be recorded', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await makeGraphic(TITLE, 'Title', 1);
    await copyIntoEdit(PILL, 'Pill', 1);
    await copyIntoEdit(TITLE, 'Title', 1);
    await writeMounts([PILL, TITLE]);
    const real = repo.addUse.bind(repo);
    vi.spyOn(repo, 'addUse').mockImplementation((graphicId, ...rest) => {
      if (graphicId === TITLE) throw new Error('disk full');
      real(graphicId, ...rest);
    });

    const recorded = await record();

    expect(recorded.map((use) => use.graphicId)).toEqual([PILL]);
    expect(useRows()).toEqual([[PILL, 'job000000001', 1]]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ graphicId: TITLE }),
      'could not record a graphic use',
    );
  });

  it('finds the job folder it is given, whatever it is called', async () => {
    await makeGraphic(PILL, 'Pill', 1);
    await copyIntoEdit(PILL, 'Pill', 1, 'Summer');
    await writeMounts([PILL], 'preview/index.html', 'Summer');

    expect(await record({ id: 'job000000009' }, 'Summer')).toHaveLength(1);

    expect(useRows()).toEqual([[PILL, 'job000000009', 1]]);
  });
});

describe('withGraphicUses', () => {
  const OK: RunOutcome = { ok: true };
  const CONTEXT = { signal: new AbortController().signal, progress: () => {} } as RunContext;

  function run(
    outcome: RunOutcome | Error,
    job: Job,
    recorder = vi.fn(async (_job: Job): Promise<void> => {}),
  ) {
    const inner: Runner = {
      start: vi.fn(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }),
    };
    const wrapped = withGraphicUses(inner, recorder, logger);
    return { inner, recorder, result: wrapped.start(job, 'start', CONTEXT) };
  }

  it.each(['edit', 'revise'] as const)(
    'records the graphics after a successful %s run',
    async (kind) => {
      const job = makeJob({ runKind: kind });
      const { inner, recorder, result } = run(OK, job);

      expect(await result).toEqual(OK);

      expect(inner.start).toHaveBeenCalledWith(job, 'start', CONTEXT);
      expect(recorder).toHaveBeenCalledWith(job);
    },
  );

  it('passes the preview a run reports through unchanged', async () => {
    const outcome: RunOutcome = {
      ok: true,
      preview: { durationSec: 12, width: 1080, height: 1920 },
    };
    expect(await run(outcome, makeJob()).result).toBe(outcome);
  });

  it('records nothing after a render run, a failed run or a run that threw', async () => {
    const render = run(OK, makeJob({ runKind: 'render' }));
    expect(await render.result).toEqual(OK);
    expect(render.recorder).not.toHaveBeenCalled();

    const failed: RunOutcome = { ok: false, error: 'It broke.', step: 4 };
    const bad = run(failed, makeJob());
    expect(await bad.result).toEqual(failed);
    expect(bad.recorder).not.toHaveBeenCalled();

    const threw = run(new Error('spawn failed'), makeJob());
    await expect(threw.result).rejects.toThrow('spawn failed');
    expect(threw.recorder).not.toHaveBeenCalled();
  });

  it('leaves the run’s outcome alone when recording fails', async () => {
    const recorder = vi.fn(async (_job: Job): Promise<void> => {
      throw new Error('database is locked');
    });
    const { result } = run(OK, makeJob(), recorder);

    expect(await result).toEqual(OK);

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'a1b2c3d4e5f6' }),
      'could not record the graphics the edit used',
    );
  });
});
