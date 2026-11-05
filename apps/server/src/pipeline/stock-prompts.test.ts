import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUSIC_SCRIPT } from '../music/music-assets.js';
import { STOCK_SCRIPT } from '../stock/stock-assets.js';
import { buildPrompt, PROMPTS_DIR, type PromptVars, renderTemplate } from './prompts.js';
import type { RunMode } from './runner.js';

// Stock media (ST4): the prompt parts that tell a run about the stock script. Off, every prompt is
// what it was; on, an edit run gets stock.md as a paragraph of its own after the music, a revise run
// gets stock-revise.md in its list, and a render run is told nothing.

const SCRIPT = '/engine/apps/server/assets/stock/stock.mjs';
const MODES: RunMode[] = ['start', 'resume', 'retry'];
const base = { client: 'Pinewood', job: 'Window Ad', step: 5 as const, error: 'ffmpeg exited 1' };
const KINDS: [string, PromptVars][] = [
  ['an edit run', { ...base }],
  ['an edit run in Review', { ...base, review: true }],
  ['a revise run', { ...base, kind: 'revise', round: 1, review: true }],
  ['a render run', { ...base, kind: 'render' }],
];

const part = (name: string) =>
  renderTemplate(readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8'), {
    stockScript: SCRIPT,
  }).trimEnd();

describe('the stock parts', () => {
  it('exist and say what the script does', () => {
    for (const name of ['stock', 'stock-revise']) {
      expect(existsSync(`${PROMPTS_DIR}${name}.md`), name).toBe(true);
      expect(part(name)).not.toBe('');
      expect(part(name)).toContain(`node "${SCRIPT}"`);
    }
  });

  it('call only commands the script has', () => {
    for (const name of ['stock', 'stock-revise']) {
      const text = readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8');
      const commands = [...text.matchAll(/node "\{\{stockScript\}\}" (\w+)/g)].map((m) => m[1]);
      expect(commands.length, name).toBeGreaterThan(0);
      for (const command of commands)
        expect(['sfx', 'photo', 'get', 'list'], name).toContain(command);
    }
  });

  it('name the two sources, the limits of a run and the one rule that matters: only the script writes', () => {
    const text = part('stock');
    expect(text).toContain('Openverse');
    expect(text).toContain('Unsplash');
    expect(text).toContain('6 searches and 8 files');
    expect(text).toContain('The script is the only thing that writes edit/stock/');
    expect(text).toContain('--orientation portrait');
    expect(text).toContain('--max-seconds 30');
    // The Music row of the skill is untouched: stock is not for music.
    expect(text).toContain('this is not for music');
  });

  it('never name a key', () => {
    for (const name of ['stock', 'stock-revise']) {
      expect(part(name)).not.toMatch(/OPENVERSE_|UNSPLASH_ACCESS|CLIENT_SECRET/);
    }
  });
});

describe('stock in the prompts', () => {
  it.each(KINDS)('%s: off is the prompt it always was', async (_name, over) => {
    for (const mode of MODES) {
      const before = await buildPrompt(mode, over);
      for (const off of [
        { stock: false },
        { stock: false, stockScript: SCRIPT },
        { stockScript: SCRIPT },
      ]) {
        const prompt = await buildPrompt(mode, { ...over, ...off });
        expect(prompt).toBe(before);
        expect(prompt).not.toContain('stock.mjs');
        expect(prompt).not.toMatch(/\{\{|\}\}/);
      }
    }
  });

  it.each(MODES)('%s: an edit run gets stock.md as a paragraph of its own', async (mode) => {
    for (const review of [false, true]) {
      const off = await buildPrompt(mode, { ...base, review });
      const on = await buildPrompt(mode, { ...base, review, stock: true, stockScript: SCRIPT });
      expect(on.split(part('stock'))).toHaveLength(2);
      expect(on.replace(`\n\n${part('stock')}`, '')).toBe(off);
      expect(on).not.toMatch(/\{\{|\}\}/);
      expect(on).not.toMatch(/\n\n\n/);
    }
  });

  it.each(MODES)('%s: it comes right after the music, when both are on', async (mode) => {
    const on = await buildPrompt(mode, {
      ...base,
      music: true,
      musicScript: MUSIC_SCRIPT,
      stock: true,
      stockScript: SCRIPT,
    });
    const stock = part('stock');
    const at = on.indexOf(stock);
    expect(at).toBeGreaterThan(0);
    expect(on.slice(0, at)).toMatch(/\n\n$/);
    expect(on.slice(0, at).lastIndexOf('Music: on this machine')).toBeGreaterThan(0);
    expect(on).not.toMatch(/\n\n\n/);
  });

  it('a revise run gets stock-revise.md in its list, after the other lines of “Do what each note asks”', async () => {
    const revise: PromptVars = { ...base, kind: 'revise', round: 2, review: true };
    for (const mode of MODES) {
      const off = await buildPrompt(mode, revise);
      const on = await buildPrompt(mode, { ...revise, stock: true, stockScript: SCRIPT });
      const line = part('stock-revise');
      expect(on).toContain(`${line}\n- A note that is unclear`);
      expect(on.replace(`${line}\n`, '')).toBe(off);
      expect(on).not.toContain(part('stock'));
    }
  });

  it('a revise run with the music on has the stock line after the music lines', async () => {
    const revise: PromptVars = { ...base, kind: 'revise', round: 2, review: true };
    const on = await buildPrompt('start', {
      ...revise,
      music: true,
      musicScript: MUSIC_SCRIPT,
      stock: true,
      stockScript: SCRIPT,
    });
    expect(on.indexOf('- Music: keep the pick')).toBeLessThan(on.indexOf('- Stock media:'));
  });

  it('a render run is told nothing', async () => {
    const render: PromptVars = { ...base, kind: 'render' };
    expect(await buildPrompt('start', { ...render, stock: true, stockScript: SCRIPT })).toBe(
      await buildPrompt('start', render),
    );
  });

  it('needs the script’s path', async () => {
    await expect(buildPrompt('start', { ...base, stock: true })).rejects.toThrow(/stockScript/);
  });

  it('uses the script the engine ships', () => {
    expect(STOCK_SCRIPT).toMatch(/assets\/stock\/stock\.mjs$/);
    expect(existsSync(STOCK_SCRIPT)).toBe(true);
  });
});
