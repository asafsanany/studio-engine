import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  type Job,
  type JobOutput,
  type ReviewNote,
  SERIES_MESSAGES,
  SERIES_UNDO_MS,
  SETTLE_MS,
} from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClientStyleRepository,
  JobRepository,
  SeriesRepository,
  type StudioDb,
} from '../db/index.js';
import { type FakeClock, fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import { FAIL_SERIES_MARKER, FakeStyleRunner } from './fake-style.js';
import {
  historyFileFor,
  historyKitDirFor,
  historySourceFileFor,
  seriesHistoryDirFor,
  seriesHistoryFileFor,
  seriesHistoryKitDirFor,
} from './paths.js';
import { createSeriesNotes } from './series-notes.js';
import {
  createSeriesService,
  SERIES_BAD_FILES,
  type SeriesChange,
  type SeriesService,
} from './series-service.js';
import { seriesStartFileFor } from './style-history.js';
import { createLearnOnReady, createLearnWait } from './style-learn.js';
import type {
  SeriesRunner,
  SeriesRunRequest,
  StyleRunner,
  StyleRunOutcome,
  StyleRunRequest,
} from './style-run.js';
import { NO_SERIES_RUNNER, NOTHING_TO_RERUN_SERIES, StyleWorker } from './style-worker.js';

// Series passes on the client's style queue (Series plan §3, CVP-178 K2): the real series service
// and style worker on the real repositories (in memory), a temp inbox and data folder, and the fake
// runner, which a gate can hold so a test can act while a pass runs. File trees are compared byte
// for byte.

const KOVA = 'Kova Coffee';
const ARC = 'Arc Fitness';
const KOVA_ID = clientIdFor(KOVA);

const OUTPUT: JobOutput = {
  fileName: 'x.mp4',
  durationSec: 30,
  width: 1080,
  height: 1920,
  sizeBytes: 1,
};

const OLD_STYLE =
  '# Style: Kova Coffee\nLearned from Weekly 5 (2026-10-01).\n## Look\n- Colours: red stamp\n## Kit\n- composition: the stamp\n';

let root: string;
let inboxPath: string;
let dataDir: string;
let db: StudioDb;
let clock: FakeClock;
let jobs: JobRepository;
let seriesRepo: SeriesRepository;
let clientStyles: ClientStyleRepository;
let runner: GatedRunner;
let worker: StyleWorker;
let service: SeriesService;
let changes: SeriesChange[];
let jobChanges: Job[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-series-worker-'));
  inboxPath = join(root, 'inbox');
  dataDir = join(root, 'data');
  db = memoryDb();
  clock = fakeClock();
  jobs = new JobRepository(db, { clock });
  seriesRepo = new SeriesRepository(db, { clock });
  clientStyles = new ClientStyleRepository(db, { clock });
  runner = new GatedRunner();
  changes = [];
  jobChanges = [];
  ({ worker, service } = build());
});

afterEach(async () => {
  runner.release();
  await worker.stop();
  rmSync(root, { recursive: true, force: true });
});

/** A worker and the series service on it, on the shared repositories. */
function build(styleRunner: StyleRunner = runner) {
  const built = new StyleWorker({ clientStyles, inboxPath, dataDir, runner: styleRunner });
  const real = createSeriesService({
    inboxPath,
    jobs,
    seriesRepo,
    clientStyles,
    worker: built,
    onJobChanged: (job) => jobChanges.push(job),
    clock,
  });
  real.onChange((change) => changes.push(change));
  return { worker: built, service: real };
}

/** Holds series runs while `hold` is set (until `release()` or an abort); otherwise the fake run. */
class GatedRunner implements StyleRunner, SeriesRunner {
  readonly fake = new FakeStyleRunner({
    sleep: async () => {},
    clock: () => new Date(2026, 9, 22, 12),
  });
  readonly calls: SeriesRunRequest[] = [];
  readonly script: ((request: SeriesRunRequest) => Promise<StyleRunOutcome>)[] = [];
  hold = false;
  private gates: (() => void)[] = [];

  run(request: StyleRunRequest): Promise<StyleRunOutcome> {
    return this.fake.run(request);
  }

  async runSeries(request: SeriesRunRequest): Promise<StyleRunOutcome> {
    this.calls.push(request);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.gates.push(resolve);
        request.signal.addEventListener('abort', () => resolve());
      });
      if (request.signal.aborted) return { ok: false, error: 'Series stopped: stopped' };
    }
    const step = this.script.shift();
    return step ? step(request) : this.fake.runSeries(request);
  }

  release(): void {
    for (const gate of this.gates.splice(0)) gate();
  }

  /** Waits until `count` series runs have started. */
  async started(count: number): Promise<void> {
    for (let i = 0; i < 200 && this.calls.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(this.calls.length).toBe(count);
  }
}

function write(path: string, text = 'x'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const clientDir = (client = KOVA) => join(inboxPath, client);
const styleDir = (client = KOVA) => join(clientDir(client), '_Style');
const seriesDir = (name = 'Weekly', client = KOVA) => join(clientDir(client), '_Series', name);
const read = (path: string) => readFileSync(path, 'utf8');

/** Every file below `dir` (dot files too) with its bytes, by its path inside `dir`. */
function snapshot(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path)] = readFileSync(path).toString('base64');
  }
  return files;
}

/** Every file below `dir`, relative to it, sorted. */
function tree(dir: string): string[] {
  return Object.keys(snapshot(dir)).sort();
}

/** A finished job: its edit folder, final.mp4 and (unless told) a live composition, taken to ready. */
function readyJob(client: string, name: string, { composition = true } = {}): Job {
  const dir = join(clientDir(client), name);
  write(join(dir, 'edit', 'project.md'), 'the plan');
  write(join(dir, 'edit', 'final.mp4'), 'video');
  if (composition) {
    write(join(dir, 'edit', 'preview', 'index.html'), `<h1>${name}</h1>`);
    write(join(dir, 'edit', 'preview', 'compositions', 'title.html'), '<template>title</template>');
    write(join(dir, 'edit', 'preview', 'cut.mp4'), 'big');
  }
  const scanned = queuedJob(client, name);
  jobs.applyTransition(scanned.id, { type: 'START' });
  clock.tick(1_000);
  return jobs.applyTransition(scanned.id, { type: 'SUCCEED', output: OUTPUT });
}

