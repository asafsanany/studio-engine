import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  type GraphicDetail,
  graphicBusyMessage,
  graphicCopiedText,
  graphicRestoredText,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGraphicWork } from './graphic-check.js';
import { graphicRefsDir, graphicVersionDir } from './graphic-folders.js';
import {
  createDisabledGraphicService,
  type GraphicOutcome,
  type GraphicSend,
} from './graphic-service.js';
import {
  type GraphicHarness,
  type HarnessOptions,
  makeHarness,
  stagedFile,
  writeCannedGraphic,
} from './test-utils.js';

// The graphics service (GR1) over the real repository, folders, worker and service on a temp
// inbox, with a stand-in runner. Every rule of the API table that is not HTTP.

const harnesses: GraphicHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function harness(options: HarnessOptions = {}): GraphicHarness {
  const made = makeHarness(options);
  harnesses.push(made);
  return made;
}

/** The body of an outcome that is ok. */
function body<T>(outcome: GraphicOutcome<T>): T {
  if (!outcome.ok) throw new Error(`refused ${outcome.status}: ${outcome.error}`);
  return outcome.body;
}

function refusal(outcome: GraphicOutcome<unknown>): { status: number; error: string } {
  if (outcome.ok) throw new Error('not refused');
  return { status: outcome.status, error: outcome.error };
}

const send = (text: string, extra: Partial<GraphicSend> = {}): GraphicSend => ({
  text,
  effort: null,
  files: [],
  ...extra,
});

/** Waits until Claude's newest row of the graphic has ended; the graphic as the API shows it. */
async function settled(h: GraphicHarness, id: string): Promise<GraphicDetail> {
  await vi.waitFor(() => expect(h.repo.summary(id)?.status).not.toBe('making'));
  return body(await h.service.get(id));
}

/** A graphic with v1 made. */
async function madeGraphic(h: GraphicHarness): Promise<GraphicDetail> {
  const created = body(await h.service.create(send('A white pill with the name in it')));
  return settled(h, created.id);
}

/** v1 made, then a change made as v2. */
async function twoVersions(h: GraphicHarness): Promise<GraphicDetail> {
  const first = await madeGraphic(h);
  h.runner.canned = (request) => ({
    reply: `Made v${request.version}.`,
    variables: [
      { id: 'name', label: 'Name', default: 'Dana' },
      { id: 'role', label: 'Role', default: 'Lawyer' },
    ],
    lengthSec: 4,
  });
  body(await h.service.send(first.id, send('Add the role under the name')));
  return settled(h, first.id);
}

