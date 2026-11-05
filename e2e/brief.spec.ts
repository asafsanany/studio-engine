// B4: the Brief step on the built server, with the fake runner. Its own engine (temp inbox, data
// folder and port), so smoke.spec.ts still starts on an empty one. Through the API and the job
// folders only; the Jobs page itself is the smoke test's.
//
//   Briefed       a .txt, a voice note and a clip, plus a note -> Brief ("reading 2 files") ->
//                 Transcribe ... Render -> ready, with edit/brief.json and edit/brief.md written
//   Brief fails   `.fail-at-brief` -> failed at Brief -> marker removed -> Retry -> ready (a client
//                 that has never had a finished job, so no style)
//   Client style  a style.md and a logo in the client's _Style -> the logo's Read pass settles ->
//                 copied into edit/style/ at the first attempt -> kept through the Retry ->
//                 edit/brief.md ends with "## Client style"

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';

const CLIENT = 'Acme';
const NOTE = 'Keep it under 20 seconds.\nUse the second take.';

/** As in the smoke test: a fake edit takes about 15 s at this speed. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);

interface JobRow {
  id: string;
  name: string;
  state: string;
  step: number | null;
  subProgress: string | null;
  failedAt: number | null;
  error: string | null;
}

let engine: Engine;

test.beforeAll(async () => {
  // It waits for ready, so it runs without Review.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, review: false });
});

test.afterAll(async () => {
  await engine?.stop();
});

async function jobs(): Promise<JobRow[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobRow[];
}

async function jobNamed(name: string): Promise<JobRow | undefined> {
  return (await jobs()).find((job) => job.name === name);
}

/**
 * Polls the job every 20 ms until `done` says so, and returns every distinct state it was seen
 * in, in order. The fake Brief run takes a quarter of a second at speed 4, so this sees it.
 */
async function follow(name: string, done: (job: JobRow) => boolean, timeoutMs = 60_000) {
  const seen: JobRow[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await jobNamed(name);
    if (job !== undefined) {
      const last = seen.at(-1);
      if (
        last === undefined ||
        last.state !== job.state ||
        last.step !== job.step ||
        last.subProgress !== job.subProgress
      ) {
        seen.push(job);
      }
      if (done(job)) return seen;
    }
    if (Date.now() > deadline) {
      throw new Error(`${name} did not get there in time: ${JSON.stringify(seen.at(-1))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readBrief(job: string, client = CLIENT) {
  const editDir = join(engine.inbox, client, job, 'edit');
  return {
    editDir,
    json: JSON.parse(await readFile(join(editDir, 'brief.json'), 'utf8')) as Record<
      string,
      unknown
    > & { files: { path: string; role: string }[] },
    md: await readFile(join(editDir, 'brief.md'), 'utf8'),
  };
}

test('every edit starts with the Brief step, which writes edit/brief.json and brief.md', async () => {
  const name = 'Briefed';
  await engine.createJob({ client: CLIENT, job: name });

  await test.step('a note saved while the job arrives goes into the brief', async () => {
    const arriving = await follow(name, (job) => job.state === 'arriving', 10_000);
    const id = arriving.at(-1)?.id;
    const saved = await fetch(`${engine.baseURL}/api/jobs/${id}/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: NOTE }),
    });
    expect(saved.status).toBe(200);
  });

  await test.step('the job goes Brief → Render and ends ready', async () => {
    const seen = await follow(name, (job) => job.state === 'ready' || job.state === 'failed');
    expect(seen.at(-1)).toMatchObject({ state: 'ready', error: null });

    const editing = seen.filter((job) => job.state === 'editing');
    // brief.txt and voice.m4a are the files that are not video.
    expect(editing.map((job) => [job.step, job.subProgress])).toContainEqual([
      1,
      'reading 2 files',
    ]);
    const steps = editing.map((job) => job.step ?? 0);
    expect(steps[0]).toBe(1);
    expect(steps, `steps over time: ${steps.join(' ')}`).toEqual([...steps].sort((a, b) => a - b));
    expect(steps).toContain(2);
    expect(steps.at(-1)).toBe(8);
  });

  await test.step('edit/brief.json is the finished brief and brief.md renders it', async () => {
    const { editDir, json, md } = await readBrief(name);
    expect(json.schema).toBe(1);
    expect(json.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(json.files.map((file) => [file.path, file.role])).toEqual([
      ['brief.txt', 'instructions'],
      ['clip.mp4', 'footage'],
      ['voice.m4a', 'instructions'],
    ]);
    expect(md.startsWith(`# Brief: ${name} (${CLIENT})\n\n`)).toBe(true);
    expect(md).toContain(`## the owner’s note (word for word; it wins)\n${NOTE}\n`);
    expect(md).toContain('## Files\n');
    // The voice note's transcript is the Brief run's, apart from the edit's own transcripts.
    expect(existsSync(join(editDir, 'brief', 'transcripts', 'voice.json'))).toBe(true);
    expect(existsSync(join(editDir, 'transcripts', 'voice.json'))).toBe(true);
    expect(existsSync(join(editDir, 'final.mp4'))).toBe(true);
  });
});