/** A job that has settled into the queue. */
function queuedJob(client: string, name: string): Job {
  const { job } = jobs.upsertFromScan(makeScan(client, name));
  clock.tick(SETTLE_MS);
  return jobs.applyTransition(job.id, { type: 'SETTLED' });
}

/** The client has a style.md (version 1), learned from `sourceJobId`, with a kit from it. */
function givenStyle(sourceJobId: string | null, client = KOVA): void {
  write(join(styleDir(client), 'style.md'), OLD_STYLE);
  write(join(styleDir(client), 'kit', 'composition', 'index.html'), '<div>the stamp</div>');
  write(join(styleDir(client), 'logo.png'), 'png');
  clientStyles.upsert({
    clientId: clientIdFor(client),
    client,
    state: 'ready',
    version: 1,
    sourceJobId,
  });
}

/** Starts a series named `name` from `job` and answers it (fails the test on a refusal). */
async function start(job: Job, name = 'Weekly') {
  const outcome = await service.start(job.id, name);
  if (!outcome.ok) throw new Error(`start refused: ${outcome.error}`);
  expect(outcome.status).toBe(202);
  return outcome.body.series;
}

async function startAndRun(job: Job, name = 'Weekly') {
  const series = await start(job, name);
  worker.start();
  await worker.idle();
  return seriesRepo.get(series.id);
}

describe('Start a series', () => {
  it('stores the series learning, puts the job in it as its format and queues a start pass', async () => {
    const format = readyJob(KOVA, 'Weekly 5');

    const series = await start(format);

    expect(series).toMatchObject({
      clientId: KOVA_ID,
      client: KOVA,
      name: 'Weekly',
      state: 'learning',
      version: 0,
      formatJobId: format.id,
      formatJob: 'Weekly 5',
      pass: { kind: 'series', mode: 'start', jobId: format.id, job: 'Weekly 5', fileCount: 0 },
    });
    expect(jobs.get(format.id)).toMatchObject({ seriesId: series.id, episode: 5 });
    expect(jobs.getMeta(format.id)?.seriesPinned).toBe(true);
    expect(jobChanges.map((job) => job.id)).toEqual([format.id]);
    expect(changes).toEqual([{ type: 'changed', series, installed: false }]);
    // Nothing runs before the worker starts, and nothing is on disk yet.
    expect(runner.calls).toEqual([]);
    expect(existsSync(join(clientDir(), '_Series'))).toBe(false);
  });

  it('copies the kit from edit/preview/, installs series.md v1 and the style without the series, and sets the client kit aside', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);

    const installed = await startAndRun(format);

    expect(installed).toMatchObject({
      state: 'ready',
      version: 1,
      error: null,
      formatJobId: format.id,
    });
    // The kit is the composition itself, without the baked cut.
    expect(tree(join(seriesDir(), 'kit'))).toEqual(['compositions/title.html', 'index.html']);
    expect(tree(seriesDir())).toEqual(
      ['compositions/title.html', 'index.html']
        .map((f) => `kit/${f}`)
        .concat('series.md')
        .sort(),
    );
    expect(read(join(seriesDir(), 'series.md'))).toMatch(
      /^# Series: Weekly\nFormat from Weekly 5 \(2026-10-22\)\./,
    );
    // series.md v1 replaced nothing: no series history yet.
    expect(existsSync(seriesHistoryDirFor(dataDir, KOVA_ID, installed?.id ?? ''))).toBe(false);

    // The style went up one version, with what only the series does moved out and the old one kept.
    expect(read(join(styleDir(), 'style.md'))).toBe(
      '# Style: Kova Coffee\nLearned from Weekly 5 (2026-10-01). Moved what only Weekly does into the series (2026-10-22).\n## Look\n- Colours: red stamp\n',
    );
    expect(read(historyFileFor(dataDir, KOVA_ID, 1))).toBe(OLD_STYLE);
    expect(JSON.parse(read(historySourceFileFor(dataDir, KOVA_ID, 1)))).toEqual({
      sourceJobId: format.id,
    });
    // Its kit came from the format job: it went to style history, and the series has it now.
    expect(existsSync(join(styleDir(), 'kit'))).toBe(false);
    expect(tree(historyKitDirFor(dataDir, KOVA_ID, 1))).toEqual(['composition/index.html']);
    expect(clientStyles.get(KOVA_ID)).toMatchObject({
      state: 'ready',
      version: 2,
      sourceJobId: null,
    });
    expect(tree(styleDir())).toEqual(['logo.png', 'style.md']);

    expect(jobs.get(format.id)).toMatchObject({ seriesId: installed?.id, episode: 5 });
    expect(changes.at(-1)).toMatchObject({
      type: 'changed',
      installed: true,
      series: { state: 'ready', version: 1, pass: null },
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      writesStyle: true,
      jobDir: join(clientDir(), 'Weekly 5'),
      // No kit was kept before this one: the client is left with none.
      styleKit: { kind: 'none' },
    });
  });

  it('keeps the client kit, and its ## Kit, when it came from a job outside the series', async () => {
    const other = readyJob(KOVA, 'Launch');
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(other.id);

    await startAndRun(format);

    expect(runner.calls[0]?.styleKit).toEqual({ kind: 'keep' });
    expect(tree(join(styleDir(), 'kit'))).toEqual(['composition/index.html']);
    expect(read(join(styleDir(), 'style.md'))).toContain('## Kit\n- composition: the stamp\n');
    expect(existsSync(historyKitDirFor(dataDir, KOVA_ID, 1))).toBe(false);
    expect(clientStyles.get(KOVA_ID)).toMatchObject({ version: 2, sourceJobId: other.id });
  });

  it('leaves a client without a style.md alone: only series.md is written', async () => {
    const format = readyJob(KOVA, 'Weekly 5');

    const installed = await startAndRun(format);

    expect(installed).toMatchObject({ state: 'ready', version: 1 });
    expect(runner.calls[0]?.writesStyle).toBe(false);
    expect(existsSync(styleDir())).toBe(false);
    expect(clientStyles.get(KOVA_ID)).toBeNull();
  });

  it('records which kept style the start replaced, for its Undo', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);

    const installed = await startAndRun(format);

    expect(JSON.parse(read(seriesStartFileFor(dataDir, KOVA_ID, installed?.id ?? '')))).toEqual({
      styleVersion: 1,
    });
  });

  it('refuses what the plan refuses', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    const queued = queuedJob(KOVA, 'Weekly 6');

    expect(await service.start('nope', 'Weekly')).toEqual({
      ok: false,
      status: 404,
      error: 'Job nope not found',
    });
    expect(await service.start(queued.id, 'Weekly')).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.notFinished,
    });
    for (const bad of ['  ', 'a/b', '_Weekly', '.Weekly']) {
      const outcome = await service.start(format.id, bad);
      expect(outcome.ok === false && outcome.status).toBe(422);
    }

    const series = await start(format);
    expect(await service.start(format.id, 'Other')).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.alreadyInSeries,
    });
    // A series pass of the client is queued: no second start until it is done.
    const second = readyJob(KOVA, 'Tips 1');
    expect(await service.start(second.id, 'Tips')).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.seriesBusy,
    });
    worker.start();
    await worker.idle();
    // Names compare ignoring case.
    expect(await service.start(second.id, ' weekly ')).toEqual({
      ok: false,
      status: 422,
      error: SERIES_MESSAGES.nameTaken,
    });
    expect(seriesRepo.get(series.id)?.state).toBe('ready');
  });

  it('waits behind a style pass of the client instead of refusing (C23)', async () => {
    const launch = readyJob(KOVA, 'Launch');
    const format = readyJob(KOVA, 'Weekly 5');
    // The client's first style is still to be learned from Launch.
    await createLearnOnReady({ inboxPath, worker })(launch);
    expect(clientStyles.get(KOVA_ID)?.state).toBe('analysing');

    const series = await start(format);

    expect(series.state).toBe('learning');
    expect(runner.calls).toEqual([]);
    worker.start();
    await worker.idle();
    // The start ran once the style was made: it rewrote that style and left Launch's kit to it.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ writesStyle: true, styleKit: { kind: 'keep' } });
    expect(seriesRepo.get(series.id)).toMatchObject({ state: 'ready', version: 1 });
    expect(clientStyles.get(KOVA_ID)).toMatchObject({
      state: 'ready',
      version: 2,
      sourceJobId: launch.id,
    });
    expect(tree(join(styleDir(), 'kit'))).toEqual([
      'composition/compositions/title.html',
      'composition/index.html',
    ]);
  });

  it('fails a job without a composition: there is no format to copy', async () => {
    const format = readyJob(KOVA, 'Weekly 5', { composition: false });

    const failed = await startAndRun(format);

    expect(failed).toMatchObject({ state: 'failed', version: 0 });
    expect(failed?.error).toMatch(
      /^Series stopped: the episode “Weekly 5” has no composition to copy/,
    );
    expect(runner.calls).toEqual([]);
  });

  it('fails on a runner that can’t run series passes', async () => {
    const plainRunner: StyleRunner = { run: (request) => runner.run(request) };
    ({ worker, service } = build(plainRunner));
    const format = readyJob(KOVA, 'Weekly 5');

    const failed = await startAndRun(format);

    expect(failed).toMatchObject({ state: 'failed', error: NO_SERIES_RUNNER });
    // The kit copied for the run went back: a new series has none.
    expect(tree(seriesDir())).toEqual([]);
  });
});

