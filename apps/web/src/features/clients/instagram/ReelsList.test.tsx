import type { InstagramLinkableJob, InstagramReel } from '@studio/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInstagramReel } from '@/data/instagram-test-utils';
import type { ReelsListActions } from './ReelsList';
import type { ReelMenuContext } from './reel-menu';
import { filterReels, type ReelFilter, shownReels } from './reel-rows';
import { FALCON_NOW, FALCON_TIME_ZONE, falconReels } from './test-instagram';

// Radix draws a right-click menu in a portal that exists only once it is opened, which a server
// render never does. Swap the menu's pieces for plain elements that keep what these tests read: the
// items' words, their state, and the `onSelect` each one runs.
interface DrawnItem {
  children: ReactNode;
  disabled: boolean;
  title: string | undefined;
  select: () => void;
}
const drawn: DrawnItem[] = [];

vi.mock('@/components/ui/context-menu', async (importOriginal) => {
  const { createElement: h, Children } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    ...(await importOriginal<typeof import('@/components/ui/context-menu')>()),
    ContextMenu: ({ children }: Props) => h('div', { 'data-menu-root': '' }, children),
    // asChild: the trigger is its only child, unchanged.
    ContextMenuTrigger: ({ children }: Props) => Children.only(children),
    ContextMenuContent: ({ children, 'aria-label': label, className }: Props) =>
      h(
        'div',
        { role: 'menu', 'aria-label': label as string, className: className as string },
        children,
      ),
    ContextMenuSeparator: () => h('hr', { role: 'separator' }),
    ContextMenuLabel: ({ children }: Props) => h('div', { 'data-menu-label': '' }, children),
    ContextMenuSub: ({ children }: Props) => h('div', { 'data-menu-sub': '' }, children),
    ContextMenuSubTrigger: ({ children }: Props) =>
      h('div', { role: 'menuitem', 'aria-haspopup': 'menu' }, children),
    ContextMenuSubContent: ({ children, 'aria-label': label, className }: Props) =>
      h(
        'div',
        { role: 'menu', 'aria-label': label as string, className: className as string },
        children,
      ),
    ContextMenuItem: ({ children, disabled, title, onSelect }: Props) => {
      drawn.push({
        children,
        disabled: disabled === true,
        title: title as string | undefined,
        select: onSelect as () => void,
      });
      return h('div', { role: 'menuitem', 'data-disabled': disabled ? '' : undefined }, children);
    },
  };
});

const { ReelsList } = await import('./ReelsList');

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

const orchard: InstagramLinkableJob = {
  jobId: 'orchard-crunch',
  name: 'Orchard crunch',
  deliveredAt: '2026-10-21T10:00:00.000Z',
  stage: 'delivered',
};
const google: InstagramLinkableJob = {
  jobId: 'google-search',
  name: 'Maps Search',
  deliveredAt: '2026-10-16T10:00:00.000Z',
  stage: 'delivered',
};
const paid: InstagramLinkableJob = {
  jobId: 'old-one',
  name: 'Old one',
  deliveredAt: '2026-10-12T10:00:00.000Z',
  stage: 'paid',
};

function menuContext(overrides: Partial<ReelMenuContext> = {}): ReelMenuContext {
  return {
    clientName: 'Falcon FPV',
    linkableJobs: [orchard, google],
    linkedJobIds: new Set(),
    admin: true,
    canOpenJob: true,
    ...overrides,
  };
}

function fakeActions(overrides: Partial<ReelsListActions> = {}): ReelsListActions {
  return {
    openJob: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
    copyLink: vi.fn(),
    ...overrides,
  };
}

interface RenderOptions {
  filter?: ReelFilter;
  showAll?: boolean;
  menu?: ReelMenuContext;
  actions?: ReelsListActions;
  subtitle?: string;
}

/** The list the way the card draws it: the filter first, then the rows that fit. */
function render(reels: readonly InstagramReel[], options: RenderOptions = {}): string {
  const { filter = 'all', showAll = false } = options;
  const filtered = filterReels(reels, filter);
  return renderToStaticMarkup(
    <ReelsList
      reels={filtered}
      shown={shownReels(filtered, showAll)}
      filter={filter}
      onFilterChange={() => {}}
      showAll={showAll}
      onShowAllChange={() => {}}
      subtitle={options.subtitle ?? 'Newest first'}
      menu={options.menu ?? menuContext()}
      actions={options.actions ?? fakeActions()}
      textOptions={OPTIONS}
    />,
  );
}