describe('create', () => {
  it('makes a "New graphic" with the owner’s message and v1 making, and queues the run', async () => {
    const h = harness({ holdAll: true });

    const outcome = await h.service.create(
      send('A white pill with the name in it', { effort: 'medium' }),
    );

    expect(outcome).toMatchObject({ ok: true, status: 201 });
    const detail = body(outcome);
    expect(detail).toMatchObject({
      name: 'New graphic',
      folder: 'New graphic',
      status: 'making',
      makingVersion: 1,
      version: null,
      uses: true,
      usedIn: null,
    });
    expect(detail.messages.map((message) => message.role)).toEqual(['you', 'claude']);
    expect(detail.messages[0]).toMatchObject({
      text: 'A white pill with the name in it',
      effort: 'medium',
      refs: [],
    });
    expect(detail.messages[1]).toMatchObject({ status: 'making', version: 1, step: 0 });
    expect(existsSync(join(h.inbox, '_Graphics', 'New graphic', 'refs'))).toBe(true);
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    expect(h.runner.requests[0]?.message.effort).toBe('medium');
  });

  it('names a second one "New graphic (2)" while the first is not named yet', async () => {
    const h = harness({ holdAll: true });

    const [a, b, c] = await Promise.all([
      h.service.create(send('one')),
      h.service.create(send('two')),
      h.service.create(send('three')),
    ]);

    expect([a, b, c].map((outcome) => body(outcome).name).sort()).toEqual([
      'New graphic',
      'New graphic (2)',
      'New graphic (3)',
    ]);
    expect((await h.folders.names()).sort()).toEqual([
      'New graphic',
      'New graphic (2)',
      'New graphic (3)',
    ]);
  });

  it('stores the attached files in refs/ and tells the run their names', async () => {
    const h = harness();
    const staging = await h.service.stagingDir();

    const detail = body(
      await h.service.create(
        send('Like this screenshot', {
          files: [
            stagedFile(staging, 'shot.png', 'png', 0),
            stagedFile(staging, 'shot.png', 'png 2', 1),
          ],
        }),
      ),
    );

    expect(detail.messages[0]?.refs).toEqual(['shot.png', 'shot (1).png']);
    expect(readdirSync(graphicRefsDir(h.folders.dirOf(detail.folder))).sort()).toEqual([
      'shot (1).png',
      'shot.png',
    ]);
    await vi.waitFor(() => expect(h.runner.requests).toHaveLength(1));
    expect(h.runner.requests[0]?.message.refs).toEqual(['shot.png', 'shot (1).png']);
  });

  it('takes a message that is only attachments', async () => {
    const h = harness();
    const staging = await h.service.stagingDir();

    const detail = body(
      await h.service.create(send('', { files: [stagedFile(staging, 'logo.svg')] })),
    );

    expect(detail.messages[0]).toMatchObject({ text: '', refs: ['logo.svg'] });
  });

  it('refuses a message with no text and no file, one that is too long, and too many files', async () => {
    const h = harness();
    const staging = await h.service.stagingDir();
    const files = Array.from({ length: GRAPHIC_LIMITS.refsMaxFiles + 1 }, (_, n) =>
      stagedFile(staging, `f${n}.png`, 'x', n),
    );

    expect(refusal(await h.service.create(send('   ')))).toEqual({
      status: 400,
      error: GRAPHIC_MESSAGES.textMissing,
    });
    expect(refusal(await h.service.create(send('x'.repeat(4001))))).toEqual({
      status: 400,
      error: GRAPHIC_MESSAGES.textTooLong,
    });
    expect(refusal(await h.service.create(send('x', { files })))).toEqual({
      status: 413,
      error: GRAPHIC_MESSAGES.tooManyFiles,
    });
    expect(
      refusal(
        await h.service.create(
          send('x', {
            files: [
              { name: 'big.mov', path: join(staging, '0'), size: GRAPHIC_LIMITS.refsMaxBytes + 1 },
            ],
          }),
        ),
      ),
    ).toEqual({ status: 413, error: GRAPHIC_MESSAGES.tooLarge });
    expect(h.repo.list()).toEqual([]);
    expect(await h.folders.names()).toEqual([]);
  });

  it('shows the list only the graphics that are not empty', async () => {
    const h = harness({ holdAll: true });
    const created = body(await h.service.create(send('A pill')));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    expect(body(await h.service.list()).map((graphic) => graphic.id)).toEqual([created.id]);

    body(await h.service.stop(created.id, created.messages[1]?.id as string));

    expect(h.repo.summary(created.id)?.status).toBe('empty');
    expect(body(await h.service.list())).toEqual([]);
    expect(body(await h.service.get(created.id)).status).toBe('empty');
  });
});

