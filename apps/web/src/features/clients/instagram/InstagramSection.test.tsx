import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { NO_REELS_IN_RANGE } from './ChartCards';
import { InstagramSection } from './InstagramSection';
import { FALCON_NOW, FALCON_TIME_ZONE, falconInstagram } from './test-instagram';
import type { InstagramSectionState } from './use-instagram-section';

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

function state(overrides: Partial<InstagramSectionState> = {}): InstagramSectionState {
  return {
    on: true,
    data: falconInstagram(),
    loading: false,
    range: 'since',
    setRange: () => {},
    stale: false,
    ...overrides,
  };
}

function render(overrides: Partial<InstagramSectionState> = {}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <InstagramSection clientId="falcon-fpv" state={state(overrides)} textOptions={OPTIONS} />
    </QueryClientProvider>,
  );
}

/** The `aria-label` of every section in the markup, in order. */
const labels = (markup: string) =>
  [...markup.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1]);

describe('<InstagramSection> with the board’s numbers', () => {
  const markup = render();

  it('is titled Instagram and says when it was scanned and when it will be again', () => {
    expect(markup).toMatch(/<h2 id="client-instagram"[^>]*>Instagram<\/h2>/);
    expect(markup).toContain('>Scanned Mon 26 Oct · next scan Mon 2 Nov</p>');
    expect(markup).toContain('aria-labelledby="client-instagram"');
  });

  it('has the range switch, Since us / 90 days / 30 days, with the chosen one pressed', () => {
    expect(markup).toMatch(/role="group" aria-label="Range"/);
    // The Reels list's filter is a switch of its own: only the range's buttons are read here.
    const group = markup.match(/aria-label="Range"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
    const buttons = [
      ...group.matchAll(
        /<button type="button" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g,
      ),
    ];
    expect(buttons.map((m) => [m[2], m[1]])).toEqual([
      ['Since us', 'true'],
      ['90 days', 'false'],
      ['30 days', 'false'],
    ]);
    expect(render({ range: '30' })).toMatch(/aria-pressed="true"[^>]*>30 days</);
  });

  it('has a Scan now button that can be pressed', () => {
    expect(markup).toMatch(
      /<button[^>]*data-variant="ghost"[^>]*>(?:(?!<\/button>).)*Scan now<\/button>/,
    );
    expect(markup).not.toContain('Scanning…');
    expect(markup).not.toContain('disabled=""');
  });

  it('shows the four tiles, then Plays of every reel, Views, likes, comments and shares, and the Reels', () => {
    expect(labels(markup)).toEqual([
      'Followers',
      'Plays per reel',
      'Likes per reel',
      'Shares a week',
      'Plays of every reel',
      'Views, likes, comments and shares',
      'Reels',
    ]);
  });

  it('writes the tiles’ numbers', () => {
    expect(markup).toContain('>12,480</span>');
    expect(markup).toContain('>+312 this week · +1,930 since us</span>');
    expect(markup).toContain('>18.4K</span>');
    expect(markup).toContain('>5.1K</span>');
    expect(markup).toContain('>3.6× theirs</span>');
    expect(markup).toContain('>2,140</span>');
    expect(markup).toContain('>Ours 1,610 · theirs 530</span>');
    expect(markup).toContain('>+38% on the week before</span>');
  });

  it('colours the change in green when it is up', () => {
    expect(markup).toMatch(/class="[^"]*text-\[#4ADE80\][^"]*">\+312 this week/);
  });

  it('draws the lines of Followers and Shares a week and the two charts, each named for a screen reader', () => {
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="Plays of the 22 reels, since us (3 Aug), ours in blue"');
    expect(markup).toContain(
      'aria-label="Views, likes, comments and shares of every reel, each as a multiple of their usual reel, our reels on a pale blue band"',
    );
  });

  it('says the reels and the usual reel in the subtitles', () => {
    expect(markup).toContain('>Since us (3 Aug) · 22 reels, 7 of them ours</p>');
    expect(markup).toContain(
      'each against their usual reel (views 6,100, likes 406, comments 17, shares 88)',
    );
  });

  it('has a legend over each chart', () => {
    for (const word of ['Ours', 'Theirs', 'Views', 'Likes', 'Comments', 'Shares', 'Our reel']) {
      expect(markup).toContain(`</span>${word}</li>`);
    }
  });

  it('keeps a pale blue band in the legend of the engagement chart only', () => {
    expect(markup).toContain('background:#60A5FA59');
  });

  it('leaves the tiles undimmed', () => {
    expect(markup).not.toContain('opacity-60');
    expect(markup).not.toContain('aria-busy="true"');
  });
});

describe('<InstagramSection> Reels list', () => {
  const markup = render();

  it('is under the two charts, in the same column, titled Reels', () => {
    expect(markup.indexOf('aria-label="Reels"')).toBeGreaterThan(
      markup.indexOf('aria-label="Views, likes, comments and shares"'),
    );
    expect(markup).toContain('>Newest first · numbers from the scan of');
  });

  it('opens on All, with the newest ten of the 22 reels and Show all', () => {
    expect(markup).toMatch(
      /aria-label="Show"[^>]*><button type="button" aria-pressed="true"[^>]*>All</,
    );
    expect(markup.match(/<li data-reel="/g)).toHaveLength(10);
    expect(markup).toContain('>10 of 22 reels · scroll sideways for every column');
    expect(markup).toMatch(/<button[^>]*>Show all<\/button>/);
    expect(markup.indexOf('data-reel="Falcon21"')).toBeLessThan(
      markup.indexOf('data-reel="Falcon20"'),
    );
  });

  it('is dimmed with the rest of the section while another range loads', () => {
    expect(render({ stale: true })).toContain('aria-label="Reels"');
  });

  it('is not drawn before there are numbers: the section says so instead', () => {
    expect(render({ data: { ...falconInstagram(), numbers: null } })).not.toContain(
      'aria-label="Reels"',
    );
  });

  it('keeps the linking hint for the admin only', () => {
    expect(markup).toContain('right-click a reel › Link to job');
    const editor = renderToStaticMarkup(
      <QueryClientProvider client={createEditorQueryClient()}>
        <InstagramSection clientId="falcon-fpv" state={state()} textOptions={OPTIONS} />
      </QueryClientProvider>,
    );
    expect(editor).toContain('>10 of 22 reels · scroll sideways for every column</span>');
    expect(editor).not.toContain('Link to job');
  });
});

describe('<InstagramSection> while a scan is on', () => {
  it('turns Scan now into a Scanning… that cannot be pressed again', () => {
    const markup = render({ data: { ...falconInstagram(), scanning: true } });
    expect(markup).toContain('Scanning…');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/);
    expect(markup).toContain('>Scanning now · last scan Mon 26 Oct</p>');
  });
});

describe('<InstagramSection> while another range loads', () => {
  it('keeps the numbers on screen, a little dimmed', () => {
    const markup = render({ stale: true });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('opacity-60');
    expect(labels(markup)).toContain('Plays of every reel');
  });
});

describe('<InstagramSection> before there are numbers', () => {
  it('has the head, without the range, and a line in place of the tiles and charts', () => {
    const markup = render({
      data: { ...falconInstagram(), numbers: null, scanning: true },
    });
    expect(markup).toContain('>Instagram</h2>');
    expect(markup).not.toContain('aria-label="Range"');
    expect(markup).toContain('Reading @falcon.fpv… about a minute');
    expect(labels(markup)).toEqual([]);
  });

  it('says there are no numbers when no scan is on', () => {
    const markup = render({ data: { ...falconInstagram(), numbers: null } });
    expect(markup).toContain('No numbers yet.');
  });
});

describe('<InstagramSection> with no reel in the range', () => {
  it('keeps the tiles and says so in each chart card', () => {
    const data = falconInstagram('30');
    if (data.numbers === null) throw new Error('the fixture has numbers');
    data.numbers.plays = [];
    data.numbers.engagement = [];
    const markup = render({ data, range: '30' });
    expect(markup.match(new RegExp(NO_REELS_IN_RANGE.replace('.', '\\.'), 'g'))).toHaveLength(2);
    expect(labels(markup).slice(0, 4)).toEqual([
      'Followers',
      'Plays per reel',
      'Likes per reel',
      'Shares a week',
    ]);
    // Only the two lines of the tiles (Followers, Shares a week) are drawn.
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(2);
  });
});

describe('<InstagramSection> when it has nothing to show', () => {
  it('is nothing while the switch is off, even with data in the cache', () => {
    expect(render({ on: false })).toBe('');
  });

  it('is nothing before the first answer, and nothing yet while the wait is short', () => {
    expect(render({ data: undefined, loading: true })).toBe('');
    expect(render({ data: undefined, loading: false })).toBe('');
  });

  it('is the empty section for a client with no Instagram account (S8)', () => {
    const data = falconInstagram();
    const markup = render({ data: { ...data, account: null, numbers: null, reels: [] } });
    expect(markup).toContain('data-slot="instagram-no-account"');
    expect(markup).toContain('Add their Instagram to see how our videos do there.');
    expect(markup).toContain('Add Instagram');
    expect(markup).not.toContain('Scan now');
  });
});