/** What a piece of markup says, tags removed and the pieces joined as they read. */
const pieces = (markup: string) => markup.split(/<[^>]*>/).filter((text) => text !== '');
const textOf = (node: ReactNode) => pieces(renderToStaticMarkup(node)).join('');

/** The menu items drawn by the last render, in order. */
const items = () =>
  drawn.map((item) => ({
    text: textOf(item.children),
    parts: pieces(renderToStaticMarkup(item.children)),
    disabled: item.disabled,
    title: item.title,
    select: item.select,
  }));

const itemNamed = (name: string) => {
  const found = items().find((item) => item.text === name);
  if (found === undefined)
    throw new Error(`no menu item ${name}; there are ${items().map((i) => i.text)}`);
  return found;
};

/** The rows (`<li data-reel>`) of the markup, each as its own piece of markup. */
const rowsOf = (markup: string) =>
  markup
    .split('<li ')
    .slice(1)
    .map((row) => `<li ${row.split('</li>')[0] ?? ''}</li>`);

const ours = makeInstagramReel({
  shortcode: 'Falcon24',
  postedAt: '2026-10-25T17:40:00.000Z',
  caption: 'Granite Fiber, one take through the warehouse',
  durationSec: 28,
  plays: 9_800,
  likes: 610,
  comments: 22,
  shares: 140,
  sound: 'Original audio',
  coauthors: ['granite'],
  paidPartnership: true,
  job: { id: 'job-granite', name: 'Granite' },
  timesUsual: 1.6,
});
const theirs = makeInstagramReel({
  shortcode: 'Falcon23',
  url: 'https://www.instagram.com/reel/Falcon23/',
  postedAt: '2026-10-22T05:15:00.000Z',
  caption: 'Morning practice, new freestyle line',
  durationSec: 14,
  plays: 4_200,
  likes: 280,
  comments: 11,
  shares: 18,
  sound: 'Some song · Some artist',
  coauthors: [],
  pinned: true,
  job: null,
  timesUsual: 0.7,
});

