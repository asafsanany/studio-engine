import type { ModelUsage } from './usage.ts';

// API list prices, so the Analytics page can say what a stretch of Claude use would have cost at
// the API: the "API value" of Claude use (Analytics plan, "Data and definitions"). For the
// app's own runs these are real dollars since 23 Oct 2026 (they bill to the API key, the $200 of
// credits a month); for the owner's Claude Code sessions, which run on the Max plan, the value is a
// yardstick, not a bill.
//
// Source: the claude-api skill (Claude Code 2.1.299), never from memory.
//   - Input and output: SKILL.md, "Current Models (cached: 2026-10-06)": per million tokens.
//   - Cache reads: shared/models.md and shared/model-migration.md. 0.1x the input price, except
//     Opus 5.5 (0.05x, $0.20), Fable 5.1 and Mythos 5.1 (0.025x, $0.25) and Fable 5 / Mythos 5
//     (0.1x, $1.00).
//   - Cache writes: 1.25x the input price (the 5-minute cache, which is what Claude Code writes).
//     usage.jsonl does not say which cache a write went to, so a 1-hour write (2x) is priced as
//     5-minute: the value is never over-stated.
//   - Haiku 5.5 has two rate cards by prompt length ($0.10 / $0.50 up to 100K tokens, $0.50 / $2.50
//     above). A usage line adds up many requests, so the length of one prompt is not known: the
//     first card is used.
// Refresh this table from the skill when a model is added or a price changes.

/** What a million tokens of each kind cost, in US dollars. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The 5-minute cache write is this many times the input price. */
const CACHE_WRITE_MULTIPLE = 1.25;

/** A price from its input and output prices and the cache-read price. Writes are 1.25x input. */
function price(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * CACHE_WRITE_MULTIPLE };
}

/** US dollars per million tokens, by model id as it appears in usage.jsonl. */
export const API_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-mythos-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50, 1),
  'claude-mythos-5': price(10, 50, 1),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25, 0.5),
  'claude-opus-4-8': price(5, 25, 0.5),
  'claude-opus-4-7': price(5, 25, 0.5),
  'claude-opus-4-6': price(5, 25, 0.5),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10, 0.2),
  'claude-sonnet-4-6': price(3, 15, 0.3),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-haiku-4-5': price(1, 5, 0.1),
};

/**
 * The id a price is listed under: lower case, without the `[1m]` suffix Claude Code adds to a
 * model run with the 1M context, and without a dated snapshot suffix (`-20251001`).
 */
function listedId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

/** The price of a model, or `null` when this table does not know it. */
export function priceOf(model: string): ModelPrice | null {
  return API_PRICES[listedId(model)] ?? null;
}

const PER_MILLION = 1_000_000;

/** The API value of one model's tokens in US dollars, at `rates`. */
export function modelValueUsd(usage: ModelUsage, rates: ModelPrice): number {
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite) /
    PER_MILLION
  );
}

/** Whether a model's usage holds any tokens or requests (an empty line is not worth reporting). */
function isUsed(usage: ModelUsage): boolean {
  return (
    usage.requests > 0 ||
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0
  );
}

export interface ApiValue {
  /** US dollars, summed over the models this table has a price for. */
  usd: number;
  /** The models that had usage but no price here: they count as $0. Sorted, without repeats. */
  unknownModels: string[];
}

/**
 * The API value of one usage line (`UsageEntry.usage`: tokens by model) summed over its models. A
 * model with no price counts as $0 and is named in `unknownModels`, so a new model shows up as a
 * gap to fix here and not as a wrong number.
 */
export function apiValue(usage: Readonly<Record<string, ModelUsage>>): ApiValue {
  let usd = 0;
  const unknown = new Set<string>();
  for (const [model, tokens] of Object.entries(usage)) {
    const modelPrice = priceOf(model);
    if (modelPrice === null) {
      if (isUsed(tokens)) unknown.add(model);
    } else {
      usd += modelValueUsd(tokens, modelPrice);
    }
  }
  return { usd, unknownModels: [...unknown].sort() };
}

/** {@link apiValue} as just the dollars. */
export function apiValueUsd(usage: Readonly<Record<string, ModelUsage>>): number {
  return apiValue(usage).usd;
}

/** The models in `entries` that have usage but no price, sorted, without repeats. */
export function unknownModelsOf(
  entries: readonly { usage: Readonly<Record<string, ModelUsage>> }[],
): string[] {
  const unknown = new Set<string>();
  for (const entry of entries) {
    for (const model of apiValue(entry.usage).unknownModels) unknown.add(model);
  }
  return [...unknown].sort();
}
