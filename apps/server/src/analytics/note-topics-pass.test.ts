import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewNote } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobRepository, NoteRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { noteTopicsUsage } from '../usage/app-usage.js';
import { NoteTopicStore } from './note-topics.js';
import { MAX_NOTES_PER_PASS, NoteTopicPass, TOPIC_DEBOUNCE_MS } from './note-topics-pass.js';
import type {
  NoteTopicRunner,
  NoteTopicRunOutcome,
  NoteTopicRunRequest,
} from './note-topics-run.js';

// The pass on real repositories (in-memory database), a real note-topics.json in a temp folder and
// a stand-in for the Claude run whose answer the test decides: no model, no process.

let dataDir: string;
let db: StudioDb;
let jobs: JobRepository;
let notes: NoteRepository;
let store: Pick<NoteTopicStore, 'get' | 'add'>;
let clock: ReturnType<typeof fakeClock>;
let counter: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'studio-note-topics-pass-'));
  clock = fakeClock();
  db = memoryDb();
  jobs = new JobRepository(db, { clock });
  notes = new NoteRepository(db, { clock });
  store = new NoteTopicStore(dataDir);
  counter = 0;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A job of the client, and a sent note on it per text (one round, sent now). */
function sendNotes(client: string, texts: string[], jobName = 'Ep 1'): ReviewNote[] {
  const { job } = jobs.upsertFromScan(makeScan(client, jobName));
  const ids = texts.map((text) => {
    const id = `n${++counter}`;
    notes.create({ id, jobId: job.id, kind: 'text', atSec: counter, text });
    return id;
  });
  clock.tick();
  return notes.markSent(job.id, ids, 1, clock().toISOString());
}

/** A sent voice note: its transcript is `text`, or failed when that is null. */
function sendVoiceNote(client: string, text: string | null): ReviewNote {
  const { job } = jobs.upsertFromScan(makeScan(client, 'Voice job'));
  const id = `n${++counter}`;
  notes.create({
    id,
    jobId: job.id,
    kind: 'voice',
    atSec: counter,
    audioFile: `edit/review/voice/${id}.webm`,
    audioSec: 5,
  });
  notes.setTranscript(id, text === null ? { status: 'failed' } : { status: 'done', text });
  clock.tick();
  const [sent] = notes.markSent(job.id, [id], 1, clock().toISOString());
  if (sent === undefined) throw new Error('the voice note was not sent');
  return sent;
}

/** The notes of a prompt, from its JSON lines. */
function notesOf(prompt: string): Array<{ id: string; client: string; text: string }> {
  const lines = prompt.split('\n');
  return lines
    .slice(lines.indexOf('Notes, one JSON object per line:') + 1)
    .map((line) => JSON.parse(line));
}

function topicsInUseOf(prompt: string): string[] {
  const lines = prompt.split('\n');
  const from = lines.indexOf('Topics already in use:') + 1;
  const to = lines.indexOf('Notes, one JSON object per line:') - 1;
  return lines.slice(from, to).map((line) => line.replace(/^- /, ''));
}

/** A Claude run that records its requests and answers each with `answer`. */
function stubRunner(
  answer: (request: NoteTopicRunRequest) => NoteTopicRunOutcome | Promise<NoteTopicRunOutcome>,
) {
  const calls: NoteTopicRunRequest[] = [];
  const runner: NoteTopicRunner = {
    async run(request) {
      calls.push(request);
      return answer(request);
    },
  };
  return { runner, calls };
}

