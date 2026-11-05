import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { readMoneyFile } from './money/money-file.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('the example files in the repo', () => {
  it('config.example.json is a config.json the engine accepts', () => {
    const home = mkdtempSync(join(tmpdir(), 'studio-example-config-'));
    try {
      mkdirSync(join(home, '.studio-engine'));
      copyFileSync(join(ROOT, 'config.example.json'), join(home, '.studio-engine', 'config.json'));
      const config = loadConfig({ home, env: {} });
      expect(config.currencySymbol).toBe('$');
      expect(config.usdToHomeCurrency).toBe(1);
      expect(config.instagramDmFrom).toEqual([]);
      expect(config.planMonthlyUsd).toBe(200);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('money.example.json is a money.json the engine accepts', () => {
    expect(readMoneyFile(join(ROOT, 'money.example.json')).status).toBe('ok');
  });

  it('.env.example names every key the code reads', () => {
    const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ELEVENLABS_API_KEY',
      'APIFY_TOKEN',
      'HIGGSFIELD_API_KEY',
      'UNSPLASH_ACCESS_KEY',
      'OPENVERSE_CLIENT_ID',
      'OPENVERSE_CLIENT_SECRET',
      'INSTAGRAM_DM_TOKEN',
    ]) {
      expect(text).toContain(`${key}=`);
    }
  });
});