describe('a failing run', () => {
  it('leaves _Style byte for byte as it was, sets the series failed, and Retry works', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    write(join(clientDir(), '_Series', FAIL_SERIES_MARKER), '');
    const before = snapshot(styleDir());

    const failed = await startAndRun(format);

    expect(failed).toMatchObject({
      state: 'failed',
      version: 0,
      error: 'Series stopped: injected failure (.fail-series)',
      lastPass: { kind: 'series', mode: 'start', jobId: format.id },
    });
    expect(snapshot(styleDir())).toEqual(before);
    expect(clientStyles.get(KOVA_ID)).toMatchObject({ version: 1, sourceJobId: format.id });
    expect(tree(seriesDir())).toEqual([]);
    expect(changes.at(-1)).toMatchObject({ type: 'changed', series: { state: 'failed' } });

    rmSync(join(clientDir(), '_Series', FAIL_SERIES_MARKER));
    const retried = await service.retry(failed?.id ?? '');
    expect(retried.ok && retried.status).toBe(202);
    expect(retried.ok && retried.body.series.state).toBe('learning');
    await worker.idle();

    expect(seriesRepo.get(failed?.id ?? '')).toMatchObject({ state: 'ready', version: 1 });
    expect(clientStyles.get(KOVA_ID)?.version).toBe(2);
  });

  it('changes neither file when the run gets one of the two wrong', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    const before = snapshot(styleDir());
    runner.script.push(async ({ seriesDir: dir, styleDir: style }) => {
      write(join(dir, 'series.md.new'), '# Series: Weekly\ngood\n');
      write(join(style, 'style.md.new'), 'Here is the style:\n');
      return { ok: true };
    });

    const failed = await startAndRun(format);

    expect(failed).toMatchObject({
      state: 'failed',
      error: 'Series stopped: style.md.new does not start with "# Style:".',
    });
    expect(snapshot(styleDir())).toEqual(before);
    expect(tree(seriesDir())).toEqual([]);
  });

  it('puts the old series kit back when a new format fails', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    const installed = await startAndRun(format);
    const episode = await readyEpisode('Weekly 6', installed?.id ?? '');
    const kitBefore = snapshot(join(seriesDir(), 'kit'));
    runner.script.push(async () => ({ ok: false, error: 'Style stopped: the run broke' }));

    expect((await service.useAsFormat(installed?.id ?? '', episode.id)).ok).toBe(true);
    await worker.idle();

    expect(seriesRepo.get(installed?.id ?? '')).toMatchObject({
      state: 'failed',
      version: 1,
      error: 'Series stopped: the run broke',
      formatJobId: format.id,
    });
    expect(snapshot(join(seriesDir(), 'kit'))).toEqual(kitBefore);
  });

  it('refuses Retry for a series that has not failed', async () => {
    const installed = await startAndRun(readyJob(KOVA, 'Weekly 5'));
    expect(await service.retry(installed?.id ?? '')).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.notFailed,
    });
    expect(await service.retry('nope')).toEqual({
      ok: false,
      status: 404,
      error: 'Series nope not found',
    });
  });
});

/** A job that joined the series by hand while queued and then finished. */
async function readyEpisode(name: string, seriesId: string): Promise<Job> {
  const queued = queuedJob(KOVA, name);
  const joined = await service.setJobSeries(queued.id, seriesId);
  expect(joined.ok).toBe(true);
  write(join(clientDir(), name, 'edit', 'project.md'), 'the plan');
  write(join(clientDir(), name, 'edit', 'preview', 'index.html'), `<h1>${name}</h1>`);
  jobs.applyTransition(queued.id, { type: 'START' });
  return jobs.applyTransition(queued.id, { type: 'SUCCEED', output: OUTPUT });
}