beforeEach(() => {
  drawn.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<ReelsList> columns', () => {
  const markup = render([ours, theirs]);

  it('is the Reels card, with the line under its title', () => {
    expect(markup).toContain('aria-label="Reels"');
    expect(markup).toMatch(/<h3 class="font-medium">Reels<\/h3>/);
    expect(markup).toContain('>Newest first</p>');
  });

  it('has the thirteen columns of the board, in order, the last with no title', () => {
    const header = markup.match(/<div aria-hidden="true" class="[^"]*">(.*?)<\/div>/)?.[1] ?? '';
    expect(pieces(header)).toEqual([
      'Posted',
      'Caption',
      'Length',
      'Plays',
      '× usual',
      'Likes',
      'Comm.',
      'Shares',
      'Sound',
      'With',
      'Tags',
      'Ours or theirs',
    ]);
    expect(header.match(/<span/g)).toHaveLength(13);
  });

  it('is 1480 px wide at least, inside a sideways scroller', () => {
    expect(markup).toMatch(/<div class="overflow-x-auto"><div class="min-w-\[1480px\]">/);
  });

  it('puts every row on the board’s grid', () => {
    expect(
      markup.match(
        /grid-cols-\[128px_minmax\(220px,1fr\)_52px_64px_60px_60px_56px_60px_150px_112px_120px_170px_32px\]/g,
      ),
    ).toHaveLength(3);
  });

  it('writes a reel across the row as the board does', () => {
    const row = pieces(rowsOf(markup)[0] ?? '');
    expect(row).toEqual([
      'Sun 25 Oct, 19:40',
      'Granite Fiber, one take through the warehouse',
      '0:28',
      '9.8K',
      '1.6×',
      '610',
      '22',
      '140',
      'Original audio',
      '@granite',
      'Paid partnership',
      'Granite',
    ]);
  });

  it('shows the sound with a music icon, and a dash for what a reel does not have', () => {
    const row = rowsOf(markup)[1] ?? '';
    expect(row).toContain('lucide-music');
    expect(pieces(row)).toEqual([
      'Thu 22 Oct, 08:15',
      'Morning practice, new freestyle line',
      '0:14',
      '4.2K',
      '0.7×',
      '280',
      '11',
      '18',
      'Some song',
      ' · Some artist',
      '—',
      'Pinned',
      'Theirs',
    ]);
  });

  // C95: the column is 150 px and the scan stores "Song · Artist", so a long pair is cut. The cell
  // is one line cut at its end, with the song's name first and the artist after it a shade quieter.
  const soundCell = (sound: string | null) => {
    const row = rowsOf(render([makeInstagramReel({ shortcode: 'snd', sound })]))[0] ?? '';
    // The first text after the music note.
    return row
      .slice(row.indexOf('lucide-music'))
      .match(
        /<span dir="auto" class="bidi" title="[^"]*">[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      )?.[0];
  };

  it('writes the song’s name whole and the artist after it a shade quieter, the whole pair in the tooltip', () => {
    expect(soundCell('Sarà perché ti amo · Ricchi e Poveri')).toBe(
      '<span dir="auto" class="bidi" title="Sarà perché ti amo · Ricchi e Poveri">Sarà perché ti amo<span class="text-muted-foreground/70"> · Ricchi e Poveri</span></span>',
    );
  });

  it('leaves "Original audio", a song with no artist and a dash as they were: one text, no artist', () => {
    expect(soundCell('Original audio')).toBe(
      '<span dir="auto" class="bidi" title="Original audio">Original audio</span>',
    );
    expect(soundCell('Some song')).toBe(
      '<span dir="auto" class="bidi" title="Some song">Some song</span>',
    );
    expect(soundCell(null)).toBe('<span dir="auto" class="bidi" title="—">—</span>');
  });

  it('shows a reel without a caption as "No caption"', () => {
    const row = rowsOf(render([makeInstagramReel({ caption: '' })]))[0] ?? '';
    expect(pieces(row)).toContain('No caption');
  });

  it('colours × usual green from 2× up and red under 0.75×', () => {
    const reels = [
      makeInstagramReel({ shortcode: 'high', timesUsual: 2 }),
      makeInstagramReel({ shortcode: 'usual', timesUsual: 1.2 }),
      makeInstagramReel({ shortcode: 'edge', timesUsual: 0.75 }),
      makeInstagramReel({ shortcode: 'low', timesUsual: 0.74 }),
      makeInstagramReel({ shortcode: 'none', timesUsual: null }),
    ];
    const rows = rowsOf(render(reels));
    const timesCell = (row: string) =>
      row.match(/<span class="([^"]*)">(?:\d+(?:\.\d)?×|—)<\/span>/)?.[1] ?? '';
    expect(timesCell(rows[0] ?? '')).toContain('text-[#4ADE80]');
    expect(timesCell(rows[1] ?? '')).toContain('text-muted-foreground');
    expect(timesCell(rows[2] ?? '')).toContain('text-muted-foreground');
    expect(timesCell(rows[3] ?? '')).toContain('text-[#F87171]');
    expect(timesCell(rows[4] ?? '')).toContain('text-muted-foreground');
  });

  it('shows ours as a blue dot and the video’s name, a link to its job sheet', () => {
    const row = rowsOf(markup)[0] ?? '';
    expect(row).toContain('background:#60A5FA');
    expect(row).toMatch(/<a [^>]*href="\?job=job-granite"[^>]*>Granite<\/a>/);
  });

  it('shows theirs as a grey dot and a quiet "Theirs", with no link', () => {
    const row = rowsOf(markup)[1] ?? '';
    expect(row).toContain('background:#71717A');
    expect(row).toMatch(
      /text-muted-foreground"><span aria-hidden="true"[^>]*><\/span>Theirs<\/span>/,
    );
    expect(row).not.toContain('?job=');
  });

  it('keeps a Hebrew video name in its own direction', () => {
    const row =
      rowsOf(
        render([makeInstagramReel({ job: { id: 'job-it', name: 'סרטון אינסטגרם חוף' } })]),
      )[0] ?? '';
    expect(row).toMatch(/<a [^>]*dir="auto"[^>]*>סרטון אינסטגרם חוף<\/a>/);
  });

  it('shows the name as plain text while the job sheet is off, and the row says which it is', () => {
    const off = render([ours], { actions: fakeActions({ openJob: null }) });
    expect(off).not.toContain('?job=');
    expect(pieces(off)).toContain('Granite');
    expect(rowsOf(markup)[0]).toContain('data-ours="true"');
    expect(rowsOf(markup)[1]).toContain('data-ours="false"');
  });

  it('ends each row with a ghost link to the reel on Instagram', () => {
    const row = rowsOf(markup)[1] ?? '';
    expect(row).toMatch(
      /<a [^>]*href="https:\/\/www\.instagram\.com\/reel\/Falcon23\/"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*aria-label="Open on Instagram"/,
    );
    expect(row).toContain('data-variant="ghost"');
  });

  it('says under the list what a scan cannot read', () => {
    expect(markup).toContain(
      'Saves, reach, watch time and profile visits are not public, so a scan can’t read them. They need the client’s own Instagram login (Meta’s API).',
    );
  });

  it('says how many reels there are, to scroll sideways and, to the admin, that nothing is matched by itself', () => {
    expect(markup).toContain(
      '2 reels · scroll sideways for every column · nothing is matched by itself: right-click a reel › Link to job (a linked one: Unlink)',
    );
    const editor = render([ours, theirs], { menu: menuContext({ admin: false }) });
    expect(editor).toContain('>2 reels · scroll sideways for every column</span>');
  });
});

