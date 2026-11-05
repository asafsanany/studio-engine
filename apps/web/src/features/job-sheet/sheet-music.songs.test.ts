import type { MusicView, Song, SongFailure } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  makeMusicVersion,
  makeMusicView,
  makeSong,
  makeSongFailure,
  makeSongView,
} from '@/data/test-utils';
import { historyRows } from './sheet-history';
import { musicDetailRow, musicHistoryRows } from './sheet-music';
import { jobSheetJobs, jobSheetNow, jobSheetRuns } from './test-fixtures';

// The job sheet's song (Songs, SG9; board SGSheet): the Music row of a video whose music is a song,
// of a song that could not be got, and the song's lines of History.

const UTC = 'UTC';
const sub = (music: MusicView) => musicDetailRow(music)?.sub;

/** A song with only what the test names; the rest is the boards' song. */
const song = (overrides: Partial<Song>) => makeSongView({ song: makeSong(overrides) });

const PART = 'The studio track from YouTube Music; the part used, 0:42 to 1:21.';

describe('the Music row of a video whose music is the song', () => {
  it('is the board’s: "[title] · [artist]" with where it came from and the part used', () => {
    expect(musicDetailRow(makeSongView())).toEqual({
      label: 'Music',
      value: 'נתתי לך בית · Ofek Adanek',
      muted: false,
      sub: `From Yael’s screenshot (IMG_4412.PNG). ${PART}`,
    });
  });

  describe('where the song was asked for', () => {
    it('says a screenshot without its file name when the record has none', () => {
      const asked = { from: 'screenshot', file: null, url: null, by: 'brief' } as const;
      expect(sub(song({ asked }))).toBe(`From Yael’s screenshot. ${PART}`);
    });

    it('says a link Yael sent, and a link the owner gave in Review', () => {
      const link = { from: 'link', file: null, url: 'https://x.test/r', by: 'brief' } as const;
      expect(sub(song({ asked: link }))).toBe(`From a link Yael sent. ${PART}`);
      expect(sub(song({ asked: { ...link, by: 'you' } }))).toBe(`From the link you sent. ${PART}`);
    });

    it('says the note for a name typed in it, in the first message or in Review', () => {
      const name = { from: 'name', file: null, url: null, by: 'brief' } as const;
      expect(sub(song({ asked: name }))).toBe(`From your note. ${PART}`);
      expect(sub(song({ asked: { ...name, from: 'note', by: 'you' } }))).toBe(
        `From your note. ${PART}`,
      );
    });

    describe('picked as trending', () => {
      const asked = { from: 'trending', file: null, url: null, by: 'editor' } as const;
      const trending = { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' };

      it('says it was picked by the editor as rising on Reels in the niche, with the reel count', () => {
        expect(sub(song({ asked, trending }))).toBe(
          `Picked by the editor as rising on Reels in #fpv. In 18.4K reels. ${PART}`,
        );
      });

      it('leaves the count out when Instagram did not say it, or it is zero, and counts one reel', () => {
        const without = (reels: number | null) =>
          sub(song({ asked, trending: { ...trending, reels } }));
        expect(without(null)).toBe(`Picked by the editor as rising on Reels in #fpv. ${PART}`);
        expect(without(0)).toBe(`Picked by the editor as rising on Reels in #fpv. ${PART}`);
        expect(without(1)).toBe(
          `Picked by the editor as rising on Reels in #fpv. In 1 reel. ${PART}`,
        );
        expect(without(950)).toContain('In 950 reels.');
      });

      it('still says it without the record’s trending facts', () => {
        expect(sub(song({ asked, trending: null }))).toBe(
          `Picked by the editor as rising on Reels. ${PART}`,
        );
      });
    });
  });

  describe('where the audio came from, and the part', () => {
    const lead = 'From Yael’s screenshot (IMG_4412.PNG). ';
    const from = (overrides: Partial<Song>) => sub(song(overrides));

    it('names the version a name asked for', () => {
      expect(from({ version: 'sped up' })).toBe(
        `${lead}The sped up version from YouTube Music; the part used, 0:42 to 1:21.`,
      );
      expect(from({ version: 'original' })).toBe(`${lead}${PART}`);
    });

    it('says YouTube, a reel’s own audio and a TikTok’s', () => {
      const source = (site: Song['source']['site'], via: Song['source']['via']) => ({
        ...makeSong().source,
        site,
        via,
      });
      expect(from({ source: source('youtube', 'yt-dlp') })).toBe(
        `${lead}The track from YouTube; the part used, 0:42 to 1:21.`,
      );
      expect(from({ source: source('instagram', 'apify') })).toBe(
        `${lead}The reel’s own audio from Instagram; the part used, 0:42 to 1:21.`,
      );
      expect(from({ source: source('tiktok', 'apify') })).toBe(
        `${lead}The video’s own audio from TikTok; the part used, 0:42 to 1:21.`,
      );
    });

    it('says the whole song for a song no longer than the cut, and the reel’s part when matched', () => {
      expect(from({ fullMs: 31_000, part: { startMs: 0, endMs: 31_000, how: 'whole' } })).toBe(
        `${lead}The studio track from YouTube Music; the whole song, 0:31.`,
      );
      expect(from({ part: { startMs: 12_000, endMs: 40_000, how: 'reel' } })).toBe(
        `${lead}The studio track from YouTube Music; the part the reel uses, 0:12 to 0:40.`,
      );
    });
  });

  describe('when it is not what plays', () => {
    it('says what plays after Make music instead: the version, not the song', () => {
      const music = makeSongView({
        picked: 'v1',
        versions: [makeMusicVersion(1)],
        picks: [{ id: 'song', at: '2026-10-25T21:03:00.000Z' }],
      });
      expect(musicDetailRow(music)?.value).toBe('Made for this video · v1');
    });

    it('says the music is off after No music, with the song in the record', () => {
      expect(musicDetailRow(makeSongView({ picked: 'off' }))?.value).toBe(
        'None · you turned it off',
      );
    });

    it('says a make is under way while one runs, even with a song in the record', () => {
      const making = { id: 'v1', ask: null, startedAt: '2026-10-25T21:30:00.000Z' };
      expect(musicDetailRow(makeSongView({ making }))?.value).toBe('Making it now');
    });

    it('keeps the song while a later request for another one failed: the song still plays', () => {
      const music = makeSongView({ songFailure: makeSongFailure() });
      expect(musicDetailRow(music)).toEqual(musicDetailRow(makeSongView()));
    });
  });
});

describe('the Music row of a song that could not be got', () => {
  const failed = (songFailure: SongFailure, overrides: Partial<MusicView> = {}) =>
    makeMusicView({ songFailure, ...overrides });

  it('says it in the failure colour, the record’s own words, and which version ElevenLabs made instead', () => {
    const row = musicDetailRow(
      failed(makeSongFailure({ message: 'The downloader didn’t answer.' })),
    );
    expect(row).toEqual({
      label: 'Music',
      value: 'Couldn’t get the song',
      muted: false,
      sub: 'The downloader didn’t answer. ElevenLabs made v1 instead.',
      tone: 'failure',
    });
  });

  it('a blocked song (YouTube said too many requests) reads as "refusing right now, try again in a while", not as the internet being down (C81)', () => {
    const message =
      'YouTube Music is refusing requests from this Mac right now (it says this Mac asked too many times lately), so "Blinding Lights" by The Weeknd could not be got. Try again in a while.';
    const row = musicDetailRow(failed(makeSongFailure({ code: 'blocked', message })));
    expect(row).toMatchObject({
      value: 'Couldn’t get the song',
      sub: `${message} ElevenLabs made v1 instead.`,
      tone: 'failure',
    });
    expect(row?.sub).toContain('Try again in a while.');
    expect(row?.sub?.toLowerCase()).not.toContain('internet');
  });

  it('names the version that is picked when there are several', () => {
    const versions = [makeMusicVersion(1), makeMusicVersion(2)];
    const row = musicDetailRow(failed(makeSongFailure(), { versions, picked: 'v2' }));
    expect(row?.sub).toMatch(/ElevenLabs made v2 instead\.$/);
  });

  it('says "Original audio" plainly, with the account, never as an error', () => {
    const original = makeSongFailure({
      asked: 'Original audio · @reels.creator',
      code: 'original_audio',
      message: 'The screenshot says Original audio.',
    });
    expect(musicDetailRow(failed(original))).toEqual({
      label: 'Music',
      value: 'Original audio',
      muted: false,
      sub: 'The screenshot says “Original audio · @reels.creator”, so there’s nothing to look up. ElevenLabs made v1 instead.',
    });
    expect(musicDetailRow(failed({ ...original, asked: 'the screenshot' }))?.sub).toBe(
      'The screenshot says “Original audio”, so there’s nothing to look up. ElevenLabs made v1 instead.',
    );
  });

  it('says only why when ElevenLabs made nothing either, and no more than the existing row when it failed too', () => {
    const none = { versions: [], picked: null, picks: [] };
    expect(musicDetailRow(failed(makeSongFailure({ message: 'Nope.' }), none))).toMatchObject({
      value: 'Couldn’t get the song',
      sub: 'Nope.',
      tone: 'failure',
    });
    const elevenFailure = {
      id: 'v1',
      code: 'no_credits' as const,
      message: 'ElevenLabs says this month’s credits are used up.',
      at: '2026-10-25T21:04:00.000Z',
    };
    expect(musicDetailRow(failed(makeSongFailure(), { ...none, failure: elevenFailure }))).toEqual({
      label: 'Music',
      value: 'None · couldn’t make it',
      muted: false,
      sub: elevenFailure.message,
      tone: 'failure',
    });
  });
});

describe('the song’s History lines', () => {
  const iso = (time: string) => `2026-10-25T${time}:00.000Z`;
  const lines = (music: MusicView, briefAt?: string | null) =>
    musicHistoryRows(music, { briefAt: briefAt ?? null }).map(
      ({ at, text, tone }) => [at, text, tone] as const,
    );

  it('says what the board does: the brief found it, then it was got', () => {
    expect(lines(makeSongView(), iso('21:02'))).toEqual([
      [
        iso('21:02'),
        'The brief found the song on Yael’s screenshot: נתתי לך בית, Ofek Adanek',
        undefined,
      ],
      [
        iso('21:03'),
        'Got the song from YouTube Music (3:12). The part with its drop: 0:42 to 1:21',
        undefined,
      ],
    ]);
  });

  it('finds the song at the moment it was got when the Brief run’s end is not known', () => {
    expect(lines(makeSongView()).map(([at]) => at)).toEqual([iso('21:03'), iso('21:03')]);
  });

  it('never finds it after it was got', () => {
    expect(lines(makeSongView(), iso('21:30')).map(([at]) => at)).toEqual([
      iso('21:03'),
      iso('21:03'),
    ]);
  });

  it('says a song the owner asked for in Review was found by the editor, at the moment it was got', () => {
    const asked = { from: 'note', file: null, url: null, by: 'you' } as const;
    expect(lines(song({ asked }), iso('21:02'))[0]).toEqual([
      iso('21:03'),
      'The editor found the song in the note: נתתי לך בית, Ofek Adanek',
      undefined,
    ]);
  });

  describe('a trending pick', () => {
    const asked = { from: 'trending', file: null, url: null, by: 'editor' } as const;
    const trending = { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' };

    it('says the pick and the niche, never how many songs it looked at', () => {
      expect(lines(song({ asked, trending }), iso('21:02'))).toEqual([
        [
          iso('21:03'),
          'Picked a song rising on Reels in #fpv: נתתי לך בית by Ofek Adanek',
          undefined,
        ],
        [
          iso('21:03'),
          'Got the song from YouTube Music (3:12). The part with its drop: 0:42 to 1:21',
          undefined,
        ],
      ]);
      expect(lines(song({ asked, trending }))[0]?.[1]).not.toMatch(/looked/i);
    });

    it('says the editor found it when the record has no trending facts', () => {
      expect(lines(song({ asked, trending: null }))[0]?.[1]).toBe(
        'The editor found the song on Reels: נתתי לך בית, Ofek Adanek',
      );
    });
  });

  it('says a song that could not be got, in the failure colour', () => {
    const music = makeMusicView({
      versions: [],
      picked: null,
      picks: [],
      songFailure: makeSongFailure({ message: 'The downloader didn’t answer.', at: iso('21:05') }),
    });
    expect(lines(music)).toEqual([
      [iso('21:05'), 'Couldn’t get the song: The downloader didn’t answer.', 'failure'],
    ]);
  });

  it('says both when a later request failed and the earlier song still plays', () => {
    const music = makeSongView({ songFailure: makeSongFailure({ at: iso('21:40') }) });
    expect(lines(music).map(([, , tone]) => tone)).toEqual([undefined, undefined, 'failure']);
  });

  it('has no song lines for a record without a song or a failure', () => {
    expect(musicHistoryRows(makeMusicView())).toEqual(
      musicHistoryRows(makeMusicView()).filter(({ id }) => !id.startsWith('song-')),
    );
    expect(musicHistoryRows(makeMusicView()).some(({ id }) => id.startsWith('song-'))).toBe(false);
  });

  it('gives each line an id of its own', () => {
    const music = makeSongView({ songFailure: makeSongFailure() });
    const ids = musicHistoryRows(music).map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the song in the sheet’s History', () => {
  // The approved job of the boards: its Brief run (step 1) ran 11:40 to 11:41.
  const job = jobSheetJobs.approved;
  const source = { job, runs: jobSheetRuns.approved, notes: [] };
  const now = jobSheetNow.approved;
  const at = (time: string) => `2026-10-22T${time}:00.000Z`;

  it('puts the song’s lines among the others, found when the Brief run ended', () => {
    const music = makeSongView({
      song: makeSong({ gotAt: at('11:55') }),
      picks: [{ id: 'song', at: at('11:55') }],
    });
    const rows = historyRows({ ...source, music }, now, UTC);
    const text = rows.map((row) => `${row.time} ${row.text}`);
    const found = text.findIndex((line) => line.includes('found the song'));
    expect(text[found]).toBe(
      '11:41 The brief found the song on Yael’s screenshot: נתתי לך בית, Ofek Adanek',
    );
    expect(text[found + 1]).toBe(
      '11:55 Got the song from YouTube Music (3:12). The part with its drop: 0:42 to 1:21',
    );
    expect(text.indexOf('11:40 Started · Extra high')).toBeLessThan(found);
  });

  it('says nothing of a song for a job without one', () => {
    const rows = historyRows({ ...source, music: makeMusicView() }, now, UTC);
    expect(rows.some((row) => /song/i.test(row.text))).toBe(false);
  });

  it('says the second file was rendered once it is made, after the MP4', () => {
    const noSong = {
      state: 'ready',
      file: 'Demo · no song.mp4',
      at: at('14:00'),
    } as const;
    const music = makeSongView({
      song: makeSong({ gotAt: at('11:55') }),
      picks: [{ id: 'song', at: at('11:55') }],
    });
    const rows = historyRows({ ...source, music, noSong }, now, UTC);
    const text = rows.map((row) => `${row.time} ${row.text}`);
    expect(text.at(-1)).toBe('14:00 Rendered with the song, and without it');
    expect(rows.at(-1)?.id).toBe('export-no-song');
  });

  it('says nothing of the second file until it is ready', () => {
    for (const noSong of [
      { state: 'none' },
      { state: 'idle' },
      { state: 'making' },
      { state: 'failed', message: 'No.' },
      null,
    ] as const) {
      const rows = historyRows({ ...source, music: makeSongView(), noSong }, now, UTC);
      expect(
        rows.some((row) => row.text.includes('Rendered with the song')),
        String(noSong?.state),
      ).toBe(false);
    }
  });
});