describe('Use as the series format', () => {
  it('gives a new kit and v2, with the old format in history and the style untouched', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(null);
    const installed = await startAndRun(format);
    const seriesId = installed?.id ?? '';
    const styleBefore = snapshot(styleDir());
    const styleRow = clientStyles.get(KOVA_ID);
    const oldSeries = read(join(seriesDir(), 'series.md'));
    const episode = await readyEpisode('Weekly 6', seriesId);

    const outcome = await service.useAsFormat(seriesId, episode.id);
    expect(outcome.ok && outcome.status).toBe(202);
    expect(outcome.ok && outcome.body.series.pass).toMatchObject({
      mode: 'replace',
      jobId: episode.id,
    });
    await worker.idle();

    expect(seriesRepo.get(seriesId)).toMatchObject({
      state: 'ready',
      version: 2,
      formatJobId: episode.id,
      formatJob: 'Weekly 6',
    });
    expect(read(join(seriesDir(), 'kit', 'index.html'))).toBe('<h1>Weekly 6</h1>');
    expect(read(join(seriesDir(), 'series.md'))).toMatch(
      /^# Series: Weekly\nFormat from Weekly 6 /,
    );
    expect(read(seriesHistoryFileFor(dataDir, KOVA_ID, seriesId, 1))).toBe(oldSeries);
    expect(read(join(seriesHistoryKitDirFor(dataDir, KOVA_ID, seriesId, 1), 'index.html'))).toBe(
      '<h1>Weekly 5</h1>',
    );
    expect(snapshot(styleDir())).toEqual(styleBefore);
    expect(clientStyles.get(KOVA_ID)).toEqual(styleRow);
    expect(runner.calls.at(-1)?.writesStyle).toBe(false);
    // Both episodes stay in the series.
    expect(jobs.get(format.id)?.seriesId).toBe(seriesId);
    expect(jobs.get(episode.id)?.seriesId).toBe(seriesId);
  });

  it('refuses a job that is not a ready episode, the format itself, and a busy client', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    const installed = await startAndRun(format);
    const seriesId = installed?.id ?? '';
    const outsider = readyJob(KOVA, 'Launch');

    expect(await service.useAsFormat(seriesId, outsider.id)).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.notReadyEpisode,
    });
    expect(await service.useAsFormat(seriesId, format.id)).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.formatAlready,
    });
    expect((await service.useAsFormat('nope', format.id)).ok).toBe(false);
    const episode = await readyEpisode('Weekly 6', seriesId);
    runner.hold = true;
    expect((await service.useAsFormat(seriesId, episode.id)).ok).toBe(true);
    expect(await service.useAsFormat(seriesId, episode.id)).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.seriesBusy,
    });
  });
});

