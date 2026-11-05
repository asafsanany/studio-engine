import { localDayOf } from './analytics-time.ts';
import type { MoneyServiceCharge, MoneySubscription } from './money.ts';
import { musicLengthSecOfUsageLine } from './music.ts';
import {
  ELEVENLABS_DEFAULT_PLAN_CREDITS,
  ELEVENLABS_MUSIC_CREDITS_PER_MINUTE,
  serviceById,
  subscriptionsOfService,
} from './services.ts';
import type { UsageEntry } from './usage.ts';

// What the services cost a job, worked out from what the engine already recorded (CLAUDE.md › APIs
// and services). Money.json holds what the owner pays; this is the other half: the per-use costs of a
// video, which the Money page shows in the job's expenses.
//
//   Higgsfield   the dollars the job's shots took (the job's Generate row): the plan's credits the
//                connector charged, at what a credit is worth (`generateUsdPerCredit`). The plan's
//                renewal already paid for them, so with a Higgsfield line in money.json they are
//                `includedIn` it, like ElevenLabs' (the job shows them, the month does not count
//                them twice). Without that line there is no plan to include them in, and the month
//                counts them.
//   ElevenLabs   the credits the voice and the music of the job used, priced at what a credit costs
//                on the plan (the plan's price over its credits). The plan's renewal already paid
//                for them, so they are `includedIn` it: the job shows them, the month does not
//                count them twice. Without an ElevenLabs line in money.json there is no price, and
//                no charge.
//   Apify        the dollars of each Instagram scan of a client (Clients × Instagram): what Apify said
//                the scan's runs cost, a USD charge dated the day the scan started. No video caused
//                it, so it names no job. A failed scan that cost something is charged too, Apify
//                billed it. With an Apify line in money.json (a paid plan's usage is prepaid by its
//                renewal), a scan from the plan's first day on is `includedIn` it, so the month
//                does not count it twice; before the plan, or without one, the month counts it.
//                Songs' Apify runs are not recorded, so they have no charge yet.
//
// Pure: the same input gives the same answer. The server (money/service-charges.ts) gathers it.

/** A job, as the charges read it. */
export interface ServiceChargeJob {
  id: string;
  /** `Client/Job`: how a charge names its job. */
  relPath: string;
}

/** The part of a job's Generate row the charges need. */
export interface ServiceChargeGenerate {
  jobId: string;
  /** Higgsfield dollars spent. */
  spendUsd: number;
  /** ElevenLabs credits the voice used. */
  elevenlabsChars: number;
  /** When the row last changed (ISO): the day its dollars are dated. */
  updatedAt: string;
}

/** A scan of a client's Instagram that cost something, as the charges read it. */
export interface ServiceChargeInstagramScan {
  /** The client's name, as the charge names it ("Instagram scan · Falcon FPV"). */
  client: string;
  /** When the scan started: milliseconds since the epoch. The day it is dated is that moment's. */
  startedAt: number;
  /** What the scan's Apify runs cost, in dollars. A scan that cost nothing has no charge. */
  costUsd: number;
}

export interface DeriveServiceChargesInput {
  jobs: readonly ServiceChargeJob[];
  generated: readonly ServiceChargeGenerate[];
  /** The lines of the usage log; the `music` ones are read. */
  usage: readonly UsageEntry[];
  /** The subscriptions of money.json: the ElevenLabs plan prices a credit. */
  subscriptions: readonly MoneySubscription[];
  /** IANA time zone whose calendar dates a charge. */
  timeZone: string;
  /** The Instagram scans that cost something. Default: none. */
  instagramScans?: readonly ServiceChargeInstagramScan[];
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** The credits a version of music of `seconds` takes. */
export function musicCredits(seconds: number): number {
  return Math.round((seconds / 60) * ELEVENLABS_MUSIC_CREDITS_PER_MINUTE);
}

/** What one ElevenLabs credit costs, in the plan's own currency; `null` when money.json has no plan. */
export function elevenLabsCreditPrice(
  subscriptions: readonly MoneySubscription[],
): { plan: MoneySubscription; perCredit: number } | null {
  const [plan] = subscriptionsOfService(serviceById('elevenlabs'), subscriptions);
  if (plan === undefined) return null;
  return { plan, perCredit: plan.amount / (plan.credits ?? ELEVENLABS_DEFAULT_PLAN_CREDITS) };
}

export function deriveServiceCharges(input: DeriveServiceChargesInput): MoneyServiceCharge[] {
  const { jobs, generated, usage, subscriptions, timeZone, instagramScans = [] } = input;
  const relPathOf = new Map(jobs.map((job) => [job.id, job.relPath]));
  const eleven = elevenLabsCreditPrice(subscriptions);
  const [higgsfieldPlan] = subscriptionsOfService(serviceById('higgsfield'), subscriptions);
  const [apifyPlan] = subscriptionsOfService(serviceById('apify'), subscriptions);
  const charges: MoneyServiceCharge[] = [];

  const dayOf = (iso: string): string | null => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : localDayOf(ms, timeZone);
  };

  const elevenCharge = (
    date: string,
    job: string,
    what: string,
    credits: number,
  ): MoneyServiceCharge | null => {
    if (eleven === null || credits <= 0) return null;
    return {
      date,
      item: 'ElevenLabs',
      what,
      amount: round4(credits * eleven.perCredit),
      currency: eleven.plan.currency,
      job,
      includedIn: eleven.plan.id,
      credits,
    };
  };

  for (const row of generated) {
    const job = relPathOf.get(row.jobId);
    const date = dayOf(row.updatedAt);
    if (job === undefined || date === null) continue;
    if (row.spendUsd > 0) {
      charges.push({
        date,
        item: 'Higgsfield',
        what: 'Pictures and clips',
        amount: round4(row.spendUsd),
        currency: 'USD',
        job,
        ...(higgsfieldPlan === undefined ? {} : { includedIn: higgsfieldPlan.id }),
      });
    }
    const voice = elevenCharge(
      date,
      job,
      `Voice (${row.elevenlabsChars.toLocaleString('en-US')} credits)`,
      row.elevenlabsChars,
    );
    if (voice !== null) charges.push(voice);
  }

  for (const entry of usage) {
    if (entry.tag !== 'music' || !entry.did.startsWith('Made music ')) continue;
    const seconds = musicLengthSecOfUsageLine(entry.did);
    if (seconds === null || entry.job === undefined) continue;
    const date = dayOf(entry.at);
    if (date === null) continue;
    const job =
      relPathOf.get(entry.job.id) ??
      (entry.client === undefined ? undefined : `${entry.client}/${entry.job.name}`);
    if (job === undefined) continue;
    const version = /^Made music (\S+) for /.exec(entry.did)?.[1] ?? '';
    const credits = musicCredits(seconds);
    const charge = elevenCharge(
      date,
      job,
      `Music ${version} (${credits.toLocaleString('en-US')} credits)`,
      credits,
    );
    if (charge !== null) charges.push(charge);
  }

  // A scan of a client's Instagram: paid per use in dollars, with no video behind it, so no job.
  for (const scan of instagramScans) {
    const amount = round4(scan.costUsd);
    if (!(amount > 0) || !Number.isFinite(scan.startedAt)) continue;
    const date = localDayOf(scan.startedAt, timeZone);
    const included = apifyPlan !== undefined && date >= apifyPlan.since;
    charges.push({
      date,
      item: 'Apify',
      what: `Instagram scan · ${scan.client}`,
      amount,
      currency: 'USD',
      ...(included ? { includedIn: apifyPlan.id } : {}),
    });
  }

  return charges;
}