test('.fail-at-brief fails the job at Brief, and Retry finishes it', async () => {
  // A client of its own that has never had a finished job: Acme's first job, above, has written
  // Acme's style (its Learn pass, C4), and this test checks a brief without one.
  const client = 'Brightside';
  const name = 'Brief fails';
  await engine.createJob({ client, job: name, failAt: 'brief' });

  const failed = await follow(name, (job) => job.state === 'failed' || job.state === 'ready');
  const job = failed.at(-1);
  expect(job).toMatchObject({
    state: 'failed',
    step: 1,
    failedAt: 1,
    error: 'Brief failed: injected failure (.fail-at-brief)',
  });
  expect(existsSync(join(engine.inbox, client, name, 'edit', 'brief.json'))).toBe(false);

  await rm(join(engine.inbox, client, name, '.fail-at-brief'));
  const retried = await fetch(`${engine.baseURL}/api/jobs/${job?.id}/retry`, { method: 'POST' });
  expect(retried.status).toBe(200);

  const after = await follow(name, (row) => row.state === 'ready' || row.state === 'failed');
  expect(after.at(-1)).toMatchObject({ state: 'ready', error: null });
  // A job failed at Brief had no edit yet: after its brief the edit starts from Transcribe.
  expect(after.filter((row) => row.state === 'editing').map((row) => row.step)).toContain(2);
  const { json, md } = await readBrief(name, client);
  expect(json.schema).toBe(1);
  expect(md.startsWith(`# Brief: ${name} (${client})`)).toBe(true);
  // A client with no style.md gets no style section.
  expect(md).not.toContain('Client style');
  expect(existsSync(join(engine.inbox, client, name, 'edit', 'style'))).toBe(false);
});

/** The id of a client: the first 12 hex characters of sha1 of its folder name (NFC). */
function clientIdOf(client: string): string {
  return createHash('sha1').update(client.normalize('NFC'), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Waits until the client's style is ready with no style run queued or running, and returns its
 * style.md. Files dropped into `_Style` are read by a Read pass once the folder has been quiet for
 * the settle time (C3), and that pass rewrites style.md: the job must start after it.
 */
async function settledStyle(client: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${engine.baseURL}/api/clients/${clientIdOf(client)}/style`);
    // 404 until the client is known: its first style run makes it so.
    if (res.status === 200) {
      const style = (await res.json()) as {
        state: string;
        pass?: unknown;
        markdown: string | null;
      };
      if (style.state === 'ready' && (style.pass ?? null) === null && style.markdown !== null) {
        return style.markdown;
      }
    }
    if (Date.now() > deadline) throw new Error(`the style of ${client} did not settle in time`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a style.md in the client’s _Style is copied into the job and ends edit/brief.md', async () => {
  const client = 'Kova Coffee';
  const name = 'Styled';
  const styleDir = join(engine.inbox, client, '_Style');
  await mkdir(join(styleDir, 'kit', 'title-card'), { recursive: true });
  await writeFile(
    join(styleDir, 'style.md'),
    '# Style: Kova Coffee\nFrom your files: logo-kova.png.\n\n## Look\n- Fonts: Inter 600\n',
  );
  await writeFile(join(styleDir, 'logo-kova.png'), 'png');
  await writeFile(join(styleDir, 'kit', 'title-card', 'index.html'), '<html></html>');
  // The logo is a Finder drop: its Read pass (the fake one) adds it to style.md. The style the job
  // starts with is the one after that pass.
  const STYLE = await settledStyle(client);
  expect(STYLE.startsWith('# Style: Kova Coffee\n')).toBe(true);
  expect(STYLE).toContain('## Look\n- Fonts: Inter 600\n');
  // Fails at Brief on purpose, to see that the copy is made at the first attempt and kept.
  await engine.createJob({ client, job: name, failAt: 'brief' });

  const failed = await follow(name, (job) => job.state === 'failed' || job.state === 'ready');
  const job = failed.at(-1);
  expect(job).toMatchObject({ state: 'failed', step: 1 });
  const frozen = join(engine.inbox, client, name, 'edit', 'style');
  expect(await readFile(join(frozen, 'style.md'), 'utf8')).toBe(STYLE);
  expect(existsSync(join(frozen, 'logo-kova.png'))).toBe(true);
  expect(existsSync(join(frozen, 'kit', 'title-card', 'index.html'))).toBe(true);

  // The client's style changes before the Retry; the job keeps the one it started with.
  await writeFile(join(styleDir, 'style.md'), '# Style: Kova Coffee\nA new look.\n');
  await rm(join(engine.inbox, client, name, '.fail-at-brief'));
  const retried = await fetch(`${engine.baseURL}/api/jobs/${job?.id}/retry`, { method: 'POST' });
  expect(retried.status).toBe(200);
  const after = await follow(name, (row) => row.state === 'ready' || row.state === 'failed');
  expect(after.at(-1)).toMatchObject({ state: 'ready', error: null });

  const { md } = await readBrief(name, client);
  expect(md).toContain(
    [
      '## Client style',
      'This is the client’s house style. Follow it wherever the sections above say nothing.',
      'Its files are in edit/style/: logo-kova.png, kit/. Reuse the graphics in edit/style/kit/ with this job’s text, and build new ones only for what the kit doesn’t cover, in the same look.',
      '',
      '### Style: Kova Coffee',
    ].join('\n'),
  );
  // The section is the last one of brief.md: style.md, with its headings two levels deeper.
  expect(md).toContain('#### Look\n- Fonts: Inter 600\n');
  expect(md.endsWith(`${STYLE.trimEnd().replace(/^(#+) /gm, '##$1 ')}\n`)).toBe(true);
  expect(md).not.toContain('A new look.');
  expect(await readFile(join(frozen, 'style.md'), 'utf8')).toBe(STYLE);
});