describe('Series notes wait for the episode’s approval (C26)', () => {
  const NOTES_FILE = 'Review notes – Weekly 6 – round 1.md';
  /** The episode's project.md after its revise run: the plan, then what Round 1 did with the note. */
  const ROUND_1 =
    '## Round 1\n\n- 0:03.6 "stamp a beat later": I moved the stamp 0.5 s later (STAMP_DELAY = 0.5).';
  const PROJECT = `# Project: Weekly 6\n\n## Session 1\n\n- Cut the opening claim.\n\n${ROUND_1}\n`;

  /** The approval hook as the engine wires it: the queue worker's `afterReady`. */
  const afterReady = () => createLearnOnReady({ inboxPath, worker, series: service });

  /** Send's Add to series hook on the real service. */
  const seriesNotes = () => createSeriesNotes({ inboxPath, seriesRepo, series: service });

  /** A series v1 from Weekly 5, installed, with the worker running. */
  async function installedSeries() {
    const installed = await startAndRun(readyJob(KOVA, 'Weekly 5'));
    if (installed === null) throw new Error('the series did not install');
    return installed;
  }

  /** An episode of the series in Review: queued, joined by hand, edited, with its preview. */
  async function episodeInReview(name: string, seriesId: string): Promise<Job> {
    const queued = queuedJob(KOVA, name);
    expect((await service.setJobSeries(queued.id, seriesId)).ok).toBe(true);
    write(join(clientDir(), name, 'edit', 'project.md'), `# Project: ${name}\n`);
    write(join(clientDir(), name, 'edit', 'preview', 'index.html'), `<h1>${name}</h1>`);
    jobs.applyTransition(queued.id, { type: 'START' });
    return jobs.applyTransition(queued.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  }

  /** A sent note marked Series, as Send hands it to the hook. */
  function seriesNote(job: Job, text: string): ReviewNote {
    return {
      id: `n-${text}`,
      jobId: job.id,
      round: job.round,
      atSec: 3.6,
      kind: 'text',
      text,
      audioFile: null,
      audioSec: null,
      transcriptStatus: null,
      addToStyle: false,
      addToSeries: true,
      createdAt: clock().toISOString(),
      sentAt: clock().toISOString(),
      routeStatus: null,
      route: null,
      fixId: null,
      fixedAt: null,
    };
  }

  /** Send of round 1 with a note marked Series: the job goes to its revise run, the hook gets the note. */
  async function send(job: Job, text = 'stamp a beat later'): Promise<Job> {
    const sent = jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
    await seriesNotes().append(sent, [seriesNote(sent, text)]);
    return sent;
  }

  /** The revise run of the round (it writes Round 1), Review again, Approve and the render: ready. */
  function reviseAndApprove(job: Job): Job {
    write(join(clientDir(), job.name, 'edit', 'project.md'), PROJECT);
    write(join(clientDir(), job.name, 'edit', 'preview', 'index.html'), `<h1>${job.name} r1</h1>`);
    jobs.applyTransition(job.id, { type: 'START' });
    jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
    jobs.applyTransition(job.id, { type: 'APPROVE' });
    jobs.applyTransition(job.id, { type: 'START' });
    return jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
  }

  it('Send writes the notes file into the series folder and queues no series pass', async () => {
    const series = await installedSeries();
    const before = read(join(seriesDir(), 'series.md'));
    const episode = await episodeInReview('Weekly 6', series.id);

    await send(episode);
    await worker.idle();

    expect(read(join(seriesDir(), NOTES_FILE))).toContain('stamp a beat later');
    expect(runner.calls).toHaveLength(1); // the start, nothing since
    expect(worker.hasSeriesPass(KOVA_ID)).toBe(false);
    expect(read(join(seriesDir(), 'series.md'))).toBe(before);
    expect(seriesRepo.get(series.id)).toMatchObject({ state: 'ready', version: 1 });
    expect(seriesRepo.waitingNotes(series.id)).toEqual([
      { jobId: episode.id, name: NOTES_FILE, size: expect.any(Number) },
    ]);
  });

  it('approving the episode makes it the format: a replace pass with the notes and the rounds, series.md and the kit from it, and the notes no longer wait', async () => {
    const series = await installedSeries();
    const oldSeries = read(join(seriesDir(), 'series.md'));
    const styleBefore = snapshot(styleDir());
    const episode = await send(await episodeInReview('Weekly 6', series.id));
    const notesSize = Buffer.byteLength(read(join(seriesDir(), NOTES_FILE)));

    const ready = reviseAndApprove(episode);
    expect(ready.state).toBe('ready');
    await afterReady()(ready);
    await worker.idle();

    expect(runner.calls).toHaveLength(2);
    const request = runner.calls[1];
    expect(request?.pass).toEqual({
      kind: 'series',
      mode: 'replace',
      seriesId: series.id,
      series: 'Weekly',
      jobId: episode.id,
      job: 'Weekly 6',
      notes: [{ name: NOTES_FILE, size: notesSize }],
    });
    expect(request?.notes).toEqual({
      files: [{ name: NOTES_FILE, size: notesSize }],
      rounds: ROUND_1,
    });
    expect(request?.writesStyle).toBe(false);
    expect(request?.jobDir).toBe(join(clientDir(), 'Weekly 6'));

    expect(seriesRepo.get(series.id)).toMatchObject({
      state: 'ready',
      version: 2,
      formatJobId: episode.id,
      formatJob: 'Weekly 6',
      error: null,
    });
    // The kit is the approved episode's composition, as the revise run left it.
    expect(read(join(seriesDir(), 'kit', 'index.html'))).toBe('<h1>Weekly 6 r1</h1>');
    const format = read(join(seriesDir(), 'series.md'));
    expect(format).toMatch(/^# Series: Weekly\nFormat from Weekly 6 /);
    expect(format).toContain(
      `## Notes\n- ${NOTES_FILE}: a stand-in rule with the episode’s rounds`,
    );
    expect(read(seriesHistoryFileFor(dataDir, KOVA_ID, series.id, 1))).toBe(oldSeries);
    // The notes no longer wait, and their file stays in the folder for the record.
    expect(seriesRepo.waitingNotes(series.id)).toEqual([]);
    expect(existsSync(join(seriesDir(), NOTES_FILE))).toBe(true);
    // An episode's look never goes into the client's style.
    expect(snapshot(styleDir())).toEqual(styleBefore);

    // Approving it again (a render retried) changes nothing more.
    expect(await service.approved(ready)).toBe(false);
    await worker.idle();
    expect(runner.calls).toHaveLength(2);
  });

  it('takes every round’s notes of the episode, and only that episode’s', async () => {
    const series = await installedSeries();
    const six = await episodeInReview('Weekly 6', series.id);
    const seven = await send(await episodeInReview('Weekly 7', series.id), 'slower music');
    let sent = await send(six);
    // Round 2 of Weekly 6, with another note marked Series.
    jobs.applyTransition(sent.id, { type: 'START' });
    sent = jobs.applyTransition(sent.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
    sent = await send(sent, 'bigger stamp');
    expect(sent.round).toBe(2);

    await afterReady()(reviseAndApprove(sent));
    await worker.idle();

    expect(runner.calls.at(-1)?.pass.notes?.map((note) => note.name)).toEqual([
      NOTES_FILE,
      'Review notes – Weekly 6 – round 2.md',
    ]);
    expect(seriesRepo.waitingNotes(series.id)).toEqual([
      expect.objectContaining({ jobId: seven.id, name: 'Review notes – Weekly 7 – round 1.md' }),
    ]);
  });

  it('a cancelled episode changes nothing: the series stays, and its notes file stays in the folder', async () => {
    const series = await installedSeries();
    const before = { series: snapshot(seriesDir()), row: seriesRepo.get(series.id) };
    const sent = await send(await episodeInReview('Weekly 6', series.id));
    // Cancelled during its revise run.
    jobs.applyTransition(sent.id, { type: 'START' });
    const cancelled = jobs.applyTransition(sent.id, { type: 'CANCEL' });
    expect(cancelled.state).toBe('cancelled');

    await afterReady()(cancelled);
    await worker.idle();

    expect(runner.calls).toHaveLength(1);
    expect(seriesRepo.get(series.id)).toEqual(before.row);
    const after = snapshot(seriesDir());
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before.series), NOTES_FILE].sort());
    for (const [path, bytes] of Object.entries(before.series)) expect(after[path]).toBe(bytes);
  });

  it('an episode approved without Series notes changes nothing', async () => {
    const series = await installedSeries();
    const before = { series: snapshot(seriesDir()), row: seriesRepo.get(series.id) };
    const styleBefore = snapshot(styleDir());
    const episode = await episodeInReview('Weekly 6', series.id);

    const ready = reviseAndApprove(jobs.applyTransition(episode.id, { type: 'SEND_NOTES' }));
    await afterReady()(ready);
    await worker.idle();

    expect(runner.calls).toHaveLength(1);
    expect(seriesRepo.get(series.id)).toEqual(before.row);
    expect(snapshot(seriesDir())).toEqual(before.series);
    expect(snapshot(styleDir())).toEqual(styleBefore);
    expect(clientStyles.get(KOVA_ID)?.state).not.toBe('analysing');
  });

  it('an episode taken out of the series when it is approved changes nothing', async () => {
    const series = await installedSeries();
    const sent = await send(await episodeInReview('Weekly 6', series.id));
    const ready = reviseAndApprove(sent);

    expect(await service.approved({ ...ready, seriesId: null })).toBe(false);
    expect(await service.approved({ ...ready, seriesId: 'gone' })).toBe(false);
    expect(runner.calls).toHaveLength(1);
    expect(seriesRepo.waitingNotes(series.id)).toHaveLength(1);
  });

  it('waits behind a series pass of the client that is running, instead of being refused', async () => {
    const series = await installedSeries();
    const ready = reviseAndApprove(await send(await episodeInReview('Weekly 6', series.id)));
    runner.hold = true;
    await start(readyJob(KOVA, 'Daily 1'), 'Daily');
    await runner.started(2);

    expect(await service.approved(ready)).toBe(true);
    expect(seriesRepo.get(series.id)).toMatchObject({
      state: 'learning',
      lastPass: { mode: 'replace', jobId: ready.id },
    });
    runner.hold = false;
    runner.release();
    await worker.idle();

    expect(runner.calls.map((call) => call.pass.series)).toEqual(['Weekly', 'Daily', 'Weekly']);
    expect(seriesRepo.get(series.id)).toMatchObject({ state: 'ready', formatJob: 'Weekly 6' });
  });

  it('a failed run keeps its notes for Retry', async () => {
    const series = await installedSeries();
    const ready = reviseAndApprove(await send(await episodeInReview('Weekly 6', series.id)));
    write(join(seriesDir(), FAIL_SERIES_MARKER), '');

    await afterReady()(ready);
    await worker.idle();

    const failed = seriesRepo.get(series.id);
    expect(failed).toMatchObject({ state: 'failed', version: 1, formatJob: 'Weekly 5' });
    expect(failed?.lastPass).toMatchObject({ mode: 'replace', notes: [{ name: NOTES_FILE }] });
    rmSync(join(seriesDir(), FAIL_SERIES_MARKER));

    expect((await service.retry(series.id)).ok).toBe(true);
    await worker.idle();

    expect(runner.calls.at(-1)?.notes?.rounds).toBe(ROUND_1);
    expect(seriesRepo.get(series.id)).toMatchObject({
      state: 'ready',
      version: 2,
      formatJob: 'Weekly 6',
    });
  });

  it('makes the format without the notes when their files are gone from the folder', async () => {
    const series = await installedSeries();
    const ready = reviseAndApprove(await send(await episodeInReview('Weekly 6', series.id)));
    rmSync(join(seriesDir(), NOTES_FILE));

    await afterReady()(ready);
    await worker.idle();

    expect(runner.calls.at(-1)?.pass.notes).toBeUndefined();
    expect(runner.calls.at(-1)?.notes).toBeUndefined();
    expect(seriesRepo.get(series.id)).toMatchObject({ state: 'ready', formatJob: 'Weekly 6' });
    expect(read(join(seriesDir(), 'series.md'))).not.toContain('## Notes');
  });

  it('gives the run no rounds when project.md has none', async () => {
    const series = await installedSeries();
    const ready = reviseAndApprove(await send(await episodeInReview('Weekly 6', series.id)));
    write(join(clientDir(), 'Weekly 6', 'edit', 'project.md'), '# Project: Weekly 6\n');

    await afterReady()(ready);
    await worker.idle();

    expect(runner.calls.at(-1)?.notes).toEqual({
      files: [expect.objectContaining({ name: NOTES_FILE })],
      rounds: null,
    });
  });

  it('records only files inside the series folder, for a series that is there', async () => {
    const series = await installedSeries();
    expect(await service.addNotes(series.id, 'j6', [{ name: '../style.md', size: 1 }])).toEqual({
      ok: false,
      status: 422,
      error: SERIES_BAD_FILES,
    });
    expect(await service.addNotes('nope', 'j6', [{ name: 'n.md', size: 1 }])).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(seriesRepo.waitingNotes(series.id)).toEqual([]);
  });
});