describe('make, change, use v1 again', () => {
  it('goes create → making → done, then a change → v2, then "Use v1 again" → v3', async () => {
    const h = harness();

    const first = await madeGraphic(h);
    expect(first).toMatchObject({
      name: 'Name on a white pill',
      status: 'ready',
      version: 1,
      kind: 'lower-third',
      lengthSec: 3,
    });
    expect(first.messages.map((message) => [message.role, message.status])).toEqual([
      ['you', null],
      ['claude', 'done'],
    ]);

    h.runner.canned = (request) => ({
      reply: `Made v${request.version}.`,
      variables: [
        { id: 'name', label: 'Name', default: 'Dana' },
        { id: 'role', label: 'Role', default: 'Lawyer' },
      ],
      lengthSec: 4,
    });
    const changing = await h.service.send(first.id, send('Add the role under the name'));
    expect(changing).toMatchObject({ ok: true, status: 202 });
    expect(body(changing)).toMatchObject({ status: 'making', makingVersion: 2 });
    const v2 = await settled(h, first.id);
    expect(v2).toMatchObject({ version: 2, lengthSec: 4, status: 'ready' });
    expect(v2.variables.map((variable) => variable.id)).toEqual(['name', 'role']);

    const restored = await h.service.restore(first.id, 1);

    expect(restored).toMatchObject({ ok: true, status: 200 });
    const v3 = body(restored);
    expect(v3).toMatchObject({ version: 3, status: 'ready', lengthSec: 3 });
    // v1’s text fields are the graphic’s again
    expect(v3.variables.map((variable) => variable.id)).toEqual(['name']);
    expect(v3.messages.at(-1)).toMatchObject({
      role: 'claude',
      status: 'done',
      version: 3,
      text: graphicRestoredText(1, 3),
    });
    expect(v3.messages.at(-1)?.text).toBe('v1 is back, as v3.');
    const versions = join(h.folders.dirOf(v3.folder), 'versions');
    expect(readdirSync(versions).sort()).toEqual(['v1', 'v2', 'v3']);
    expect(readFileSync(join(versions, 'v3', 'about.json'), 'utf8')).toBe(
      readFileSync(join(versions, 'v1', 'about.json'), 'utf8'),
    );
    // no run was made for it
    expect(h.runner.requests).toHaveLength(2);

    // and a change after it makes v4 from v3
    const next = await h.service.send(first.id, send('Now green'));
    expect(body(next).makingVersion).toBe(4);
    await settled(h, first.id);
    expect(h.runner.requests[2]).toMatchObject({ version: 4, first: false });
  });

  it('refuses "Use v1 again" for the version edits use, for a version it does not have, and while making', async () => {
    const h = harness();
    const made = await twoVersions(h);

    expect(refusal(await h.service.restore(made.id, 2))).toEqual({
      status: 409,
      error: GRAPHIC_MESSAGES.nothingToRestore,
    });
    expect(refusal(await h.service.restore(made.id, 7))).toEqual({
      status: 404,
      error: GRAPHIC_MESSAGES.versionNotFound,
    });
    expect(refusal(await h.service.restore('0a1b2c3d4e5f', 1))).toEqual({
      status: 404,
      error: GRAPHIC_MESSAGES.notFound,
    });

    h.runner.holdAll = true;
    body(await h.service.send(made.id, send('Again')));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    expect(refusal(await h.service.restore(made.id, 1))).toEqual({
      status: 409,
      error: graphicBusyMessage(3, 'restore'),
    });
  });

  it('refuses a message while the graphic is making, in the words of the 409', async () => {
    const h = harness({ holdAll: true });
    const created = body(await h.service.create(send('A pill')));

    expect(refusal(await h.service.send(created.id, send('More')))).toEqual({
      status: 409,
      error: 'Wait until v1 is made, then send your next message.',
    });
    expect(await h.service.sendable(created.id)).toMatchObject({ ok: false, status: 409 });
    expect(await h.service.sendable('0a1b2c3d4e5f')).toMatchObject({ status: 404 });
    expect(h.repo.messages(created.id)).toHaveLength(2);
  });

  it('takes one of two messages sent together, and refuses the other', async () => {
    const h = harness({ holdAll: true });
    const first = body(await h.service.create(send('A pill')));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    h.runner.holdAll = false;
    h.runner.releaseAll();
    await settled(h, first.id);
    h.runner.holdAll = true;

    const [a, b] = await Promise.all([
      h.service.send(first.id, send('One')),
      h.service.send(first.id, send('Two')),
    ]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.repo.messages(first.id).filter((message) => message.role === 'you')).toHaveLength(2);
  });

  it('refuses a message for a graphic it does not know', async () => {
    const h = harness();
    expect(refusal(await h.service.send('0a1b2c3d4e5f', send('x')))).toEqual({
      status: 404,
      error: GRAPHIC_MESSAGES.notFound,
    });
  });

  it('makes the next version after the newest one made, also after a failed try', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    h.runner.behaviour = async () => ({ ok: false, error: 'It broke.' });
    body(await h.service.send(made.id, send('Blue')));
    expect((await settled(h, made.id)).status).toBe('failed');
    h.runner.behaviour = undefined;

    const again = body(await h.service.send(made.id, send('Blue, please')));

    expect(again.makingVersion).toBe(2);
    expect((await settled(h, made.id)).version).toBe(2);
  });
});

