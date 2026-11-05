// Helpers shared by the tests of the graphics engine (GR1): a harness of the real repository,
// folders, worker and service on a temp inbox, and a stand-in runner the test drives. Not part of
// the server build (see tsconfig.build.json).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphicVariable } from '@studio/shared';
import type { StudioDb } from '../db/database.js';
import { GraphicRepository } from '../db/graphic-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { GraphicFolders, graphicWorkDir } from './graphic-folders.js';
import type { GraphicRunner, GraphicRunOutcome, GraphicRunRequest } from './graphic-run.js';
import { createGraphicService, type GraphicService } from './graphic-service.js';
import { type GraphicEvent, GraphicWorker } from './graphic-worker.js';

/** What a canned graphic says about itself in about.json. */
export interface CannedGraphic {
  name?: string;
  kind?: 'title' | 'lower-third' | 'callout' | 'end-card' | 'other';
  lengthSec?: number;
  variables?: GraphicVariable[];
  when?: string;
  reply?: string;
}

const DEFAULT_VARIABLES: GraphicVariable[] = [{ id: 'name', label: 'Name', default: 'Dana Levy' }];

/** A composition that passes the engine's check for the graphic `id` with `variables`. */
export function cannedComposition(
  id: string,
  variables: readonly GraphicVariable[] = DEFAULT_VARIABLES,
): string {
  const declared = JSON.stringify(
    variables.map((variable) => ({ ...variable, type: 'string' })),
  ).replace(/'/g, '&#39;');
  const fields = variables
    .map(
      (variable) =>
        `    <div class="clip" data-start="0" data-duration="3" data-var-text="${variable.id}">${variable.default}</div>`,
    )
    .join('\n');
  return `<template id="lib-${id}-template">
  <div id="root" data-composition-id="lib-${id}" data-start="0" data-duration="3"
    data-composition-variables='${declared}'>
    <style>
      @font-face { font-family: "Heebo"; src: url("lib/${id}/fonts/Heebo-Bold.ttf"); }
      #root { position: absolute; inset: 0; container-type: size; }
    </style>
${fields}
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" /></svg>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["lib-${id}"] = gsap.timeline({ paused: true });
    </script>
  </div>
</template>
`;
}

/** Writes a graphic that passes the check into `workDir`, as a successful run would leave it. */
export function writeCannedGraphic(
  workDir: string,
  id: string,
  version: number,
  graphic: CannedGraphic = {},
): void {
  const variables = graphic.variables ?? DEFAULT_VARIABLES;
  mkdirSync(join(workDir, 'compositions'), { recursive: true });
  mkdirSync(join(workDir, 'lib', id, 'fonts'), { recursive: true });
  writeFileSync(join(workDir, 'compositions', `lib-${id}.html`), cannedComposition(id, variables));
  writeFileSync(join(workDir, 'lib', id, 'fonts', 'Heebo-Bold.ttf'), `font v${version}`);
  writeFileSync(
    join(workDir, 'about.json'),
    JSON.stringify({
      ...(graphic.name === undefined ? {} : { name: graphic.name }),
      kind: graphic.kind ?? 'lower-third',
      lengthSec: graphic.lengthSec ?? 3,
      variables,
      when: graphic.when ?? 'The first time a person is named on camera.',
      reply: graphic.reply ?? `Made v${version}.`,
    }),
  );
}

/** What a stand-in run does with its request; it answers like a real run's outcome. */
export type RunBehaviour = (
  request: GraphicRunRequest,
  control: RunControl,
) => Promise<GraphicRunOutcome>;

export interface RunControl {
  /** Waits until the test calls `release()` for this run, or the run is aborted. */
  hold(): Promise<void>;
}

/** A run waiting for the test, as `hold()` left it. */
interface HeldRun {
  messageId: string;
  release: () => void;
}

/**
 * The stand-in for a graphic run. By default it writes a canned graphic (named after the message
 * when it is the first version) and succeeds; a test replaces `behaviour` for one run, or makes
 * every run wait with `holdAll`, and lets them go with `releaseAll`.
 */
export class ScriptedGraphicRunner implements GraphicRunner {
  readonly kind = 'fake' as const;
  /** Every request the worker made, in order. */
  readonly requests: GraphicRunRequest[] = [];
  /** Runs that started and have not ended. */
  active = 0;
  /** The most runs that were going on at once. */
  peak = 0;
  /** Runs waiting in `hold()`. */
  readonly held: HeldRun[] = [];
  holdAll = false;
  /** Replaces the default behaviour for the next runs (`undefined`: the canned graphic). */
  behaviour: RunBehaviour | undefined;
  /** What the canned graphic says; the version is filled in. */
  canned: (request: GraphicRunRequest) => CannedGraphic = (request) => ({
    ...(request.first ? { name: 'Name on a white pill' } : {}),
    reply: `Made v${request.version}.`,
  });

  releaseAll(): void {
    for (const run of this.held.splice(0)) run.release();
  }

  async run(request: GraphicRunRequest): Promise<GraphicRunOutcome> {
    this.requests.push(request);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      const control: RunControl = {
        hold: () =>
          new Promise<void>((resolve) => {
            const held: HeldRun = { messageId: request.message.id, release: resolve };
            this.held.push(held);
            request.signal.addEventListener(
              'abort',
              () => {
                const at = this.held.indexOf(held);
                if (at >= 0) this.held.splice(at, 1);
                resolve();
              },
              { once: true },
            );
          }),
      };
      if (this.behaviour !== undefined) return await this.behaviour(request, control);
      request.onStep(0);
      if (this.holdAll) await control.hold();
      if (request.signal.aborted) return { ok: false, error: 'Stopped.' };
      request.onStep(1);
      writeCannedGraphic(
        graphicWorkDir(request.graphic.dir),
        request.graphic.id,
        request.version,
        this.canned(request),
      );
      request.onStep(2);
      return { ok: true };
    } finally {
      this.active -= 1;
    }
  }
}