describe('<ReelsList> filter and Show all', () => {
  const reels = falconReels();

  it('has All / Ours / Theirs, the chosen one pressed', () => {
    const markup = render(reels, { filter: 'ours' });
    const group = markup.match(/aria-label="Show"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
    const buttons = [
      ...group.matchAll(
        /<button type="button" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g,
      ),
    ];
    expect(buttons.map((m) => [m[2], m[1]])).toEqual([
      ['All', 'false'],
      ['Ours', 'true'],
      ['Theirs', 'false'],
    ]);
  });

  it('shows the first ten of 22 reels, newest first, and offers Show all', () => {
    const markup = render(reels);
    const rows = rowsOf(markup);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toContain('data-reel="Falcon21"');
    expect(rows[9]).toContain('data-reel="Falcon12"');
    expect(markup).toContain('>10 of 22 reels · scroll sideways');
    expect(markup).toMatch(/<button[^>]*>Show all<\/button>/);
  });

  it('shows every reel after Show all, and offers Show fewer', () => {
    const markup = render(reels, { showAll: true });
    expect(rowsOf(markup)).toHaveLength(22);
    expect(markup).toContain('>22 reels · scroll sideways');
    expect(markup).toMatch(/<button[^>]*>Show fewer<\/button>/);
    expect(markup).not.toContain('Show all');
  });

  it('has no Show all for ten reels or fewer', () => {
    const markup = render(reels.slice(0, 10));
    expect(rowsOf(markup)).toHaveLength(10);
    expect(markup).not.toContain('Show all');
    expect(markup).toContain('>10 reels · scroll sideways');
  });

  it('Ours shows the 7 reels with a video, each one with its name', () => {
    const markup = render(reels, { filter: 'ours' });
    const rows = rowsOf(markup);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.includes('data-ours="true"'))).toBe(true);
    expect(markup).not.toContain('Show all');
    expect(markup).toContain('>7 reels · scroll sideways');
  });

  it('Theirs shows the 15 other reels, ten of them before Show all', () => {
    const rows = rowsOf(render(reels, { filter: 'theirs' }));
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.includes('data-ours="false"'))).toBe(true);
    expect(render(reels, { filter: 'theirs' })).toContain('>10 of 15 reels · scroll sideways');
    expect(rowsOf(render(reels, { filter: 'theirs', showAll: true }))).toHaveLength(15);
  });

  it('says so when the filter lets nothing through, and keeps the filter to go back', () => {
    const onlyTheirs = reels.filter((reel) => reel.job === null);
    const none = render(onlyTheirs, { filter: 'ours' });
    expect(none).toContain('None of our videos is linked to a reel yet.');
    expect(none).toContain('aria-label="Show"');
    expect(rowsOf(none)).toHaveLength(0);
    expect(
      render(
        reels.filter((reel) => reel.job !== null),
        { filter: 'theirs' },
      ),
    ).toContain('Every reel is one of ours.');
    expect(render([])).toContain('No reels yet.');
  });
});