describe('stop and retry', () => {
  it('stops a run: the row is stopped and the answer says so', async () => {
    const h = harness({ holdAll: true });
    const created = body(await h.service.create(send('A pill')));
    const claude = created.messages[1]?.id as string;
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    const outcome = await h.service.stop(created.id, claude);

    expect(outcome).toMatchObject({ ok: true, status: 200 });
    expect(body(outcome).messages[1]).toMatchObject({ status: 'stopped', step: null });
    expect(body(outcome).status).toBe('empty');
  });

  it('refuses to stop what is not being made, and what is not there', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    const done = made.messages[1]?.id as string;
    const mine = made.messages[0]?.id as string;

    expect(refusal(await h.service.stop(made.id, done))).toEqual({
      status: 409,
      error: GRAPHIC_MESSAGES.notMaking,
    });
    expect(refusal(await h.service.stop(made.id, mine)).status).toBe(409);
    expect(refusal(await h.service.stop(made.id, 'nope'))).toEqual({
      status: 404,
      error: GRAPHIC_MESSAGES.messageNotFound,
    });
    expect(refusal(await h.service.stop('0a1b2c3d4e5f', done)).status).toBe(404);
    const other = await madeGraphic(h);
    expect(refusal(await h.service.stop(other.id, done)).status).toBe(404);
  });

  it('retries a failed message: the same row makes its version again', async () => {
    const h = harness();
    h.runner.behaviour = async () => ({ ok: false, error: 'It broke.' });
    const created = body(await h.service.create(send('A pill')));
    const failed = await settled(h, created.id);
    const claude = failed.messages[1]?.id as string;
    expect(failed).toMatchObject({ status: 'failed', failedVersion: 1 });
    h.runner.behaviour = undefined;

    const outcome = await h.service.retry(created.id, claude);

    expect(outcome).toMatchObject({ ok: true, status: 202 });
    expect(body(outcome).messages[1]).toMatchObject({
      id: claude,
      status: 'making',
      error: null,
      step: 0,
      version: 1,
    });
    const done = await settled(h, created.id);
    expect(done).toMatchObject({ status: 'ready', version: 1, name: 'Name on a white pill' });
    expect(done.messages).toHaveLength(2);
  });

  it('retries a stopped message too', async () => {
    const h = harness({ holdAll: true });
    const created = body(await h.service.create(send('A pill')));
    const claude = created.messages[1]?.id as string;
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    await h.service.stop(created.id, claude);
    h.runner.holdAll = false;

    body(await h.service.retry(created.id, claude));

    expect((await settled(h, created.id)).version).toBe(1);
  });

  it('refuses to retry what did not fail, what is making, and a row an answer has passed', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    const done = made.messages[1]?.id as string;
    expect(refusal(await h.service.retry(made.id, done))).toEqual({
      status: 409,
      error: GRAPHIC_MESSAGES.notRetryable,
    });
    expect(refusal(await h.service.retry(made.id, 'nope')).status).toBe(404);

    // an old failed row, with a newer answer after it
    const old = h.repo.addMessage({
      graphicId: made.id,
      role: 'claude',
      version: 2,
      status: 'failed',
      error: 'It broke.',
    });
    h.repo.addMessage({
      graphicId: made.id,
      role: 'claude',
      version: 2,
      status: 'done',
      text: 'x',
    });
    expect(refusal(await h.service.retry(made.id, old.id)).error).toBe(
      GRAPHIC_MESSAGES.notRetryable,
    );

    // another run of the graphic is making
    const h2 = harness({ holdAll: true });
    const created = body(await h2.service.create(send('A pill')));
    const failed = h2.repo.addMessage({
      graphicId: created.id,
      role: 'claude',
      version: 1,
      status: 'failed',
      error: 'It broke.',
    });
    expect(refusal(await h2.service.retry(created.id, failed.id))).toEqual({
      status: 409,
      error: graphicBusyMessage(1, 'retry'),
    });
  });
});

