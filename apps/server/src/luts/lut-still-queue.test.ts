import { describe, expect, it } from 'vitest';
import { createStillQueue } from './lut-still-queue.js';

/** A job that waits until `release()` is called. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

describe('the still queue', () => {
  it('runs at most `concurrency` jobs at a time and runs the rest as slots free up', async () => {
    const queue = createStillQueue(2);
    let running = 0;
    let peak = 0;
    const gates = [gate(), gate(), gate(), gate()];
    const results = gates.map((g, i) =>
      queue.run(`k${i}`, 'now', async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.opened;
        running -= 1;
        return i;
      }),
    );
    await Promise.resolve();
    expect(running).toBe(2);
    gates[0]?.release();
    gates[1]?.release();
    gates[2]?.release();
    gates[3]?.release();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('shares one run between callers of the same key', async () => {
    const queue = createStillQueue(2);
    const g = gate();
    let runs = 0;
    const work = async () => {
      runs += 1;
      await g.opened;
      return 'done';
    };
    const a = queue.run('same', 'now', work);
    const b = queue.run('same', 'now', work);
    const c = queue.run('same', 'background', work);
    g.release();
    expect(await Promise.all([a, b, c])).toEqual(['done', 'done', 'done']);
    expect(runs).toBe(1);
    // Once it is over the key is free again.
    expect(await queue.run('same', 'now', async () => 'again')).toBe('again');
  });

  it('starts a request before the background jobs that wait, and moves a waiting job up', async () => {
    const queue = createStillQueue(1);
    const order: string[] = [];
    const block = gate();
    const job = (name: string) => async () => {
      order.push(name);
      return name;
    };
    const first = queue.run('first', 'now', async () => {
      await block.opened;
      order.push('first');
    });
    const w1 = queue.run('w1', 'background', job('w1'));
    const w2 = queue.run('w2', 'background', job('w2'));
    const w3 = queue.run('w3', 'background', job('w3'));
    const asked = queue.run('asked', 'now', job('asked'));
    // The page asks for w3, which is only being warmed: it goes up with the requests.
    const w3Again = queue.run('w3', 'now', job('never'));
    block.release();
    await Promise.all([first, w1, w2, w3, asked, w3Again]);
    expect(order).toEqual(['first', 'asked', 'w3', 'w1', 'w2']);
  });

  it('tells a job the priority it started with', async () => {
    const queue = createStillQueue(1);
    const block = gate();
    const seen: string[] = [];
    const first = queue.run('a', 'now', async () => {
      await block.opened;
    });
    const waiting = queue.run('b', 'background', async (priority) => {
      seen.push(priority);
    });
    const promoted = queue.run('b', 'now', async () => {});
    block.release();
    await Promise.all([first, waiting, promoted]);
    expect(seen).toEqual(['now']);
  });

  it('rejects the callers of a job that fails, and goes on with the next', async () => {
    const queue = createStillQueue(1);
    const failing = queue.run('bad', 'now', async () => {
      throw new Error('boom');
    });
    const fine = queue.run('good', 'now', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(fine).resolves.toBe('ok');
  });
});
