import { describe, expect, it } from 'vitest';
import {
  API_PRICES,
  apiValue,
  apiValueUsd,
  modelValueUsd,
  priceOf,
  unknownModelsOf,
} from './api-prices.ts';
import type { ModelUsage } from './usage.ts';

const MILLION = 1_000_000;

function tokens(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}

describe('API_PRICES', () => {
  it('has the models seen in usage.jsonl, and Haiku and Fable', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-haiku-4-5',
      'claude-fable-5-1',
      'claude-fable-5',
    ]) {
      expect(API_PRICES[model], model).toBeDefined();
    }
  });

  it('lists the prices of the claude-api skill (per million tokens)', () => {
    expect(API_PRICES['claude-opus-5-5']).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    });
    expect(API_PRICES['claude-sonnet-5-5']).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(API_PRICES['claude-fable-5-1']).toEqual({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    });
    const haiku = API_PRICES['claude-haiku-5-5'];
    expect(haiku?.input).toBeCloseTo(0.1, 10);
    expect(haiku?.output).toBeCloseTo(0.5, 10);
    expect(haiku?.cacheRead).toBeCloseTo(0.01, 10);
    expect(haiku?.cacheWrite).toBeCloseTo(0.125, 10);
  });

  it('never prices a cache read above its input, or a cache write below it', () => {
    for (const [model, rates] of Object.entries(API_PRICES)) {
      expect(rates.cacheRead, model).toBeLessThan(rates.input);
      expect(rates.cacheWrite, model).toBeGreaterThan(rates.input);
      expect(rates.output, model).toBeGreaterThan(rates.input);
    }
  });
});

describe('priceOf', () => {
  it('finds a model by its id, whatever the case', () => {
    expect(priceOf('claude-opus-5-5')).toBe(API_PRICES['claude-opus-5-5']);
    expect(priceOf('Claude-Opus-5-5')).toBe(API_PRICES['claude-opus-5-5']);
  });

  it('finds a model run with the 1M context, and a dated snapshot', () => {
    expect(priceOf('claude-opus-5-5[1m]')).toBe(API_PRICES['claude-opus-5-5']);
    expect(priceOf('claude-haiku-4-5-20251001')).toBe(API_PRICES['claude-haiku-4-5']);
  });

  it('does not know a model it has no price for', () => {
    expect(priceOf('claude-opus-9')).toBeNull();
    expect(priceOf('<synthetic>')).toBeNull();
    expect(priceOf('gpt-5')).toBeNull();
  });
});

describe('modelValueUsd', () => {
  it('prices a million of each kind of token at its own rate', () => {
    const opus = API_PRICES['claude-opus-5-5'];
    if (opus === undefined) throw new Error('no Opus 5.5 price');
    expect(modelValueUsd(tokens({ input: MILLION }), opus)).toBeCloseTo(4, 10);
    expect(modelValueUsd(tokens({ output: MILLION }), opus)).toBeCloseTo(20, 10);
    expect(modelValueUsd(tokens({ cacheRead: MILLION }), opus)).toBeCloseTo(0.2, 10);
    expect(modelValueUsd(tokens({ cacheWrite: MILLION }), opus)).toBeCloseTo(5, 10);
  });

  it('is nothing for no tokens, however many requests', () => {
    const opus = API_PRICES['claude-opus-5-5'];
    if (opus === undefined) throw new Error('no Opus 5.5 price');
    expect(modelValueUsd(tokens({ requests: 40 }), opus)).toBe(0);
  });
});

describe('apiValueUsd', () => {
  it('adds up the four kinds of token of one model', () => {
    // A real line of usage.jsonl: 70 requests of Opus 5.5.
    const usage = {
      'claude-opus-5-5': tokens({
        requests: 70,
        input: 140,
        output: 77_195,
        cacheRead: 13_404_443,
        cacheWrite: 266_754,
      }),
    };
    const expected = (140 * 4 + 77_195 * 20 + 13_404_443 * 0.2 + 266_754 * 5) / MILLION;
    expect(apiValueUsd(usage)).toBeCloseTo(expected, 10);
    expect(apiValueUsd(usage)).toBeCloseTo(5.5591, 3);
  });

  it('sums over models', () => {
    const usage = {
      'claude-opus-5-5': tokens({ output: MILLION }),
      'claude-sonnet-5-5': tokens({ output: MILLION }),
    };
    expect(apiValueUsd(usage)).toBeCloseTo(30, 10);
  });

  it('is 0 for a line with no usage (a transcription ran no Claude)', () => {
    expect(apiValueUsd({})).toBe(0);
  });
});

describe('an unknown model', () => {
  const usage = {
    'claude-opus-5-5': tokens({ output: MILLION }),
    'claude-future-9': tokens({ output: MILLION }),
  };

  it('is priced at 0 and left out of the sum', () => {
    expect(apiValueUsd(usage)).toBeCloseTo(20, 10);
  });

  it('is reported by name', () => {
    expect(apiValue(usage)).toEqual({ usd: 20, unknownModels: ['claude-future-9'] });
  });

  it('is not reported when it used nothing (Claude Code logs a "<synthetic>" model with no tokens)', () => {
    const empty = { '<synthetic>': tokens({ requests: 0 }) };
    expect(apiValue(empty)).toEqual({ usd: 0, unknownModels: [] });
  });

  it('is listed once, sorted, over many lines', () => {
    expect(
      unknownModelsOf([
        { usage: { b: tokens({ input: 1 }), a: tokens({ input: 1 }) } },
        { usage: { b: tokens({ input: 5 }), 'claude-opus-5-5': tokens({ input: 1 }) } },
      ]),
    ).toEqual(['a', 'b']);
  });
});
