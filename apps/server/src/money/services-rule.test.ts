import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  deriveServiceCharges,
  moneyFileSchema,
  SERVICES,
  serviceOfHost,
  serviceRuleProblems,
  type UsageEntry,
} from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { SERVICE_CHARGE_ITEMS } from './service-charges.js';

// The rule of CLAUDE.md › APIs and services, as a test. A new API that the code reaches fails here
// until it is in the service registry (so it shows on the Analytics page), and a new PAID API fails
// until it says how its money reaches the Money page.

const REPO = join(import.meta.dirname, '..', '..', '..', '..');

/** The code that reaches the network: the engine, its scripts and their prompts, and the doctor. */
const SCAN = ['apps/server/src', 'apps/server/assets', 'apps/server/prompts', 'scripts'];

/** Folders and files that are not production code: tests, their stand-ins and build output. */
const SKIP =
  /(^|\/)(node_modules|dist|testdata|__fixtures__)(\/|$)|\.test\.[cm]?[jt]sx?$|test-utils\.ts$/;

/**
 * Hosts that are not APIs the engine calls: placeholders and examples, local addresses, the
 * addresses of a phone reached over Tailscale, an XML namespace, and the pages the doctor and the
 * install notes point the owner at. Adding a host here is a decision that it is not an API.
 */
const NOT_AN_API = [
  /^(\d{1,3}\.){3}\d{1,3}(\.|$)/,
  /(^|\.)(example|invalid|test|localhost)(\.\w+)?$/,
  /(^|\.)example\.(com|org|net)$/,
  /(^|\.)ts\.net$/,
  /^(www\.)?w3\.org$/,
  /^(www\.)?github\.com$/,
  /^brew\.sh$/,
  /^astral\.sh$/,
  /^tailscale\.com$/,
  /^gsap\.com$/,
  /^(www\.)?apple\.com$/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (SKIP.test(relative(REPO, path))) continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mjs|js|md|sh)$/.test(name)) out.push(path);
  }
  return out;
}

function hostsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
}

describe('services rule', () => {
  it('has every paid service say how it reaches the Money page, and no free one claim to', () => {
    expect(serviceRuleProblems()).toEqual([]);
  });

  it('catches a paid service with no Money connection', () => {
    expect(
      serviceRuleProblems([
        { id: 'new-api', name: 'New API', cost: 'paid', forWhat: 'x', hosts: ['new.example'] },
      ]),
    ).toEqual([
      'new-api is paid but says nothing about how it reaches the Money page (money: subscription, perUse or gap)',
    ]);
  });

  it('knows every host the code reaches, so every API is on the Analytics page', () => {
    const unknown = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const dir of SCAN) {
      for (const file of sourceFiles(join(REPO, dir))) {
        for (const host of hostsIn(readFileSync(file, 'utf8'))) {
          seen.add(host);
          if (serviceOfHost(host) !== undefined || NOT_AN_API.some((rule) => rule.test(host)))
            continue;
          unknown.set(host, [...(unknown.get(host) ?? []), relative(REPO, file)]);
        }
      }
    }
    // The scan really reads the code: the APIs it is known to call are among what it found.
    expect([...seen]).toEqual(
      expect.arrayContaining(['api.higgsfield.ai', 'api.elevenlabs.io', 'api.openverse.org']),
    );
    expect(
      Object.fromEntries(unknown),
      'Add the API to SERVICES in packages/shared/src/domain/services.ts (paid ones also say how they reach Money); see CLAUDE.md › APIs and services',
    ).toEqual({});
  });

  it('has a per-job charge for every service that says perUse', () => {
    const perUse = SERVICES.filter(
      (service) => 'money' in service && 'perUse' in service.money,
    ).map((service) => service.name);
    expect([...SERVICE_CHARGE_ITEMS].sort()).toEqual(perUse.sort());
  });

  it('derives charges under exactly those names', () => {
    const money = moneyFileSchema.parse({
      subscriptions: [
        {
          id: 'elevenlabs',
          name: 'ElevenLabs',
          amount: 6,
          currency: 'USD',
          every: 'month',
          day: 1,
          since: '2026-10-01',
        },
      ],
    });
    const music: UsageEntry = {
      at: '2026-10-25T10:00:00.000Z',
      from: null,
      source: 'app',
      tag: 'music',
      did: 'Made music v1 for A / B (0:30)',
      session: null,
      client: 'A',
      job: { id: 'j', name: 'B' },
      usage: {},
    };
    const charges = deriveServiceCharges({
      jobs: [{ id: 'j', relPath: 'A/B' }],
      generated: [
        { jobId: 'j', spendUsd: 1, elevenlabsChars: 10, updatedAt: '2026-10-25T10:00:00.000Z' },
      ],
      usage: [music],
      subscriptions: money.subscriptions,
      timeZone: 'Asia/Jerusalem',
      // Apify's charge comes from a scan of a client's Instagram, not from a job.
      instagramScans: [
        { client: 'A', startedAt: Date.parse('2026-10-25T10:00:00.000Z'), costUsd: 0.1 },
      ],
    });
    expect([...new Set(charges.map((charge) => charge.item))].sort()).toEqual(
      [...SERVICE_CHARGE_ITEMS].sort(),
    );
  });
});