describe('update: rename, When, Edits can use it', () => {
  it('renames the graphic and moves its folder', async () => {
    const h = harness();
    const made = await twoVersions(h);

    const outcome = await h.service.update(made.id, { name: '  Lower third / blue: v2  ' });

    expect(outcome).toMatchObject({ ok: true, status: 200 });
    expect(body(outcome)).toMatchObject({
      name: 'Lower third – blue– v2',
      folder: 'Lower third – blue– v2',
    });
    expect(await h.folders.names()).toEqual(['Lower third – blue– v2']);
    expect(existsSync(graphicVersionDir(h.folders.dirOf('Lower third – blue– v2'), 2))).toBe(true);
    const event = h.events.at(-1);
    expect(event).toMatchObject({
      type: 'graphic.changed',
      graphic: { name: 'Lower third – blue– v2' },
    });
  });

  it('refuses an empty name, a name another graphic has in any case, and a rename while making', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    h.repo.create({ name: 'Taken' });

    expect(refusal(await h.service.update(made.id, { name: ' ... ' }))).toEqual({
      status: 422,
      error: GRAPHIC_MESSAGES.nameEmpty,
    });
    expect(refusal(await h.service.update(made.id, { name: '   ' }))).toEqual({
      status: 422,
      error: GRAPHIC_MESSAGES.nameEmpty,
    });
    expect(refusal(await h.service.update(made.id, { name: 'tAKEN' }))).toEqual({
      status: 422,
      error: GRAPHIC_MESSAGES.nameTaken,
    });

    h.runner.holdAll = true;
    body(await h.service.send(made.id, send('More')));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    expect(refusal(await h.service.update(made.id, { name: 'Another' }))).toEqual({
      status: 409,
      error: graphicBusyMessage(2, 'rename'),
    });
    // its own name is not a rename, and the other fields still change while it is making
    expect(body(await h.service.update(made.id, { name: made.name, uses: false })).uses).toBe(
      false,
    );
    expect(h.repo.get(made.id)?.name).toBe('Name on a white pill');
  });

  it('refuses a name whose folder is on disk already, and keeps everything as it was', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    mkdirSync(join(h.inbox, '_Graphics', 'Somebody’s folder'));

    expect(refusal(await h.service.update(made.id, { name: 'somebody’s FOLDER' })).status).toBe(
      422,
    );
    expect(h.repo.get(made.id)?.name).toBe('Name on a white pill');
  });

  it('takes a change of case alone', async () => {
    const h = harness();
    const made = await madeGraphic(h);

    const outcome = await h.service.update(made.id, { name: 'NAME ON A WHITE PILL' });

    expect(body(outcome).name).toBe('NAME ON A WHITE PILL');
    expect(await h.folders.names()).toEqual(['NAME ON A WHITE PILL']);
  });

  it('keeps the owner’s When line from then on, and turns Edits can use it on and off', async () => {
    const h = harness();
    const made = await madeGraphic(h);

    const edited = body(
      await h.service.update(made.id, { when: '  When a name shows.  ', uses: false }),
    );

    expect(edited).toMatchObject({ when: 'When a name shows.', whenEdited: true, uses: false });
    h.runner.canned = (request) => ({
      reply: `Made v${request.version}.`,
      when: 'Something else.',
    });
    body(await h.service.send(made.id, send('More')));
    expect(await settled(h, made.id)).toMatchObject({
      when: 'When a name shows.',
      uses: false,
      version: 2,
    });
    expect(body(await h.service.update(made.id, { uses: true })).uses).toBe(true);
  });

  it('refuses a When line that is too long, and an unknown graphic', async () => {
    const h = harness();
    const made = await madeGraphic(h);

    expect(refusal(await h.service.update(made.id, { when: 'x'.repeat(201) }))).toEqual({
      status: 400,
      error: GRAPHIC_MESSAGES.whenTooLong,
    });
    expect(refusal(await h.service.update('0a1b2c3d4e5f', { uses: false })).status).toBe(404);
  });
});

