import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewNote } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../test-temp.js';
import { FeedService, withNotes } from './feed-service.js';

const JOB_ID = 'abc123def456';

function harness(sent: ReviewNote[] = []) {
  const root = makeTempDir('studio-engine-feed-');
  const logsDir = join(root, 'logs');
  mkdirSync(join(logsDir, 'jobs'), { recursive: true });
  const logPath = join(logsDir, 'jobs', `${JOB_ID}.log`);
  const service = new FeedService({
    logsDir,
    feedsDir: join(root, 'feeds'),
    notes: { listSent: () => sent },
    logger: { warn: vi.fn() },
  });
  return { root, logPath, service, pictures: join(root, 'feeds', JOB_ID, 'img') };
}

const start = (runKind: string, mode = 'start') =>
  JSON.stringify({ type: 'studio_engine', event: 'start', at: 'x', runKind, mode, cwd: '/j' });
const end = JSON.stringify({ type: 'studio_engine', event: 'end', at: 'y', outcome: 'succeeded' });
const say = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const look = (id: string) => [
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/j/edit/a.png' } }],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: Buffer.from('png!').toString('base64'),
              },
            },
          ],
        },
      ],
    },
  }),
];

function note(round: number, text: string): ReviewNote {
  return {
    id: `n-${round}-${text}`,
    jobId: JOB_ID,
    round,
    atSec: 1,
    kind: 'text',
    text,
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: false,
    addToSeries: false,
    createdAt: '2026-10-28T10:00:00.000Z',
    sentAt: '2026-10-28T10:01:00.000Z',
  } as ReviewNote;
}

describe('FeedService', () => {
  it('has an empty chat for a job whose log is not there yet', async () => {
    const { service } = harness();
    expect(await service.feed(JOB_ID)).toEqual({ jobId: JOB_ID, rev: 0, items: [] });
  });

  it('reads only what the log added since, and keeps back a line that is not whole yet', async () => {
    const { service, logPath } = harness();
    writeFileSync(logPath, `${start('edit')}\n${say('One.')}\n`);
    const first = await service.feed(JOB_ID);
    expect(first.rev).toBe(2);
    expect(first.items.map((item) => item.kind)).toEqual(['run', 'text']);

    // Half a line: nothing new yet.
    const line = say('Two.');
    appendFileSync(logPath, line.slice(0, 20));
    expect((await service.feed(JOB_ID)).rev).toBe(2);

    appendFileSync(logPath, `${line.slice(20)}\n${end}\n`);
    const second = await service.feed(JOB_ID);
    expect(second.rev).toBe(4);
    expect(second.items[1]).toMatchObject({ kind: 'text', text: 'One.\n\nTwo.' });
    expect(second.items[0]).toMatchObject({ kind: 'run', outcome: 'succeeded' });
  });

  it('saves each picture once under the name the chat gives it, and serves only those names', async () => {
    const { service, logPath, pictures } = harness();
    writeFileSync(logPath, `${[start('edit'), ...look('t1')].join('\n')}\n`);
    const feed = await service.feed(JOB_ID);
    expect(feed.items[1]).toMatchObject({ kind: 'images', images: [{ name: 'L3-0-0.png' }] });
    expect(readdirSync(pictures)).toEqual(['L3-0-0.png']);
    expect(service.picturePath(JOB_ID, 'L3-0-0.png')).toBe(join(pictures, 'L3-0-0.png'));
    expect(service.picturePath(JOB_ID, '../x.png')).toBeNull();
    expect(service.picturePath(JOB_ID, 'L9-0-0.png')).toBeNull();
    expect(service.picturePath('../etc', 'L3-0-0.png')).toBeNull();
  });

  it('builds the same chat again after it was forgotten, finding its pictures there', async () => {
    const { service, logPath } = harness();
    writeFileSync(logPath, `${[start('edit'), ...look('t1'), say('Done.')].join('\n')}\n`);
    const before = await service.feed(JOB_ID);
    service.forget(JOB_ID);
    expect(await service.feed(JOB_ID)).toEqual(before);
  });

  it('starts the chat over when the log was made again', async () => {
    const { service, logPath } = harness();
    writeFileSync(logPath, `${start('edit')}\n${say('A long first line of the old log.')}\n`);
    await service.feed(JOB_ID);
    writeFileSync(logPath, `${start('revise')}\n`);
    const feed = await service.feed(JOB_ID);
    expect(feed.rev).toBe(1);
    expect(feed.items).toEqual([expect.objectContaining({ run: 'round', round: 1 })]);
  });

  it('puts each round’s sent notes on its first divider', async () => {
    const { service, logPath } = harness([note(1, 'Shorter hook'), note(2, 'Louder music')]);
    writeFileSync(
      logPath,
      `${[start('edit'), end, start('revise'), end, start('revise', 'resume'), end, start('revise'), end].join('\n')}\n`,
    );
    const runs = (await service.feed(JOB_ID)).items.filter((item) => item.kind === 'run');
    expect(
      runs.map((run) => (run.kind === 'run' ? [run.round, run.notes.map((n) => n.text)] : null)),
    ).toEqual([
      [null, []],
      [1, ['Shorter hook']],
      [1, []],
      [2, ['Louder music']],
    ]);
  });

  it('never reads the same bytes twice when two looks come at once', async () => {
    const { service, logPath } = harness();
    writeFileSync(logPath, `${start('edit')}\n${say('Once.')}\n`);
    const [a, b] = await Promise.all([service.feed(JOB_ID), service.feed(JOB_ID)]);
    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(2);
  });

  it('looks at the running jobs on its own until stopped', async () => {
    vi.useFakeTimers();
    try {
      const { service, logPath, pictures } = harness();
      writeFileSync(logPath, `${[start('edit'), ...look('t1')].join('\n')}\n`);
      service.start(() => [JOB_ID], 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(existsSync(join(pictures, 'L3-0-0.png'))).toBe(true));
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withNotes', () => {
  it('leaves the items alone when no round was sent', () => {
    const items = [{ id: 'L1', at: null, kind: 'text' as const, text: 'x' }];
    expect(withNotes(items, [])).toEqual(items);
  });
});