describe('Start a series right after its format episode was approved (C23)', () => {
  const FAQ_STYLE =
    '# Style: Kova Coffee\nLearned from FAQ 5 (2026-10-01).\n## Look\n- Colours: green bubble\n## Kit\n- composition: the WhatsApp question card (wa-message.html), rising captions and the end fade\n## Reference\n- faq.mp4: the FAQ look\n';

  /** 1. The client's style (version 1) and kit came from FAQ 5: the WhatsApp question card. */
  function givenFaqStyle(faq: Job): void {
    write(join(styleDir(), 'style.md'), FAQ_STYLE);
    write(join(styleDir(), 'kit', 'composition', 'index.html'), '<div>FAQ</div>');
    write(
      join(styleDir(), 'kit', 'composition', 'compositions', 'wa-message.html'),
      '<template>wa-message</template>',
    );
    clientStyles.upsert({
      clientId: KOVA_ID,
      client: KOVA,
      state: 'ready',
      version: 1,
      sourceJobId: faq.id,
    });
  }

  it('waits for the Learn pass, gives the client its FAQ kit back under ## Kit, and Undo leaves the style as that pass made it', async () => {
    const faq = readyJob(KOVA, 'FAQ 5');
    givenFaqStyle(faq);
    const faqKit = snapshot(join(styleDir(), 'kit'));
    const format = readyJob(KOVA, 'Weekly 5');
    // 2. Approving the format episode queues a Learn merge (the queue worker's afterReady).
    await createLearnOnReady({ inboxPath, worker })(format);

    // 3. Start a series from it while that pass is still queued: accepted, and it waits.
    const series = await start(format);
    expect(series).toMatchObject({ state: 'learning', version: 0 });
    // The style as the Learn pass left it, when the start's run begins.
    let afterLearn: Record<string, string> = {};
    runner.script.push(async (request) => {
      afterLearn = snapshot(styleDir());
      return runner.fake.runSeries(request);
    });
    worker.start();
    await worker.idle();

    // The Learn pass ran first: the episode's composition replaced the FAQ kit (kept in history).
    expect(read(historyFileFor(dataDir, KOVA_ID, 1))).toBe(FAQ_STYLE);
    expect(snapshot(historyKitDirFor(dataDir, KOVA_ID, 1))).toEqual(faqKit);
    expect(read(historyFileFor(dataDir, KOVA_ID, 2))).toMatch(
      /^# Style: Kova Coffee\nLearned from FAQ 5 \(2026-10-01\)\. Plus Weekly 5 \(2026-10-22\)\./,
    );
    expect(JSON.parse(read(historySourceFileFor(dataDir, KOVA_ID, 2)))).toEqual({
      sourceJobId: format.id,
    });
    expect(tree(historyKitDirFor(dataDir, KOVA_ID, 2))).toContain('composition/index.html');
    expect(snapshot(historyKitDirFor(dataDir, KOVA_ID, 2))).not.toEqual(faqKit);
    // The start was told which kit comes back.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.styleKit).toEqual({
      kind: 'restore',
      names: ['composition'],
      job: 'FAQ 5',
      section:
        '- composition: the WhatsApp question card (wa-message.html), rising captions and the end fade',
    });

    // 4. The client's kit is the FAQ kit again, and ## Kit names it.
    expect(snapshot(join(styleDir(), 'kit'))).toEqual(faqKit);
    expect(read(join(styleDir(), 'style.md'))).toBe(
      '# Style: Kova Coffee\nLearned from FAQ 5 (2026-10-01). Plus Weekly 5 (2026-10-22). Moved what only Weekly does into the series (2026-10-22).\n## Look\n- Colours: green bubble\n## Kit\n- composition: the WhatsApp question card (wa-message.html), rising captions and the end fade\n## Reference\n- faq.mp4: the FAQ look\n',
    );
    expect(tree(styleDir())).toEqual([
      'kit/composition/compositions/wa-message.html',
      'kit/composition/index.html',
      'style.md',
    ]);
    expect(clientStyles.get(KOVA_ID)).toMatchObject({
      state: 'ready',
      version: 3,
      sourceJobId: faq.id,
    });
    expect(seriesRepo.get(series.id)).toMatchObject({ state: 'ready', version: 1 });
    expect(read(join(seriesDir(), 'kit', 'index.html'))).toBe('<h1>Weekly 5</h1>');

    // Undo of the start: the style and kit are as the Learn pass left them.
    expect((await service.undoStart(series.id)).ok).toBe(true);

    expect(snapshot(styleDir())).toEqual(afterLearn);
    expect(existsSync(join(clientDir(), '_Series'))).toBe(false);
    expect(clientStyles.get(KOVA_ID)).toMatchObject({
      state: 'ready',
      version: 4,
      sourceJobId: format.id,
    });
    // History lost nothing: the FAQ kit is still kept where the Learn pass put it.
    expect(snapshot(historyKitDirFor(dataDir, KOVA_ID, 1))).toEqual(faqKit);
  });

  it('puts no kit back when the kit it replaced came from this series too', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    clientStyles.upsert({ clientId: KOVA_ID, client: KOVA, version: 2 });
    write(historyFileFor(dataDir, KOVA_ID, 1), OLD_STYLE);
    write(join(historyKitDirFor(dataDir, KOVA_ID, 1), 'composition', 'index.html'), 'older');
    write(historySourceFileFor(dataDir, KOVA_ID, 1), JSON.stringify({ sourceJobId: format.id }));

    await startAndRun(format);

    expect(runner.calls[0]?.styleKit).toEqual({ kind: 'none' });
    expect(existsSync(join(styleDir(), 'kit'))).toBe(false);
    expect(read(join(styleDir(), 'style.md'))).not.toContain('## Kit');
    expect(clientStyles.get(KOVA_ID)).toMatchObject({ version: 3, sourceJobId: null });
  });

  it('puts no kit back when the client had none before', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    clientStyles.upsert({ clientId: KOVA_ID, client: KOVA, version: 2 });
    write(
      historyFileFor(dataDir, KOVA_ID, 1),
      '# Style: Kova Coffee\nFrom your files: logo.png.\n',
    );
    mkdirSync(historyKitDirFor(dataDir, KOVA_ID, 1), { recursive: true });

    await startAndRun(format);

    expect(runner.calls[0]?.styleKit).toEqual({ kind: 'none' });
    expect(existsSync(join(styleDir(), 'kit'))).toBe(false);
    expect(clientStyles.get(KOVA_ID)).toMatchObject({ version: 3, sourceJobId: null });
  });
});

