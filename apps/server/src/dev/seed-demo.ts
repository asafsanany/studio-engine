// The made-up side of `pnpm demo` that the boards' seeds do not have: a money.json, read by the real
// Money route, and the Monday the sample Instagram numbers stop at. Every name and number is invented.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MoneyFile, priceForClient } from '@studio/shared';
import type { PriceFor } from '../deliveries/deliveries.js';
import { clientIdFor } from '../inbox/scan.js';
import { MoneyFileLoader, moneyFilePath } from '../money/money-file.js';
import { FeatureSettings } from '../settings/feature-settings.js';
import { TeamService } from '../team/team-service.js';

/** The last Monday 06:00 UTC at or before `at`: the weekly scan the demo's Instagram numbers stop at. */
export function lastScanMonday(at: number): number {
  const day = new Date(at);
  day.setUTCHours(6, 0, 0, 0);
  while (day.getUTCDay() !== 1 || day.getTime() > at) day.setUTCDate(day.getUTCDate() - 1);
  return day.getTime();
}

/** The demo's money.json: the same price the seeded deliveries carry, three plans and two costs. */
export function demoMoneyFile(now: number): Partial<MoneyFile> {
  const dayIso = (at: number): string => new Date(at).toISOString().slice(0, 10);
  const since = dayIso(now - 400 * 86_400_000);
  const plan = (id: string, name: string, amount: number, day: number) => ({
    id,
    name,
    amount,
    currency: 'USD' as const,
    every: 'month' as const,
    day,
    since,
  });
  return {
    pricePerJob: 40,
    subscriptions: [
      plan('claude', 'Claude plan', 100, 1),
      plan('voices', 'Voice and music plan', 22, 8),
      plan('scans', 'Instagram scans', 19, 15),
    ],
    charges: [
      {
        date: dayIso(now - 3 * 86_400_000),
        item: 'Stock',
        what: 'Stock clips for Kova Coffee',
        amount: 18,
        currency: 'USD',
      },
      {
        date: dayIso(now - 35 * 86_400_000),
        item: 'Fonts',
        what: 'A display font licence',
        amount: 35,
        currency: 'USD',
      },
    ],
  };
}

/** Two made-up editors and the clients they see, for the Team page, in the seed's folder. */
export function createDemoTeam(dir: string): TeamService {
  const team = new TeamService(join(dir, 'team.json'));
  team.upsertUser({ email: 'yael@example.com', name: 'Yael Cohen', role: 'editor' });
  team.upsertUser({ email: 'amit@example.com', name: 'Amit Levi', role: 'editor' });
  for (const [client, editors] of [
    ['Kova Coffee', ['yael@example.com']],
    ['Arc Fitness', ['yael@example.com', 'amit@example.com']],
    ['Lumen Dental', ['amit@example.com']],
  ] as const) {
    team.setEditors(clientIdFor(client), client, editors);
  }
  return team;
}

/** The Settings page's switches, all on. A change is written to the seed's folder and goes with it. */
export function createDemoSettings(dir: string): FeatureSettings {
  return new FeatureSettings({
    configPath: join(dir, 'config.json'),
    running: {
      graphics: true,
      fonts: true,
      luts: true,
      claudePlanOnly: true,
      draftChat: false,
      twoJobsAtOnce: true,
      quickFixes: false,
      instagram: true,
    },
    instagramClients: 'active',
  });
}

/** Writes the demo's money.json into the seed's folder and reads it back as the engine would. */
export function createDemoMoney(
  dir: string,
  now: number,
): { loader: MoneyFileLoader; priceFor: PriceFor } {
  const path = moneyFilePath(dir);
  writeFileSync(path, `${JSON.stringify(demoMoneyFile(now), null, 2)}\n`);
  const loader = new MoneyFileLoader({ path, defaultUsdRate: 1 });
  return {
    loader,
    priceFor: (client) => {
      const money = loader.get();
      return { price: priceForClient(money, client), currency: money.currency };
    },
  };
}
