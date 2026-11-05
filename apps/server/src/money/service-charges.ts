// What the services cost the jobs, gathered for the Money page and the Analytics Services section
// (CLAUDE.md › APIs and services). The maths is shared (`deriveServiceCharges`); this only reads the
// places the engine recorded the costs in: the jobs, their Generate rows (Higgsfield's dollars and
// the voice's ElevenLabs credits), the usage log (the music's lines) and the Instagram scans (the
// dollars Apify charged for each, which belong to a client and to no job).

import {
  deriveServiceCharges,
  type MoneyFile,
  type MoneyServiceCharge,
  type UsageEntry,
} from '@studio/shared';
import type { GenerateRepository, InstagramRepository, JobRepository } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * The services whose per-use cost `deriveServiceCharges` works out: the `item` of their charges. A
 * service that says `money: { perUse: true }` in the registry must be here (services-rule.test.ts).
 */
export const SERVICE_CHARGE_ITEMS = ['Higgsfield', 'ElevenLabs', 'Apify'] as const;

export interface ServiceChargeSources {
  jobs: Pick<JobRepository, 'getAll'>;
  generate: Pick<GenerateRepository, 'listAll'>;
  /** The lines of usage.jsonl (`readUsageLog(dataDir)`). */
  usage: () => readonly UsageEntry[] | Promise<readonly UsageEntry[]>;
  /**
   * The Instagram scans (the engine's `InstagramRepository`): each one that cost something is an
   * Apify payment of the month with no job. Left out, no scan is charged.
   */
  instagram?: Pick<InstagramRepository, 'listScanCosts'>;
}

export type ServiceChargeReader = (input: {
  money: Pick<MoneyFile, 'subscriptions'>;
  timeZone: string;
}) => Promise<MoneyServiceCharge[]>;

/** A usage log that cannot be read counts as empty: the music then has no charge, nothing else changes. */
async function usageOrEmpty(read: ServiceChargeSources['usage']): Promise<readonly UsageEntry[]> {
  try {
    return await read();
  } catch (err) {
    logger.warn({ err }, 'Service charges: could not read the usage log; counting it as empty');
    return [];
  }
}

export function createServiceChargeReader(sources: ServiceChargeSources): ServiceChargeReader {
  return async ({ money, timeZone }) => {
    const jobs = sources.jobs.getAll();
    // A scan names its client by the account row; a client whose account was removed (its scans
    // stay) is named by its jobs, and a client with neither by the handle that was scanned.
    const clientOfJobs = new Map(jobs.map((job) => [job.clientId, job.client]));
    return deriveServiceCharges({
      jobs,
      generated: sources.generate.listAll(),
      usage: await usageOrEmpty(sources.usage),
      subscriptions: money.subscriptions,
      timeZone,
      instagramScans: (sources.instagram?.listScanCosts() ?? []).map((scan) => ({
        client: scan.client ?? clientOfJobs.get(scan.clientId) ?? `@${scan.handle}`,
        startedAt: scan.startedAt,
        costUsd: scan.costUsd,
      })),
    });
  };
}
