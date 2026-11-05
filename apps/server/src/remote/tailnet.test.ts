import { describe, expect, it } from 'vitest';
import {
  configuredAccess,
  createTailnet,
  TAILNET_REFRESH_MS,
  type TailnetTimers,
} from './tailnet.js';

const status = (dnsName: string, login: string) => ({
  Self: { DNSName: `${dnsName}.`, UserID: 7 },
  User: { '7': { LoginName: login } },
});

/** Interval timers the test fires by hand. */
function manualIntervals() {
  const running = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: TailnetTimers = {
    setInterval(callback, ms) {
      next += 1;
      running.set(next, { callback, ms });
      return next;
    },
    clearInterval(handle) {
      running.delete(handle as number);
    },
  };
  return {
    timers,
    get running() {
      return [...running.values()];
    },
    tick() {
      for (const { callback } of running.values()) callback();
    },
  };
}

/** A `tailscale status` the test answers: each read takes the next answer (an Error rejects). */
function scriptedStatus(...answers: unknown[]) {
  let reads = 0;
  return {
    read: async () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    get reads() {
      return reads;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTailnet', () => {
  it('lets nobody in from outside until Tailscale has been read', () => {
    const tailnet = createTailnet({ readStatus: scriptedStatus(status('mac.ts.net', 'a@b')).read });
    expect(tailnet.current()).toEqual({ hosts: [], logins: [] });
  });

  it("reads the Mac's name and owner at start, then every 5 minutes", async () => {
    const intervals = manualIntervals();
    const tailscale = scriptedStatus(
      status('studio-mac.tail1234.ts.net', 'owner@example.com'),
      status('renamed-mac.tail1234.ts.net', 'owner@example.com'),
    );
    const tailnet = createTailnet({ readStatus: tailscale.read, timers: intervals.timers });

    tailnet.start();
    await settle();
    expect(tailnet.current()).toEqual({
      hosts: ['studio-mac.tail1234.ts.net'],
      logins: ['owner@example.com'],
    });
    expect(intervals.running.map((r) => r.ms)).toEqual([TAILNET_REFRESH_MS]);
    expect(TAILNET_REFRESH_MS).toBe(300_000);

    intervals.tick();
    await settle();
    expect(tailscale.reads).toBe(2);
    expect(tailnet.current().hosts).toEqual(['renamed-mac.tail1234.ts.net']);

    tailnet.stop();
    expect(intervals.running).toEqual([]);
  });

  it('keeps what the last good read said when a read fails, and logs that once', async () => {
    const warnings: string[] = [];
    const tailscale = scriptedStatus(
      status('studio-mac.ts.net', 'owner@example.com'),
      new Error('Tailscale is stopped'),
    );
    const tailnet = createTailnet({
      readStatus: tailscale.read,
      timers: manualIntervals().timers,
      logger: { info: () => {}, warn: (_obj, msg) => warnings.push(msg) },
    });

    await tailnet.refresh();
    await tailnet.refresh();
    await tailnet.refresh();

    expect(tailnet.current()).toEqual({
      hosts: ['studio-mac.ts.net'],
      logins: ['owner@example.com'],
    });
    expect(warnings).toHaveLength(1);
  });

  it("config.json's lists replace what Tailscale says, one list or both", async () => {
    const tailscale = scriptedStatus(status('studio-mac.ts.net', 'owner@example.com'));

    const logins = createTailnet({
      readStatus: tailscale.read,
      remoteLogins: ['owner@example.com', 'partner@example.com'],
    });
    await logins.refresh();
    expect(logins.current()).toEqual({
      hosts: ['studio-mac.ts.net'],
      logins: ['owner@example.com', 'partner@example.com'],
    });

    const nobody = createTailnet({ readStatus: tailscale.read, remoteHosts: [] });
    await nobody.refresh();
    expect(nobody.current().hosts).toEqual([]);
  });

  it('never asks Tailscale when config.json names both lists', async () => {
    const intervals = manualIntervals();
    const tailscale = scriptedStatus(status('studio-mac.ts.net', 'owner@example.com'));
    const tailnet = createTailnet({
      readStatus: tailscale.read,
      timers: intervals.timers,
      remoteHosts: ['mac.example.ts.net'],
      remoteLogins: ['owner@example.com'],
    });

    tailnet.start();
    await settle();

    expect(tailscale.reads).toBe(0);
    expect(intervals.running).toEqual([]);
    expect(tailnet.current()).toEqual({
      hosts: ['mac.example.ts.net'],
      logins: ['owner@example.com'],
    });
  });

  it('starts once', async () => {
    const intervals = manualIntervals();
    const tailscale = scriptedStatus(status('studio-mac.ts.net', 'owner@example.com'));
    const tailnet = createTailnet({ readStatus: tailscale.read, timers: intervals.timers });
    tailnet.start();
    tailnet.start();
    await settle();
    expect(tailscale.reads).toBe(1);
    expect(intervals.running).toHaveLength(1);
  });
});

describe('configuredAccess', () => {
  it('is what config.json says, and nobody when it says nothing', () => {
    expect(configuredAccess({})).toEqual({ hosts: [], logins: [] });
    expect(configuredAccess({ remoteHosts: ['m.ts.net'], remoteLogins: ['a@b'] })).toEqual({
      hosts: ['m.ts.net'],
      logins: ['a@b'],
    });
  });
});
