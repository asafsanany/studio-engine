import { describe, expect, it } from 'vitest';
import { makeInstagramReel } from '@/data/instagram-test-utils';
import { timeText } from './instagram-text';
import {
  filterReels,
  lengthText,
  postedText,
  REELS_PAGE_SIZE,
  reelRowView,
  reelsCountText,
  reelsHint,
  reelsSubtitle,
  shownReels,
  soundWords,
  tagsText,
  timesTone,
  withText,
} from './reel-rows';
import { FALCON_TIME_ZONE, falconInstagram, falconReels } from './test-instagram';

const OPTIONS = { timeZone: FALCON_TIME_ZONE };

describe('soundWords (C95)', () => {
  it('reads the scan’s "Song · Artist" back as the song and the artist', () => {
    expect(soundWords('Midnight Run · Dennis Lloyd')).toEqual({
      song: 'Midnight Run',
      artist: 'Dennis Lloyd',
    });
    expect(soundWords('Sarà perché ti amo · Ricchi e Poveri')).toEqual({
      song: 'Sarà perché ti amo',
      artist: 'Ricchi e Poveri',
    });
  });

  it('has no artist for "Original audio", a song with no artist or the dash', () => {
    for (const sound of ['Original audio', 'Some song', '—', '']) {
      expect(soundWords(sound)).toEqual({ song: sound, artist: null });
    }
  });

  it('splits at the last " · ", so a song’s own " · " stays in its name', () => {
    expect(soundWords('Track · Remix · Some artist')).toEqual({
      song: 'Track · Remix',
      artist: 'Some artist',
    });
  });

  it('keeps a text that begins or ends with the separator whole', () => {
    expect(soundWords(' · Artist only')).toEqual({ song: ' · Artist only', artist: null });
    expect(soundWords('Song · ')).toEqual({ song: 'Song · ', artist: null });
  });

  it('keeps a Hebrew song and its artist apart too', () => {
    expect(soundWords('שיר · אמן')).toEqual({ song: 'שיר', artist: 'אמן' });
  });
});

describe('timeText', () => {
  it('writes the time of day in the zone, on a 24 hour clock', () => {
    expect(timeText('2026-10-25T17:40:00.000Z', OPTIONS)).toBe('19:40');
    // Israel's summer time ends on Sun 25 Oct: this is still UTC+3.
    expect(timeText('2026-10-22T05:15:00.000Z', OPTIONS)).toBe('08:15');
  });

  it('writes midnight as 00:xx, never 24:xx', () => {
    expect(timeText('2026-10-25T22:05:00.000Z', OPTIONS)).toBe('00:05');
    expect(timeText('2026-10-25T22:05:00.000Z', { timeZone: 'UTC' })).toBe('22:05');
  });

  it('is empty for what is not a time', () => {
    expect(timeText('not a time', OPTIONS)).toBe('');
  });
});

describe('postedText', () => {
  it('is the day and the time, as the board writes it', () => {
    expect(postedText('2026-10-25T17:40:00.000Z', OPTIONS)).toBe('Sun 25 Oct, 19:40');
    expect(postedText('2026-09-26T14:30:00.000Z', OPTIONS)).toBe('Sat 26 Sep, 17:30');
  });

  it('is empty for what is not a time', () => {
    expect(postedText('', OPTIONS)).toBe('');
  });
});

describe('lengthText', () => {
  it('is minutes and seconds', () => {
    expect(lengthText(28)).toBe('0:28');
    expect(lengthText(9)).toBe('0:09');
    expect(lengthText(61.4)).toBe('1:01');
    expect(lengthText(59.6)).toBe('1:00');
  });

  it('is a dash when the scan could not read it', () => {
    expect(lengthText(null)).toBe('—');
  });
});

describe('timesTone', () => {
  it('is green from 2× up and red under 0.75×', () => {
    expect(timesTone(2)).toBe('high');
    expect(timesTone(7.3)).toBe('high');
    expect(timesTone(1.99)).toBe('usual');
    expect(timesTone(0.75)).toBe('usual');
    expect(timesTone(0.74)).toBe('low');
    expect(timesTone(0)).toBe('low');
  });

  it('is unknown while there is no usual to divide by', () => {
    expect(timesTone(null)).toBe('unknown');
  });
});

describe('withText and tagsText', () => {
  it('writes the other accounts with an @', () => {
    expect(withText(['granite', 'friend'])).toBe('@granite, @friend');
    expect(withText([])).toBe('');
  });

  it('names a pinned reel and a paid partnership, both with a comma', () => {
    expect(tagsText({ pinned: true, paidPartnership: false })).toBe('Pinned');
    expect(tagsText({ pinned: false, paidPartnership: true })).toBe('Paid partnership');
    expect(tagsText({ pinned: true, paidPartnership: true })).toBe('Pinned, Paid partnership');
    expect(tagsText({ pinned: false, paidPartnership: false })).toBe('');
  });
});