export interface GraphicHarness {
  inbox: string;
  dataDir: string;
  home: string;
  db: StudioDb;
  repo: GraphicRepository;
  folders: GraphicFolders;
  runner: ScriptedGraphicRunner;
  worker: GraphicWorker;
  service: GraphicService;
  /** Everything published, in order. */
  events: GraphicEvent[];
  /** Opened in Finder, in order. */
  opened: string[];
  /** Stops the worker, closes the database and removes the temp folders. */
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  usedIn?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  /** Makes the stand-in runner hold every run until `releaseAll()`. */
  holdAll?: boolean;
  openFolder?: (path: string) => Promise<void>;
}

/**
 * The real repository (in memory), folders (a temp inbox, data folder and home), worker and
 * service, around a {@link ScriptedGraphicRunner}. The worker is started.
 */
export function makeHarness(options: HarnessOptions = {}): GraphicHarness {
  const root = mkdtempSync(join(tmpdir(), 'studio-graphics-'));
  const inbox = join(root, 'inbox');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  for (const dir of [inbox, dataDir, join(home, '.Trash')]) mkdirSync(dir, { recursive: true });

  const db = memoryDb();
  const repo = new GraphicRepository(db);
  const folders = new GraphicFolders({ inboxPath: inbox, dataDir, home });
  const runner = new ScriptedGraphicRunner();
  runner.holdAll = options.holdAll ?? false;
  const events: GraphicEvent[] = [];
  const opened: string[] = [];
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const publish = (event: GraphicEvent): void => {
    events.push(event);
  };
  const worker = new GraphicWorker({
    repo,
    folders,
    runner,
    publish,
    logger,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const service = createGraphicService({
    repo,
    folders,
    worker,
    publish,
    usedIn: options.usedIn ?? false,
    openFolder:
      options.openFolder ??
      (async (path) => {
        opened.push(path);
      }),
    logger,
  });
  worker.start();
  return {
    inbox,
    dataDir,
    home,
    db,
    repo,
    folders,
    runner,
    worker,
    service,
    events,
    opened,
    async cleanup() {
      runner.releaseAll();
      await worker.stop();
      if (db.sqlite.open) db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A file as an upload leaves it in a staging folder. */
export function stagedFile(
  stagingDir: string,
  name: string,
  content = name,
  index = 0,
): { name: string; path: string; size: number } {
  const path = join(stagingDir, String(index));
  writeFileSync(path, content);
  return { name, path, size: Buffer.byteLength(content) };
}
