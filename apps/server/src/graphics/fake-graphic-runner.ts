// The stand-in graphic run of STUDIO_RUNNER=fake (Graphics plan, "The run"). OWNER: GR2.
//
// It reads nothing and spends nothing. It waits through the three steps (about 1 s each ÷
// STUDIO_FAKE_SPEED, telling onStep 1 and 2 on the way), then copies a canned graphic from
// graphics/testdata/<kind>/ into work/ with the graphic's id put in, so dev, tests and e2e go through
// the same worker, check, versions and events as a real run:
//
//   testdata/<kind>/compositions/lib-0123456789ab.html  → work/compositions/lib-<id>.html
//   testdata/fonts/*.ttf (Heebo, SIL Open Font License) → work/lib/<id>/fonts/
//   testdata/<kind>/about.json                          → work/about.json (name only on v1)
//
// There are 4, each matching the GRGraphic look: lower-third (a name on a white pill), callout (a big
// number that counts up), title (an opening title, word by word) and end-card (a Follow card). v1's
// kind comes from the words of the request, like the GRStudio prototype; a change keeps the kind in
// work/about.json and answers "Made vN: …" in a line. A request with the word "fail" in it fails,
// to test the failed state. An abort (Stop, a delete, the shutdown) ends it at once, with nothing
// written.

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphicAbout, GraphicKind } from '@studio/shared';
import { realSleep, type Sleep } from '../pipeline/fake-runner.js';
import { graphicWorkDir } from './graphic-folders.js';
import type { GraphicRunner, GraphicRunOutcome, GraphicRunRequest } from './graphic-run.js';

/**
 * The canned graphics. tsc doesn't copy testdata/ into dist/, and this path works from src/graphics
 * and dist/graphics alike (as fake-preview.ts finds its sample).
 */
export const GRAPHIC_TESTDATA_DIR = fileURLToPath(
  new URL('../../src/graphics/testdata/', import.meta.url),
);

/** The id the canned graphics are written with; the fake puts the graphic's own id in its place. */
export const GRAPHIC_TESTDATA_ID = '0123456789ab';

/** How long each of the three steps takes at speed 1. */
export const FAKE_GRAPHIC_STEP_MS = 1_000;

/** The kinds the fake has a canned graphic for. */
export const FAKE_GRAPHIC_KINDS = ['lower-third', 'callout', 'title', 'end-card'] as const;
export type FakeGraphicKind = (typeof FAKE_GRAPHIC_KINDS)[number];

/** The error of a request that asks to fail. */
export const FAKE_GRAPHIC_FAILURE =
  'The stand-in run failed, as the message asked (it said “fail”).';

/** The error of a run that was stopped. */
export const FAKE_GRAPHIC_STOPPED = 'The run was stopped.';

/** The kind a request asks for, from its words, as the GRStudio prototype decides it. */
export function fakeGraphicKind(text: string): FakeGraphicKind {
  const words = text.toLowerCase();
  if (/count|number|price|מספר|מחיר|hours/.test(words)) return 'callout';
  if (/title|opening|כותרת|פתיחה/.test(words)) return 'title';
  if (/end card|follow|עקב/.test(words)) return 'end-card';
  return 'lower-third';
}

function isFakeKind(kind: GraphicKind | undefined): kind is FakeGraphicKind {
  return (FAKE_GRAPHIC_KINDS as readonly string[]).includes(kind ?? '');
}

/** The kind of the version in work/ (a change), or null when work/ has no readable about.json. */
async function kindInWork(workDir: string): Promise<FakeGraphicKind | null> {
  try {
    const about = JSON.parse(await readFile(join(workDir, 'about.json'), 'utf8')) as {
      kind?: GraphicKind;
    };
    return isFakeKind(about.kind) ? about.kind : null;
  } catch {
    return null;
  }
}

/** Every canned text file with the testdata id swapped for the graphic's. */
function withId(text: string, id: string): string {
  return text.replaceAll(GRAPHIC_TESTDATA_ID, id);
}

export interface FakeGraphicRunnerOptions {
  /** How much faster than real time the steps go (STUDIO_FAKE_SPEED). Default 1. */
  speed?: number;
  /** The wait between steps. Replaced in tests. */
  sleep?: Sleep;
}