/** An answer that gives every note of the prompt the topic `topicOf` says. */
function labelling(topicOf: (note: { id: string; text: string }) => string) {
  return (request: NoteTopicRunRequest): NoteTopicRunOutcome => ({
    ok: true,
    text: JSON.stringify(
      notesOf(request.prompt).map((note) => ({ id: note.id, topic: topicOf(note) })),
    ),
  });
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function pass(runner: NoteTopicRunner, options: { debounceMs?: number } = {}) {
  const log = logger();
  return {
    log,
    pass: new NoteTopicPass({ notes, jobs, store, runner, logger: log, ...options }),
  };
}

describe('a pass', () => {
  it('gives the notes that have text a topic, with the client of each, and logs the usage line', async () => {
    sendNotes('Kova Coffee', ['The intro is too long', 'הכתוביות מכסות את הידיים']);
    sendNotes('Northwind Bakery', ['Music is too loud']);
    sendVoiceNote('Kova Coffee', 'cut the pause before the end');
    sendVoiceNote('Kova Coffee', null); // a transcript that failed has no text: not grouped
    const topics: Record<string, string> = {
      n1: 'intro too long',
      n2: 'subtitles cover hands',
      n3: 'music too loud',
      n4: 'pause before end',
    };
    const stub = stubRunner(labelling((note) => topics[note.id] ?? 'wrong'));
    const { pass: topicPass } = pass(stub.runner);

    const result = await topicPass.run();

    expect(result).toEqual({ status: 'grouped', grouped: 4, asked: 4 });
    expect(store.get()).toEqual(topics);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call?.usage).toEqual(noteTopicsUsage(4));
    expect(call?.usage.did).toBe('Grouped 4 review notes into topics');
    expect(notesOf(call?.prompt ?? '')).toEqual([
      { id: 'n1', client: 'Kova Coffee', text: 'The intro is too long' },
      { id: 'n2', client: 'Kova Coffee', text: 'הכתוביות מכסות את הידיים' },
      { id: 'n3', client: 'Northwind Bakery', text: 'Music is too loud' },
      { id: 'n4', client: 'Kova Coffee', text: 'cut the pause before the end' },
    ]);
    expect(topicsInUseOf(call?.prompt ?? '')).toEqual(['(none yet)']);
  });

  it('is idempotent: with every note grouped it asks nobody, and a later note is asked alone', async () => {
    sendNotes('Kova Coffee', ['The intro is too long', 'The intro drags']);
    const stub = stubRunner(labelling(() => 'intro too long'));
    const { pass: topicPass } = pass(stub.runner);

    await topicPass.run();
    expect(await topicPass.run()).toEqual({ status: 'nothing' });
    expect(await topicPass.run()).toEqual({ status: 'nothing' });
    expect(stub.calls).toHaveLength(1);
    const before = store.get();

    sendNotes('Kova Coffee', ['Intro again'], 'Ep 2');
    sendNotes('Kova Coffee', ['Fix the colours'], 'Ep 3');
    await topicPass.run();

    expect(stub.calls).toHaveLength(2);
    expect(notesOf(stub.calls[1]?.prompt ?? '').map((note) => note.id)).toEqual(['n3', 'n4']);
    // The topics already in use go in the prompt, so the model can reuse them.
    expect(topicsInUseOf(stub.calls[1]?.prompt ?? '')).toEqual(['intro too long']);
    expect(store.get()).toMatchObject(before);
    expect(Object.keys(store.get())).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('lists the topics in use with the most used first', async () => {
    sendNotes('A', ['one', 'two', 'three']);
    await store.add({ n1: 'music too loud', n2: 'intro too long', n3: 'intro too long' });
    sendNotes('A', ['four'], 'Ep 2');
    const stub = stubRunner(labelling(() => 'intro too long'));

    await pass(stub.runner).pass.run();

    expect(topicsInUseOf(stub.calls[0]?.prompt ?? '')).toEqual([
      'intro too long',
      'music too loud',
    ]);
  });

  it('keeps only the topics for notes it asked about, and asks again about a note it skipped', async () => {
    sendNotes('Kova Coffee', ['one', 'two', 'three']);
    const stub = stubRunner(() => ({
      ok: true,
      text: JSON.stringify([
        { id: 'n1', topic: 'intro too long' },
        { id: 'n9', topic: 'not a note of this pass' },
        { id: 'n2', topic: 'הכותרת' },
      ]),
    }));
    const { pass: topicPass } = pass(stub.runner);

    expect(await topicPass.run()).toEqual({ status: 'grouped', grouped: 1, asked: 3 });
    expect(store.get()).toEqual({ n1: 'intro too long' });

    await topicPass.run();
    expect(notesOf(stub.calls[1]?.prompt ?? '').map((note) => note.id)).toEqual(['n2', 'n3']);
  });
});

describe('a pass that fails', () => {
  it('logs it, writes nothing and tries again at the next trigger', async () => {
    sendNotes('Kova Coffee', ['The intro is too long']);
    const answers: NoteTopicRunOutcome[] = [
      { ok: false, error: 'Note topics stopped: Claude Code was not found.' },
      { ok: true, text: 'Sure! n1 is about the intro.' },
      { ok: true, text: '[]' },
      { ok: true, text: '[{"id":"n1","topic":"intro too long"}]' },
    ];
    const stub = stubRunner(() => answers.shift() ?? { ok: false, error: 'no more answers' });
    const { pass: topicPass, log } = pass(stub.runner);

    expect(await topicPass.run()).toEqual({
      status: 'failed',
      error: 'Note topics stopped: Claude Code was not found.',
    });
    expect(await topicPass.run()).toEqual({ status: 'failed', error: 'the answer is not JSON' });
    expect((await topicPass.run()).status).toBe('failed');
    expect(store.get()).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(3);

    expect(await topicPass.run()).toEqual({ status: 'grouped', grouped: 1, asked: 1 });
    expect(store.get()).toEqual({ n1: 'intro too long' });
  });

  it('never throws, whatever breaks', async () => {
    sendNotes('Kova Coffee', ['The intro is too long']);
    const broken = pass(
      stubRunner(() => {
        throw new Error('the runner broke');
      }).runner,
    );
    expect(await broken.pass.run()).toEqual({ status: 'failed', error: 'the runner broke' });

    const unwritable = pass(stubRunner(labelling(() => 'intro too long')).runner);
    vi.spyOn(store, 'add').mockRejectedValue(new Error('disk full'));
    expect(await unwritable.pass.run()).toEqual({ status: 'failed', error: 'disk full' });
    expect(unwritable.log.warn).toHaveBeenCalledTimes(1);
  });

  it('does not start when there is nothing to group', async () => {
    const stub = stubRunner(labelling(() => 'x'));
    expect(await pass(stub.runner).pass.run()).toEqual({ status: 'nothing' });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('one pass at a time', () => {
  it('shares the running pass with whoever asks while it runs', async () => {
    sendNotes('Kova Coffee', ['The intro is too long']);
    let finish: (outcome: NoteTopicRunOutcome) => void = () => {};
    const stub = stubRunner(
      () =>
        new Promise<NoteTopicRunOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const { pass: topicPass } = pass(stub.runner);

    const first = topicPass.run();
    const second = topicPass.run();
    expect(second).toBe(first);
    expect(stub.calls).toHaveLength(1);

    finish({ ok: true, text: '[{"id":"n1","topic":"intro too long"}]' });
    expect(await first).toEqual({ status: 'grouped', grouped: 1, asked: 1 });
  });
});

/** A store in memory: with fake timers a write to a file would not be waited for. */
function memoryStore(): Pick<NoteTopicStore, 'get' | 'add'> {
  let topics: Record<string, string> = {};
  return {
    get: () => topics,
    add: async (added) => {
      const fresh = Object.entries(added).filter(([id]) => !Object.hasOwn(topics, id));
      topics = { ...topics, ...Object.fromEntries(fresh) };
      return fresh.length;
    },
  };
}

describe('triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store = memoryStore();
  });

  it('wait for things to go quiet, so a burst of Sends makes one run', async () => {
    sendNotes('Kova Coffee', ['The intro is too long']);
    const stub = stubRunner(labelling(() => 'intro too long'));
    const { pass: topicPass } = pass(stub.runner);
    expect(TOPIC_DEBOUNCE_MS).toBe(30_000);

    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(20_000);
    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(20_000);
    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(stub.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(1);
    expect(store.get()).toEqual({ n1: 'intro too long' });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(stub.calls).toHaveLength(1);
  });

  it('run another pass for notes sent while one runs', async () => {
    sendNotes('Kova Coffee', ['The intro is too long']);
    let finish: (outcome: NoteTopicRunOutcome) => void = () => {};
    const stub = stubRunner(
      (request) =>
        new Promise<NoteTopicRunOutcome>((resolve) => {
          finish = resolve;
          if (request.prompt.includes('Fix the colours')) {
            resolve(labelling(() => 'colour grade')(request));
          }
        }),
    );
    const { pass: topicPass } = pass(stub.runner, { debounceMs: 1_000 });

    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(1);

    sendNotes('Kova Coffee', ['Fix the colours'], 'Ep 2');
    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stub.calls).toHaveLength(1); // still the first one

    finish({ ok: true, text: '[{"id":"n1","topic":"intro too long"}]' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(2);
    expect(store.get()).toEqual({ n1: 'intro too long', n2: 'colour grade' });
  });

  it('go on with a backlog, MAX_NOTES_PER_PASS notes at a time, oldest first', async () => {
    const texts = Array.from({ length: MAX_NOTES_PER_PASS + 5 }, (_, i) => `note ${i + 1}`);
    sendNotes('Kova Coffee', texts);
    const stub = stubRunner(labelling(() => 'general feedback'));
    const { pass: topicPass } = pass(stub.runner, { debounceMs: 1_000 });

    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(1);
    expect(notesOf(stub.calls[0]?.prompt ?? '')).toHaveLength(MAX_NOTES_PER_PASS);
    expect(Object.keys(store.get())).toHaveLength(MAX_NOTES_PER_PASS);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(2);
    expect(notesOf(stub.calls[1]?.prompt ?? '')).toHaveLength(5);
    expect(Object.keys(store.get())).toHaveLength(MAX_NOTES_PER_PASS + 5);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.calls).toHaveLength(2);
  });

  it('do not loop on a backlog that gets nowhere', async () => {
    sendNotes(
      'Kova Coffee',
      Array.from({ length: MAX_NOTES_PER_PASS + 5 }, (_, i) => `note ${i}`),
    );
    const stub = stubRunner(() => ({ ok: false, error: 'Note topics stopped: no.' }));
    const { pass: topicPass } = pass(stub.runner, { debounceMs: 1_000 });

    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stub.calls).toHaveLength(1);
  });
});

describe('stop', () => {
  it('cancels a pass that is waiting', async () => {
    vi.useFakeTimers();
    sendNotes('Kova Coffee', ['The intro is too long']);
    const stub = stubRunner(labelling(() => 'intro too long'));
    const { pass: topicPass } = pass(stub.runner);

    topicPass.trigger();
    await topicPass.stop();
    topicPass.trigger();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(stub.calls).toHaveLength(0);
  });

  it('aborts the run that is going on, waits for it and does not call it a failure', async () => {
    sendNotes('Kova Coffee', ['The intro is too long']);
    const stub = stubRunner(
      (request) =>
        new Promise<NoteTopicRunOutcome>((resolve) => {
          request.signal.addEventListener('abort', () =>
            resolve({ ok: false, error: 'Note topics stopped: the run was stopped.' }),
          );
        }),
    );
    const { pass: topicPass, log } = pass(stub.runner);

    const running = topicPass.run();
    expect(stub.calls[0]?.signal.aborted).toBe(false);
    await topicPass.stop();

    expect(stub.calls[0]?.signal.aborted).toBe(true);
    expect((await running).status).toBe('failed');
    expect(store.get()).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
    expect(await topicPass.run()).toEqual({ status: 'nothing' });
  });
});
