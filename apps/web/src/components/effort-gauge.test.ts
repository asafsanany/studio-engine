import { DEFAULT_EFFORT, EFFORT_LEVELS } from '@studio/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { effortIcon, gaugeIcon } from './effort-gauge';

/** The two paths of a gauge's markup: its arc and its needle. */
function paths(level: Parameters<typeof gaugeIcon>[0]): string[] {
  const markup = renderToStaticMarkup(createElement(gaugeIcon(level)));
  return [...markup.matchAll(/<path d="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('gaugeIcon', () => {
  it('draws Lucide’s gauge arc for every level, with the same size and class name', () => {
    for (const level of [null, ...EFFORT_LEVELS]) {
      const markup = renderToStaticMarkup(createElement(gaugeIcon(level)));
      expect(markup, String(level)).toContain('lucide-gauge');
      expect(markup).toMatch(/width="24"[^>]*height="24"/);
      expect(paths(level)[0]).toBe('M3.34 19a10 10 0 1 1 17.32 0');
      expect(paths(level)).toHaveLength(2);
    }
  });

  it('puts the needle in a different place for each level, sweeping from the left to the right', () => {
    const needles = EFFORT_LEVELS.map((level) => paths(level)[1]);
    expect(new Set(needles).size).toBe(EFFORT_LEVELS.length);
    expect(needles).toEqual([
      'M12 14 6.6 12.3', // Medium: on the left
      'M12 14V8.3', // High: straight up
      'M12 14 17.4 12.3', // Extra high: on the right
    ]);
  });

  it('shows the default level’s needle for Default, which runs at that level', () => {
    expect(DEFAULT_EFFORT).toBe('xhigh');
    expect(paths(null)[1]).toBe(paths(DEFAULT_EFFORT)[1]);
    expect(gaugeIcon(null)).toBe(gaugeIcon(DEFAULT_EFFORT));
  });

  it('gives the same icon for the same level', () => {
    expect(gaugeIcon('high')).toBe(gaugeIcon('high'));
  });
});

describe('effortIcon', () => {
  const markup = (choice: Parameters<typeof effortIcon>[0]) =>
    renderToStaticMarkup(createElement(effortIcon(choice)));

  it('is Lucide’s Sparkles for Auto, with the gauges’ size and stroke', () => {
    const html = markup('auto');
    expect(html).toContain('lucide-sparkles');
    expect(html).not.toContain('lucide-gauge');
    expect(html).toMatch(/width="24"[^>]*height="24"/);
    expect(html).toContain('stroke-width="2"');
  });

  it('is the level’s gauge for each level, needle in its place', () => {
    for (const level of EFFORT_LEVELS) {
      expect(effortIcon(level), level).toBe(gaugeIcon(level));
      expect(markup(level), level).toContain('lucide-gauge');
    }
    expect(markup('medium')).toContain('d="M12 14 6.6 12.3"');
    expect(markup('high')).toContain('d="M12 14V8.3"');
    expect(markup('xhigh')).toContain('d="M12 14 17.4 12.3"');
  });

  it('keeps null for Default, as gaugeIcon does: the gauge at the default level, not Auto', () => {
    expect(effortIcon(null)).toBe(gaugeIcon(null));
    expect(markup(null)).toContain('lucide-gauge');
  });

  it('gives the same icon for Auto every time', () => {
    expect(effortIcon('auto')).toBe(effortIcon('auto'));
  });
});