describe('duplicate', () => {
  it('makes "<Name> copy" whose v1 is the version edits use, with its chat and its own id', async () => {
    const h = harness();
    const made = await twoVersions(h);
    h.repo.setWhen(made.id, 'When a name shows.');

    const outcome = await h.service.duplicate(made.id);

    expect(outcome).toMatchObject({ ok: true, status: 201 });
    const copy = body(outcome);
    expect(copy.id).not.toBe(made.id);
    expect(copy).toMatchObject({
      name: 'Name on a white pill copy',
      folder: 'Name on a white pill copy',
      version: 1,
      status: 'ready',
      kind: made.kind,
      lengthSec: 4,
      when: 'When a name shows.',
      whenEdited: true,
      uses: true,
    });
    expect(copy.variables.map((variable) => variable.id)).toEqual(['name', 'role']);
    expect(copy.messages).toHaveLength(1);
    expect(copy.messages[0]).toMatchObject({
      role: 'claude',
      status: 'done',
      version: 1,
      text: graphicCopiedText('Name on a white pill', 2),
    });
    expect(copy.messages[0]?.text).toBe('Copied from Name on a white pill v2.');
    // the copy is a graphic of its own: its files carry its id, and it passes the engine’s check
    const v1 = graphicVersionDir(h.folders.dirOf(copy.folder), 1);
    expect(existsSync(join(v1, 'compositions', `lib-${copy.id}.html`))).toBe(true);
    expect((await checkGraphicWork(v1, copy.id)).ok).toBe(true);
    // the original is untouched
    expect(h.repo.get(made.id)).toMatchObject({ version: 2, name: 'Name on a white pill' });
    expect(readdirSync(join(h.folders.dirOf(made.folder), 'versions')).sort()).toEqual([
      'v1',
      'v2',
    ]);
    expect(h.events.at(-1)).toMatchObject({ graphic: { id: copy.id } });
  });

  it('numbers a second copy, and runs a change on the copy from its own v1', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    const first = body(await h.service.duplicate(made.id));
    const second = body(await h.service.duplicate(made.id));
    expect([first.name, second.name]).toEqual([
      'Name on a white pill copy',
      'Name on a white pill copy (2)',
    ]);

    body(await h.service.send(first.id, send('Blue')));
    const changed = await settled(h, first.id);

    expect(changed.version).toBe(2);
    const request = h.runner.requests.at(-1);
    expect(request).toMatchObject({ version: 2, first: false, graphic: { id: first.id } });
    expect(
      (await checkGraphicWork(join(request?.graphic.dir as string, 'work'), first.id)).ok,
    ).toBe(true);
  });

  it('refuses a graphic with no version yet, and an unknown one', async () => {
    const h = harness({ holdAll: true });
    const created = body(await h.service.create(send('A pill')));

    expect(refusal(await h.service.duplicate(created.id))).toEqual({
      status: 409,
      error: GRAPHIC_MESSAGES.nothingToDuplicate,
    });
    expect(refusal(await h.service.duplicate('0a1b2c3d4e5f')).status).toBe(404);
    expect(h.repo.list()).toHaveLength(1);
  });

  it('can copy a graphic while it makes its next version', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    h.runner.holdAll = true;
    body(await h.service.send(made.id, send('More')));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    expect(body(await h.service.duplicate(made.id))).toMatchObject({ version: 1, status: 'ready' });
  });
});

