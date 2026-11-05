import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fontsListResponseSchema, type ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { FIXTURE_FONTS } from './fonts/font-test-utils.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { createBuiltInLuts } from './luts/lut-builtin.js';
import { cubeText, invert, writeFakeSkill } from './luts/lut-test-utils.js';
import type { RunContext, Runner } from './pipeline/runner.js';
import { makeTempDir, withoutLutStills } from './test-temp.js';

// FN15: a font named in a note reaches the run (`withFontRefs`), only while the Fonts switch and
// the fontsInNotes switch are both on. FN16: a name the library does not have is written down as a
// request (the Fonts page's banner) and the browsers are told, without the job waiting. The real inbox side runs on a temp inbox with a `_Fonts`
// folder filled from fixtures/fonts/; the runner is a stand-in that records the context it is given.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-fonts-notes-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
}

const idleInbox: EngineOptions['startInbox'] = async (): Promise<RunningInbox> => ({
  watcher: {} as InboxWatcher,
  summary: {
    created: 0,
    changed: 0,
    removed: 0,
    settled: 0,
    failedMissingExport: 0,
    failedMissingPreview: 0,
    failedFolderRemoved: 0,
    resuming: 0,
    unchanged: 0,
  },
  stop: async () => {},
});

const OUTFIT_BOLD = 'English only/Outfit/Outfit-Bold.ttf';
const SECULAR = 'Hebrew + English/Secular One/SecularOne-Regular.ttf';
const CUBE = cubeText(5, invert);

/** Boots an engine over a temp inbox with two fonts in `_Fonts`, and edits one job with `note`. */
async function editOneJob(env: Record<string, string>, note: string) {
  const config = tempConfig(env);
  const skillDir = writeFakeSkill(join(config.inboxPath, '..', 'skill'));
  for (const [rel, fixture] of [
    [OUTFIT_BOLD, 'Outfit-Bold.ttf'],
    [SECULAR, 'SecularOne-Regular.ttf'],
  ] as const) {
    const target = join(config.inboxPath, '_Fonts', ...rel.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(join(FIXTURE_FONTS, fixture)));
  }
  const given: (RunContext | undefined)[] = [];
  const runner: Runner = {
    async start(_job, _mode, context) {
      given.push(context);
      return { ok: true, preview: SAMPLE_PREVIEW };
    },
  };
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    startInbox: idleInbox,
    createRunner: () => runner,
    // The fake skill has built-in LUTs: their stills are not what is under test.
    builtInLuts: withoutLutStills(createBuiltInLuts({ skillDir, dataDir: config.dataDir })),
  });
  engines.push(engine);
  const events: ServerEvent[] = [];
  engine.bus.subscribe((event) => events.push(event));
  mkdirSync(join(config.inboxPath, '_LUTs'), { recursive: true });
  writeFileSync(join(config.inboxPath, '_LUTs', 'Golden Hour Warm.cube'), CUBE);
  engine.lutsRepo.create({
    name: 'Golden Hour Warm',
    kind: 'look',
    size: 5,
    file: 'Golden Hour Warm.cube',
    bytes: CUBE.length,
    sha256: 'a'.repeat(64),
    sourceName: 'Golden Hour Warm.cube',
  });
  await engine.start();

  mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
  const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
  engine.jobs.setNote(job.id, note);
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.worker?.notify();
  await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'));
  return { engine, job, given, events };
}

const NOTE = 'Captions in @Outfit Bold and the titles in @Secular One, not @Gotham Bold';
const BOTH_ON = { STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '1' };