describe('Undo of Start a series', () => {
  it('while the pass is queued: deletes the row, takes the job out, and nothing ran', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    const before = snapshot(clientDir());
    const series = await start(format);

    expect(await service.undoStart(series.id)).toEqual({
      ok: true,
      status: 200,
      body: { ok: true },
    });

    expect(seriesRepo.get(series.id)).toBeNull();
    expect(jobs.get(format.id)).toMatchObject({ seriesId: null, episode: null });
    expect(jobs.getMeta(format.id)?.seriesPinned).toBe(false);
    expect(changes.at(-1)).toEqual({ type: 'removed', seriesId: series.id, clientId: KOVA_ID });
    worker.start();
    await worker.idle();
    expect(runner.calls).toEqual([]);
    expect(snapshot(clientDir())).toEqual(before);
  });

  it('while the pass runs: stops it, puts both kits back and removes the series folder', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    const before = snapshot(clientDir());
    runner.hold = true;
    const series = await start(format);
    worker.start();
    await runner.started(1);
    expect(tree(join(seriesDir(), 'kit'))).toEqual(['compositions/title.html', 'index.html']);

    expect((await service.undoStart(series.id)).ok).toBe(true);

    expect(runner.calls[0]?.signal.aborted).toBe(true);
    expect(snapshot(clientDir())).toEqual(before);
    expect(seriesRepo.get(series.id)).toBeNull();
    expect(jobs.get(format.id)?.seriesId).toBeNull();
    expect(clientStyles.get(KOVA_ID)).toMatchObject({ version: 1, sourceJobId: format.id });
  });

  it('once installed: the style.md and kit it replaced come back and the series folder goes to its history', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    givenStyle(format.id);
    const before = snapshot(clientDir());
    const installed = await startAndRun(format);
    const seriesId = installed?.id ?? '';
    const seriesBefore = snapshot(seriesDir());
    clock.tick(SERIES_UNDO_MS - 1_000);

    expect((await service.undoStart(seriesId)).ok).toBe(true);

    // Every file of the client folder is back as it was before the start.
    expect(snapshot(clientDir())).toEqual(before);
    expect(existsSync(join(clientDir(), '_Series'))).toBe(false);
    // The style went forward to the old one, the start's version kept in history.
    expect(clientStyles.get(KOVA_ID)).toMatchObject({
      state: 'ready',
      version: 3,
      sourceJobId: format.id,
    });
    expect(read(historyFileFor(dataDir, KOVA_ID, 2))).toMatch(/Moved what only Weekly does/);
    // The series folder is kept whole in its history.
    const history = seriesHistoryDirFor(dataDir, KOVA_ID, seriesId);
    const kept = readdirSync(history).filter((name) => name.startsWith('undone-'));
    expect(kept).toHaveLength(1);
    expect(snapshot(join(history, kept[0] ?? ''))).toEqual(seriesBefore);
    expect(existsSync(seriesStartFileFor(dataDir, KOVA_ID, seriesId))).toBe(false);
    expect(seriesRepo.get(seriesId)).toBeNull();
    expect(jobs.get(format.id)?.seriesId).toBeNull();
  });

  it('is refused once SERIES_UNDO_MS have gone by', async () => {
    const installed = await startAndRun(readyJob(KOVA, 'Weekly 5'));
    clock.tick(SERIES_UNDO_MS + 1);

    expect(await service.undoStart(installed?.id ?? '')).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.undoTooLate,
    });
    expect(seriesRepo.get(installed?.id ?? '')?.state).toBe('ready');
  });

  it('leaves other series of the client in _Series', async () => {
    const tips = await startAndRun(readyJob(KOVA, 'Tips 1'), 'Tips');
    clock.tick(SERIES_UNDO_MS + 1);
    const weekly = await startAndRun(readyJob(KOVA, 'Weekly 5'));

    expect((await service.undoStart(weekly?.id ?? '')).ok).toBe(true);

    expect(readdirSync(join(clientDir(), '_Series'))).toEqual(['Tips']);
    expect(seriesRepo.get(tips?.id ?? '')?.state).toBe('ready');
  });
});