describe('reveal', () => {
  it('shows the graphic’s folder in Finder', async () => {
    const h = harness();
    const made = await madeGraphic(h);

    expect(await h.service.reveal(made.id)).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(h.opened).toEqual([h.folders.dirOf('Name on a white pill')]);
  });

  it('answers 404 for an unknown graphic or a folder that is gone, and 500 when Finder fails', async () => {
    const h = harness({
      openFolder: async () => {
        throw new Error('no Finder');
      },
    });
    const made = await madeGraphic(h);

    expect(refusal(await h.service.reveal(made.id))).toEqual({
      status: 500,
      error: GRAPHIC_MESSAGES.revealFailed,
    });
    expect(refusal(await h.service.reveal('0a1b2c3d4e5f')).status).toBe(404);
    rmSync(h.folders.dirOf(made.folder), { recursive: true });
    expect(refusal(await h.service.reveal(made.id)).status).toBe(404);
  });
});

describe('remove', () => {
  it('moves the folder to the Trash, deletes the graphic and tells the browsers', async () => {
    const h = harness();
    const made = await twoVersions(h);

    const outcome = await h.service.remove(made.id);

    expect(outcome).toEqual({
      ok: true,
      status: 200,
      body: { ok: true, where: join(h.home, '.Trash', 'Name on a white pill') },
    });
    expect(existsSync(join(h.home, '.Trash', 'Name on a white pill', 'versions', 'v2'))).toBe(true);
    expect(await h.folders.names()).toEqual([]);
    expect(h.repo.get(made.id)).toBeNull();
    expect(refusal(await h.service.get(made.id)).status).toBe(404);
    expect(body(await h.service.list())).toEqual([]);
    expect(h.events.at(-1)).toEqual({ type: 'graphic.removed', id: made.id });
  });

  it('stops a run first, so nothing writes into the folder as it moves', async () => {
    const h = harness({ holdAll: true });
    const created = body(await h.service.create(send('A pill')));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    const outcome = await h.service.remove(created.id);

    expect(outcome.ok).toBe(true);
    expect(h.runner.requests[0]?.signal.aborted).toBe(true);
    expect(h.worker.isMaking(created.id)).toBe(false);
    expect(existsSync(join(h.home, '.Trash', 'New graphic'))).toBe(true);
    expect(h.repo.messages(created.id).at(-1)?.status).toBe('stopped');
  });

  it('keeps the folder in <data>/deleted-graphics/ when macOS would not take it, and says where', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    rmSync(join(h.home, '.Trash'), { recursive: true });
    writeFileSync(join(h.home, '.Trash'), 'not a folder');

    const outcome = body(await h.service.remove(made.id));

    expect(outcome.where).toBe(join(h.dataDir, 'deleted-graphics', 'Name on a white pill'));
    expect(existsSync(join(outcome.where, 'versions', 'v1', 'about.json'))).toBe(true);
    expect(h.repo.get(made.id)).toBeNull();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the graphic when neither the Trash nor the data folder can take it',
    async () => {
      const h = harness();
      const made = await madeGraphic(h);
      rmSync(join(h.home, '.Trash'), { recursive: true });
      writeFileSync(join(h.home, '.Trash'), 'not a folder');
      mkdirSync(h.dataDir, { recursive: true });
      chmodSync(h.dataDir, 0o500);
      try {
        expect(refusal(await h.service.remove(made.id))).toEqual({
          status: 500,
          error: GRAPHIC_MESSAGES.deleteFailed,
        });
        expect(h.repo.get(made.id)).not.toBeNull();
        expect(await h.folders.has(made.folder)).toBe(true);
      } finally {
        chmodSync(h.dataDir, 0o700);
      }
    },
  );

  it('deletes a graphic whose folder is already gone, and answers 404 for an unknown one', async () => {
    const h = harness();
    const made = await madeGraphic(h);
    rmSync(h.folders.dirOf(made.folder), { recursive: true });

    expect(body(await h.service.remove(made.id)).ok).toBe(true);
    expect(h.repo.get(made.id)).toBeNull();
    expect(refusal(await h.service.remove(made.id)).status).toBe(404);
  });
});