describe('a font named in a note (STUDIO_FONTS_IN_NOTES)', () => {
  it('on the defaults (both switches on): the run is told the fonts, their use is counted, and the job finishes', async () => {
    // No switch is set: Fonts has been on since FN11 and fontsInNotes since FN23.
    const { engine, job, given } = await editOneJob({}, NOTE);

    expect(given[0]?.libraryRefs).toEqual({
      luts: [],
      graphics: [],
      missing: [],
      fonts: [
        {
          face: 'Outfit Bold',
          family: 'Outfit',
          weight: 700,
          italic: false,
          path: `edit/fonts/${OUTFIT_BOLD}`,
          he: false,
        },
        {
          face: 'Secular One',
          family: 'Secular One',
          weight: 400,
          italic: false,
          path: `edit/fonts/${SECULAR}`,
          he: true,
        },
      ],
      unresolvedFonts: ['Gotham Bold'],
      // The LUT switches are on by default too (LU14): the footage is looked at, nothing is log.
      camera: { curves: [], byNote: false },
    });
    expect(engine.fontsRepo.usedCount('Outfit')).toBe(1);
    expect(engine.fontsRepo.usedCount('Secular One')).toBe(1);
    expect(engine.jobs.get(job.id)?.state).toBe('review');
  });

  it('a name the library does not have is a request, once, and the banner list names the job', async () => {
    const { engine, job, events } = await editOneJob(BOTH_ON, NOTE);

    // The job did not wait and did not fail (it reached review); the request is written down.
    expect(engine.jobs.get(job.id)?.state).toBe('review');
    expect(engine.fontsRepo.openRequests(0).map((one) => [one.name, one.jobId, one.round])).toEqual(
      [['Gotham Bold', job.id, 0]],
    );
    expect(events.filter((event) => event.type === 'font.requested')).toEqual([
      { type: 'font.requested', name: 'Gotham Bold' },
    ]);
    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );
    expect(list.requests.map((one) => [one.name, one.jobName, one.round])).toEqual([
      ['Gotham Bold', 'Acme · Spring', 0],
    ]);
  });

  it('"Not a font" on that request empties the banner list, tells the browsers, and the word is not asked again for the job (C52)', async () => {
    const { engine, job, events } = await editOneJob(BOTH_ON, NOTE);
    const [request] = engine.fontsRepo.openRequests(0);

    const res = await engine.app.request(`/api/fonts/requests/${request?.id}`, {
      method: 'DELETE',
    });

    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(events.filter((event) => event.type === 'font.request.dismissed')).toEqual([
      { type: 'font.request.dismissed', id: request?.id },
    ]);
    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );
    expect(list.requests).toEqual([]);
    // A later round of the same job that keeps the word does not bring the bar back.
    expect(engine.fontsRepo.recordRequest('Gotham Bold', job.id, 1).added).toBe(false);
    expect(engine.fontsRepo.openRequests(0)).toEqual([]);
  });

  it('a note whose fonts are all there makes no request', async () => {
    const { engine, events } = await editOneJob(BOTH_ON, 'Captions in @Outfit Bold');

    expect(engine.fontsRepo.openRequests(0)).toEqual([]);
    expect(events.filter((event) => event.type === 'font.requested')).toEqual([]);
  });

  it('the notes switch off (STUDIO_FONTS_IN_NOTES=0) leaves a note as plain text', async () => {
    const { engine, given, events } = await editOneJob(
      { STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '0', STUDIO_LUTS_IN_EDITS: '0' },
      NOTE,
    );

    expect(given[0]?.libraryRefs).toBeUndefined();
    expect(engine.fontsRepo.usedCount('Outfit')).toBe(0);
    // ... and a name the library lacks is no request and no banner.
    expect(engine.fontsRepo.openRequests(0)).toEqual([]);
    expect(events.filter((event) => event.type === 'font.requested')).toEqual([]);
  });

  it('the fontsInNotes switch (on by default) with the Fonts page off leaves a note as plain text', async () => {
    const { engine, given } = await editOneJob(
      { STUDIO_FONTS: '0', STUDIO_LUTS_IN_EDITS: '0' },
      NOTE,
    );

    expect(given[0]?.libraryRefs).toBeUndefined();
    expect(engine.fontsRepo.usedCount('Outfit')).toBe(0);
    expect(engine.fontsRepo.openRequests(0)).toEqual([]);
  });

  it('a note that names nothing gives the run the context it always had', async () => {
    const { given } = await editOneJob(
      { ...BOTH_ON, STUDIO_LUTS_IN_EDITS: '0' },
      'Keep it under 30 seconds',
    );

    expect(given[0]).toBeDefined();
    expect(given[0]?.libraryRefs).toBeUndefined();
  });

  it('with the LUT switches on too, one context carries the LUT and the font', async () => {
    const { engine, given } = await editOneJob(
      { ...BOTH_ON, STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' },
      'Warm it up with @luts/golden-hour-warm, captions in @Outfit Bold',
    );

    expect(given[0]?.libraryRefs?.luts.map((lut) => lut.slug)).toEqual(['golden-hour-warm']);
    expect(given[0]?.libraryRefs?.fonts?.map((font) => font.face)).toEqual(['Outfit Bold']);
    expect(engine.fontsRepo.usedCount('Outfit')).toBe(1);
  });
});