/** The fake graphic run. OWNER: GR2. */
export class FakeGraphicRunner implements GraphicRunner {
  readonly kind = 'fake' as const;
  readonly speed: number;
  private readonly sleep: Sleep;

  constructor(options: FakeGraphicRunnerOptions = {}) {
    this.speed = options.speed ?? 1;
    this.sleep = options.sleep ?? realSleep;
  }

  async run(request: GraphicRunRequest): Promise<GraphicRunOutcome> {
    const { signal } = request;
    const stepMs = FAKE_GRAPHIC_STEP_MS / this.speed;
    const stopped: GraphicRunOutcome = { ok: false, error: FAKE_GRAPHIC_STOPPED };

    for (const step of [1, 2] as const) {
      await this.sleep(stepMs, signal);
      if (signal.aborted) return stopped;
      request.onStep(step);
    }
    await this.sleep(stepMs, signal);
    if (signal.aborted) return stopped;
    if (/\bfail\b/i.test(request.message.text)) return { ok: false, error: FAKE_GRAPHIC_FAILURE };

    const workDir = graphicWorkDir(request.graphic.dir);
    const kind =
      (request.first ? null : await kindInWork(workDir)) ??
      fakeGraphicKind(request.first ? request.message.text : firstRequest(request));
    await this.writeCanned(workDir, request.graphic.id, kind, request);
    return { ok: true };
  }

  private async writeCanned(
    workDir: string,
    id: string,
    kind: FakeGraphicKind,
    request: GraphicRunRequest,
  ): Promise<void> {
    await writeFakeGraphicFiles(workDir, id, kind, {
      first: request.first,
      reply: `Made v${request.version}: ${changeLine(request.message.text)}`,
    });
  }
}

/**
 * Writes a canned graphic into `workDir` the way the fake run does: the composition, the fonts and
 * about.json, with the graphic's id put in. `first` keeps the canned name and reply (v1); a change
 * drops the name and answers `reply`. The dev seed (`pnpm seed:canvas --graphics`) uses it to give
 * its graphics real versions.
 */
export async function writeFakeGraphicFiles(
  workDir: string,
  id: string,
  kind: FakeGraphicKind,
  { first, reply }: { first: boolean; reply: string },
): Promise<void> {
  const source = join(GRAPHIC_TESTDATA_DIR, kind);
  const composition = await readFile(
    join(source, 'compositions', `lib-${GRAPHIC_TESTDATA_ID}.html`),
    'utf8',
  );
  await mkdir(join(workDir, 'compositions'), { recursive: true });
  await writeFile(join(workDir, 'compositions', `lib-${id}.html`), withId(composition, id));

  const fontsDir = join(workDir, 'lib', id, 'fonts');
  await mkdir(fontsDir, { recursive: true });
  const fonts = join(GRAPHIC_TESTDATA_DIR, 'fonts');
  for (const font of await readdir(fonts)) {
    if (font.endsWith('.ttf')) await cp(join(fonts, font), join(fontsDir, font));
  }

  const canned = JSON.parse(
    withId(await readFile(join(source, 'about.json'), 'utf8'), id),
  ) as GraphicAbout;
  const { name, ...rest } = canned;
  if (first && name === undefined) throw new Error(`testdata/${kind}/about.json has no name`);
  const about: GraphicAbout = first ? canned : { ...rest, reply };
  await writeFile(join(workDir, 'about.json'), `${JSON.stringify(about, null, 2)}\n`);
}

/** The words of the first message of the chat, for a change whose work/ has no about.json. */
function firstRequest(request: GraphicRunRequest): string {
  return (
    request.conversation.find((message) => message.role === 'you')?.text ?? request.message.text
  );
}

/** What a change's reply says it did, in one line (the fake keeps the canned look as it is). */
function changeLine(text: string): string {
  const asked = text.replace(/\s+/g, ' ').trim();
  const shown = asked.length > 120 ? `${asked.slice(0, 119)}…` : asked;
  return shown === ''
    ? 'this stand-in run keeps the graphic as it was.'
    : `this stand-in run keeps the graphic as it was, for “${shown}”.`;
}