describe('<ReelsList> menu of a reel with no video (S5)', () => {
  it('is Open on Instagram, Link to job and Copy link, and its list of videos', () => {
    render([theirs]);
    expect(items().map((item) => item.text)).toEqual([
      'Open on Instagram',
      'Orchard crunchDelivered 21 Oct',
      'Maps SearchDelivered 16 Oct',
      'Copy link',
    ]);
    const markup = render([theirs]);
    expect(markup).toContain('aria-label="Actions for the reel of Thu 22 Oct"');
    expect(markup).toMatch(
      /<div role="menuitem" aria-haspopup="menu">(?:(?!<\/div>).)*Link to job/,
    );
  });

  it('heads the list with the client and when to expect a video in it, newest first', () => {
    const markup = render([theirs], {
      menu: menuContext({ linkableJobs: [paid, google, orchard] }),
    });
    expect(markup).toMatch(
      /data-menu-label="">Delivered to <bdi>Falcon FPV<\/bdi>, not linked yet</,
    );
    expect(items().map((item) => item.parts)).toContainEqual(['Old one', 'Paid 12 Oct']);
    expect(items().filter((item) => item.parts[1]?.match(/^(Delivered|Paid)/))).toHaveLength(3);
    expect(items().map((item) => item.parts[0])).toEqual([
      'Open on Instagram',
      'Orchard crunch',
      'Maps Search',
      'Old one',
      'Copy link',
    ]);
  });

  it('never offers a video that a reel links already', () => {
    render([theirs], { menu: menuContext({ linkedJobIds: new Set(['orchard-crunch']) }) });
    expect(items().map((item) => item.parts[0])).toEqual([
      'Open on Instagram',
      'Maps Search',
      'Copy link',
    ]);
  });

  it('has one disabled line when every delivered video is linked', () => {
    render([theirs], { menu: menuContext({ linkableJobs: [] }) });
    const empty = itemNamed('Every delivered video is linked');
    expect(empty.disabled).toBe(true);
    expect(items().map((item) => item.text)).toEqual([
      'Open on Instagram',
      'Every delivered video is linked',
      'Copy link',
    ]);
  });

  it('linking a video asks the card to link it, with the video’s id and name', () => {
    const actions = fakeActions();
    render([theirs], { actions });
    itemNamed('Maps SearchDelivered 16 Oct').select();
    expect(actions.link).toHaveBeenCalledOnce();
    expect(actions.link).toHaveBeenCalledWith(theirs, {
      id: 'google-search',
      name: 'Maps Search',
    });
  });

  it('Copy link copies the reel’s address, and Open on Instagram opens it in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const actions = fakeActions();
    render([theirs], { actions });
    itemNamed('Copy link').select();
    expect(actions.copyLink).toHaveBeenCalledWith('https://www.instagram.com/reel/Falcon23/');
    itemNamed('Open on Instagram').select();
    expect(open).toHaveBeenCalledWith(
      'https://www.instagram.com/reel/Falcon23/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('has no Link to job for an editor', () => {
    render([theirs], { menu: menuContext({ admin: false }) });
    expect(items().map((item) => item.text)).toEqual(['Open on Instagram', 'Copy link']);
  });
});

describe('<ReelsList> menu of a linked reel (S4)', () => {
  it('is Open on Instagram, Open job, Unlink from the job, a line and Copy link', () => {
    const markup = render([ours]);
    expect(items().map((item) => item.text)).toEqual([
      'Open on Instagram',
      'Open job · Granite',
      'Unlink from Granite',
      'Copy link',
    ]);
    expect(markup).toMatch(/<hr role="separator"\/>/);
    // No submenu: the reel has its video.
    expect(markup).not.toContain('aria-haspopup');
    // The separator comes before Copy link.
    expect(markup.indexOf('role="separator"')).toBeGreaterThan(markup.indexOf('Unlink from'));
    expect(markup.indexOf('role="separator"')).toBeLessThan(markup.indexOf('Copy link'));
  });

  it('is a little wider than the menu of a reel with no video', () => {
    expect(render([ours])).toMatch(
      /role="menu" aria-label="Actions for the reel of Sun 25 Oct" class="w-55"/,
    );
    expect(render([theirs])).toMatch(
      /role="menu" aria-label="Actions for the reel of Thu 22 Oct" class="w-50"/,
    );
  });

  it('Open job opens the job’s sheet', () => {
    const actions = fakeActions();
    render([ours], { actions });
    itemNamed('Open job · Granite').select();
    expect(actions.openJob).toHaveBeenCalledWith('job-granite');
  });

  it('Unlink asks the card to unlink the reel from that video', () => {
    const actions = fakeActions();
    render([ours], { actions });
    itemNamed('Unlink from Granite').select();
    expect(actions.unlink).toHaveBeenCalledOnce();
    expect(actions.unlink).toHaveBeenCalledWith(ours, { id: 'job-granite', name: 'Granite' });
  });

  it('has no Unlink for an editor', () => {
    render([ours], { menu: menuContext({ admin: false }) });
    expect(items().map((item) => item.text)).toEqual([
      'Open on Instagram',
      'Open job · Granite',
      'Copy link',
    ]);
  });

  it('has a disabled Open job, that says why, while the job sheet is off', () => {
    render([ours], {
      menu: menuContext({ canOpenJob: false }),
      actions: fakeActions({ openJob: null }),
    });
    const open = itemNamed('Open job · Granite');
    expect(open.disabled).toBe(true);
    expect(open.title).toBe('The job sheet is off.');
  });
});