describe('reelRowView', () => {
  const granite = makeInstagramReel({
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

  it('has one word for each column of the board', () => {
    expect(reelRowView(granite, OPTIONS)).toEqual({
      shortcode: 'Falcon24',
      url: 'https://www.instagram.com/reel/C9xYz12AbCd/',
      posted: 'Sun 25 Oct, 19:40',
      caption: 'Granite Fiber, one take through the warehouse',
      length: '0:28',
      plays: '9.8K',
      times: { text: '1.6×', tone: 'usual' },
      likes: '610',
      comments: '22',
      shares: '140',
      sound: 'Original audio',
      with: '@granite',
      tags: 'Paid partnership',
      job: { id: 'job-granite', name: 'Granite' },
    });
  });

  it('writes a dash for what the scan could not read or the reel does not have', () => {
    const bare = reelRowView(
      makeInstagramReel({
        durationSec: null,
        shares: null,
        sound: null,
        coauthors: [],
        pinned: false,
        paidPartnership: false,
        timesUsual: null,
        job: null,
      }),
      OPTIONS,
    );
    expect(bare).toMatchObject({
      length: '—',
      shares: '—',
      sound: '—',
      with: '—',
      tags: '—',
      times: { text: '—', tone: 'unknown' },
      job: null,
    });
  });

  it('puts a caption on one line, and has none for a reel without one', () => {
    expect(reelRowView(makeInstagramReel({ caption: 'one\n\ntwo   three' })).caption).toBe(
      'one two three',
    );
    expect(reelRowView(makeInstagramReel({ caption: '  \n ' })).caption).toBeNull();
  });

  it('writes big plays the short way and the likes in full', () => {
    const row = reelRowView(makeInstagramReel({ plays: 41_200, likes: 2_310 }));
    expect(row.plays).toBe('41.2K');
    expect(row.likes).toBe('2,310');
  });

  it('writes × usual to one decimal, and without one from ten up', () => {
    expect(reelRowView(makeInstagramReel({ timesUsual: 6.754 })).times.text).toBe('6.8×');
    expect(reelRowView(makeInstagramReel({ timesUsual: 12.4 })).times.text).toBe('12×');
    expect(reelRowView(makeInstagramReel({ timesUsual: 0.8 })).times).toEqual({
      text: '0.8×',
      tone: 'usual',
    });
  });
});

describe('the filter, and Show all', () => {
  const reels = falconReels();

  it('has 22 reels, newest first, 7 of them ours', () => {
    expect(reels).toHaveLength(22);
    expect(reels[0]?.caption).toContain('Granite Fiber');
    expect(reels.filter((reel) => reel.job !== null)).toHaveLength(7);
  });

  it('All lets every reel through, in the same order', () => {
    expect(filterReels(reels, 'all')).toEqual(reels);
  });

  it('Ours is the reels with a video, Theirs the others, each in the same order', () => {
    const ours = filterReels(reels, 'ours');
    const theirs = filterReels(reels, 'theirs');
    expect(ours).toHaveLength(7);
    expect(ours.every((reel) => reel.job !== null)).toBe(true);
    expect(theirs).toHaveLength(15);
    expect(theirs.every((reel) => reel.job === null)).toBe(true);
    const sorted = (list: readonly (typeof reels)[number][]) =>
      [...list].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
    expect(ours).toEqual(sorted(ours));
    expect(theirs).toEqual(sorted(theirs));
  });

  it('shows ten rows before Show all, and every one after', () => {
    expect(REELS_PAGE_SIZE).toBe(10);
    expect(shownReels(reels, false)).toEqual(reels.slice(0, 10));
    expect(shownReels(reels, true)).toEqual(reels);
    expect(shownReels(reels.slice(0, 4), false)).toHaveLength(4);
  });

  it('counts the rows on screen against the list', () => {
    expect(reelsCountText(10, 22)).toBe('10 of 22 reels');
    expect(reelsCountText(22, 22)).toBe('22 reels');
    expect(reelsCountText(1, 1)).toBe('1 reel');
    expect(reelsCountText(0, 0)).toBe('0 reels');
  });
});

describe('the lines of the card', () => {
  it('says what the list is, from the scan and the typical reel, as the board does', () => {
    expect(reelsSubtitle(falconInstagram(), { ...OPTIONS })).toBe(
      'Newest first · numbers from the scan of Mon 26 Oct · × usual: plays against their typical reel (6.1K)',
    );
  });

  it('leaves out the scan that did not read the page, and the typical reel when there is none', () => {
    const data = falconInstagram();
    const failed = {
      ...data,
      lastScan: data.lastScan && { ...data.lastScan, outcome: 'failed' as const },
      numbers: null,
    };
    expect(reelsSubtitle(failed, OPTIONS)).toBe(
      'Newest first · × usual: plays against their typical reel',
    );
    expect(reelsSubtitle({ lastScan: null, numbers: null }, OPTIONS)).toBe(
      'Newest first · × usual: plays against their typical reel',
    );
  });

  it('counts the rows, says to scroll, and tells the admin that nothing is matched by itself', () => {
    expect(reelsHint(10, 22, true)).toBe(
      '10 of 22 reels · scroll sideways for every column · nothing is matched by itself: right-click a reel › Link to job (a linked one: Unlink)',
    );
  });

  it('does not tell an editor, who cannot link, how to link', () => {
    expect(reelsHint(22, 22, false)).toBe('22 reels · scroll sideways for every column');
  });
});