describe('the detail’s "Used in"', () => {
  it('is null while edits do not use the library', async () => {
    const h = harness({ usedIn: false });
    const made = await madeGraphic(h);
    h.repo.addUse(made.id, 'job000000001', 1);

    expect(body(await h.service.get(made.id)).usedIn).toBeNull();
  });

  it('counts the videos that used it once edits do', async () => {
    const h = harness({ usedIn: true });
    const made = await madeGraphic(h);
    h.repo.addUse(made.id, 'job000000001', 1);
    h.repo.addUse(made.id, 'job000000002', 1);

    expect(made.usedIn).toBe(0);
    expect(body(await h.service.get(made.id)).usedIn).toBe(2);
  });
});

describe('two at once', () => {
  it('runs two graphics at once and the third when one is over', async () => {
    const h = harness({ holdAll: true });
    const created = await Promise.all([
      h.service.create(send('one')),
      h.service.create(send('two')),
      h.service.create(send('three')),
    ]);

    await vi.waitFor(() => expect(h.runner.held).toHaveLength(2));
    expect(h.runner.active).toBe(2);
    h.runner.holdAll = false;
    h.runner.releaseAll();
    for (const outcome of created) await settled(h, body(outcome).id);
    expect(h.runner.peak).toBe(2);
    expect(h.runner.requests).toHaveLength(3);
  });
});

describe('the disabled service', () => {
  it('refuses everything with "Graphics are off."', async () => {
    const off = createDisabledGraphicService();
    const refused = { ok: false, status: 404, error: 'Graphics are off.' };

    expect(off.enabled).toBe(false);
    expect(await off.list()).toEqual(refused);
    expect(await off.get('x')).toEqual(refused);
    expect(await off.create(send('x'))).toEqual(refused);
    expect(await off.send('x', send('x'))).toEqual(refused);
    expect(await off.stop('x', 'y')).toEqual(refused);
    expect(await off.retry('x', 'y')).toEqual(refused);
    expect(await off.restore('x', 1)).toEqual(refused);
    expect(await off.update('x', { uses: true })).toEqual(refused);
    expect(await off.duplicate('x')).toEqual(refused);
    expect(await off.reveal('x')).toEqual(refused);
    expect(await off.remove('x')).toEqual(refused);
    expect(await off.sendable('x')).toEqual(refused);
  });
});

describe('a run that leaves a graphic with a text field the graphic does not use', () => {
  it('fails with the check’s sentence in the chat', async () => {
    const h = harness();
    h.runner.behaviour = async (request) => {
      writeCannedGraphic(join(request.graphic.dir, 'work'), request.graphic.id, 1, {
        name: 'Pill',
        variables: [{ id: 'name', label: 'Name', default: 'Dana' }],
      });
      writeFileSync(
        join(request.graphic.dir, 'work', 'about.json'),
        JSON.stringify({
          kind: 'title',
          lengthSec: 2,
          variables: [{ id: 'title', label: 'Title', default: 'Hi' }],
          when: 'Always.',
          reply: 'Made v1.',
        }),
      );
      return { ok: true };
    };

    const created = body(await h.service.create(send('A title')));
    const failed = await settled(h, created.id);

    expect(failed.status).toBe('failed');
    expect(failed.messages[1]?.error).toContain('does not declare the text field "title"');
  });
});