describe('the edit worker’s wait', () => {
  it('holds a job of the client during a series pass, never a job of another client', async () => {
    runner.hold = true;
    const format = readyJob(KOVA, 'Weekly 5');
    await start(format);
    worker.start();
    await runner.started(1);
    const wait = createLearnWait({ worker });

    const kovaWait = wait(queuedJob(KOVA, 'Weekly 6'));
    expect(kovaWait).not.toBeNull();
    expect(wait(queuedJob(ARC, 'Gym tour'))).toBeNull();
    expect(worker.isLearning(KOVA_ID)).toBe(true);
    expect(worker.isLearning(clientIdFor(ARC))).toBe(false);

    let over = false;
    const waiting = kovaWait?.then(() => {
      over = true;
    });
    await Promise.resolve();
    expect(over).toBe(false);
    runner.release();
    await waiting;
    expect(over).toBe(true);
    expect(worker.isLearning(KOVA_ID)).toBe(false);
  });
});

describe('a restart', () => {
  it('runs the last pass of a series a crash left learning', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    const series = await start(format);
    // The engine stops before the pass runs; the next one starts on the same database.
    await worker.stop();
    ({ worker, service } = build());

    worker.start();
    await worker.idle();

    expect(seriesRepo.get(series.id)).toMatchObject({ state: 'ready', version: 1 });
    expect(runner.calls).toHaveLength(1);
  });

  it('fails a series left learning with nothing it can run', async () => {
    const created = seriesRepo.create({
      clientId: KOVA_ID,
      client: KOVA,
      name: 'Weekly',
      formatJobId: 'j5',
      formatJob: 'Weekly 5',
      lastPass: { kind: 'learn' },
    });

    worker.start();
    await worker.idle();

    expect(seriesRepo.get(created.id)).toMatchObject({
      state: 'failed',
      error: NOTHING_TO_RERUN_SERIES,
    });
  });
});

describe('putting a job in a series by hand', () => {
  it('pins a waiting job in the series with its episode, or takes it out', async () => {
    const installed = await startAndRun(readyJob(KOVA, 'Weekly 5'));
    const seriesId = installed?.id ?? '';
    const waiting = queuedJob(KOVA, 'Weekly #6');

    const joined = await service.setJobSeries(waiting.id, seriesId);
    expect(joined).toMatchObject({ ok: true, status: 200, body: { seriesId, episode: 6 } });
    expect(jobs.getMeta(waiting.id)?.seriesPinned).toBe(true);

    const out = await service.setJobSeries(waiting.id, null);
    expect(out).toMatchObject({ ok: true, body: { seriesId: null, episode: null } });
    // Still pinned: the name rule leaves the owner's choice alone.
    expect(jobs.getMeta(waiting.id)?.seriesPinned).toBe(true);
    expect(jobChanges.filter((job) => job.id === waiting.id)).toHaveLength(2);
  });

  it('refuses a job that has started, another client’s series and an unknown one', async () => {
    const installed = await startAndRun(readyJob(KOVA, 'Weekly 5'));
    const seriesId = installed?.id ?? '';
    const finished = readyJob(KOVA, 'Weekly 6');
    const arc = queuedJob(ARC, 'Weekly 7');

    expect(await service.setJobSeries(finished.id, seriesId)).toEqual({
      ok: false,
      status: 409,
      error: SERIES_MESSAGES.jobStarted,
    });
    expect(await service.setJobSeries(arc.id, seriesId)).toEqual({
      ok: false,
      status: 422,
      error: SERIES_MESSAGES.otherClient,
    });
    expect(await service.setJobSeries(arc.id, 'nope')).toEqual({
      ok: false,
      status: 404,
      error: 'Series nope not found',
    });
    expect(await service.setJobSeries('nope', null)).toEqual({
      ok: false,
      status: 404,
      error: 'Job nope not found',
    });
  });
});

describe('reading series', () => {
  it('lists the client’s series with their episodes, and reads series.md once there is one', async () => {
    const format = readyJob(KOVA, 'Weekly 5');
    const series = await start(format);

    const learning = await service.get(series.id);
    expect(learning).toMatchObject({
      ok: true,
      body: { markdown: null, series: { state: 'learning' } },
    });
    worker.start();
    await worker.idle();

    const ready = await service.get(series.id);
    expect(ready.ok && ready.body.markdown).toMatch(/^# Series: Weekly\n/);
    expect(await service.list(KOVA_ID)).toMatchObject({
      ok: true,
      status: 200,
      body: { series: [{ id: series.id, name: 'Weekly', episodeCount: 1, state: 'ready' }] },
    });
    expect(await service.list(clientIdFor(ARC))).toEqual({
      ok: true,
      status: 200,
      body: { series: [] },
    });
    expect(await service.get('nope')).toEqual({
      ok: false,
      status: 404,
      error: 'Series nope not found',
    });
    expect(service.enabled).toBe(true);
  });

  it('tells about every change of the series', async () => {
    const series = await startAndRun(readyJob(KOVA, 'Weekly 5'));

    expect(
      changes.map((change) =>
        change.type === 'changed' ? [change.series.state, change.installed] : [change.type],
      ),
    ).toEqual([
      ['learning', false],
      ['ready', true],
    ]);
    expect(series?.state).toBe('ready');
  });
});
