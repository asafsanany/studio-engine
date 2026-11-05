import { MUSIC_NOT_ASKED_REASON, type MusicPick, type MusicView } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeMusicPlan, makeMusicVersion, makeMusicView } from '@/data/test-utils';
import { detailRows, phoneDetailRows } from './sheet-details';
import { historyRows } from './sheet-history';
import {
  AUTO_PICK_WINDOW_MS,
  MUSIC_SHEET_TEXT,
  musicDetailRow,
  musicHistoryRows,
} from './sheet-music';
import {
  JOB_SHEET_STATES,
  jobSheetJobs,
  jobSheetNotes,
  jobSheetNow,
  jobSheetRuns,
} from './test-fixtures';

// The job sheet's music (Soundtrack): the Music row of Details and the music lines of History, as
// the boards SDSheet, SDStates and SDPhone draw them.

const UTC = 'UTC';

/** The day the boards call "Today", and a moment on it. */
const iso = (time: string) => `2026-10-22T${time}:00.000Z`;

const ASK = 'darker, heavier drums';

/** A job's music with only what the test names; the rest is an empty made record. */
function view(overrides: Partial<MusicView>): MusicView {
  return makeMusicView({
    source: 'made',
    reason: null,
    file: null,
    plan: null,
    picked: null,
    versions: [],
    picks: [],
    making: null,
    failure: null,
    ...overrides,
  });
}

/** v1 by the edit run, v2 by the owner's Make another with words; v2 is picked. Both were picked as they were made. */
function twoVersions(overrides: Partial<MusicView> = {}): MusicView {
  return makeMusicView({
    picked: 'v2',
    versions: [
      makeMusicVersion(1, { madeAt: iso('13:10') }),
      makeMusicVersion(2, {
        by: 'you',
        ask: ASK,
        describe: `You asked: ${ASK}. Same shape: ${makeMusicPlan().describe}`,
        madeAt: iso('13:20'),
      }),
    ],
    picks: [
      { id: 'v1', at: iso('13:10') },
      { id: 'v2', at: iso('13:20') },
    ],
    ...overrides,
  });
}

describe('musicDetailRow', () => {
  it('has no row without a music view (the switch is off, or the job has no music.json)', () => {
    expect(musicDetailRow(null)).toBeNull();
    expect(musicDetailRow(undefined)).toBeNull();
  });

  it('says "Made for this video" and the version’s line for one version, without a count', () => {
    expect(musicDetailRow(makeMusicView())).toEqual({
      label: 'Music',
      value: 'Made for this video · v1',
      muted: false,
      sub: makeMusicPlan().describe,
    });
  });

  it('says which version of how many is picked, with that version’s own line', () => {
    const row = musicDetailRow(twoVersions());
    expect(row?.value).toBe('Made for this video · v2 of 2');
    expect(row?.sub).toBe(`You asked: ${ASK}. Same shape: ${makeMusicPlan().describe}`);
    expect(row?.tone).toBeUndefined();
    expect(row?.muted).toBe(false);
  });

  it('follows the pick back to an older version', () => {
    const row = musicDetailRow(twoVersions({ picked: 'v1' }));
    expect(row?.value).toBe('Made for this video · v1 of 2');
    expect(row?.sub).toBe(makeMusicPlan().describe);
  });

  it('reads a pick that names no version as the latest one', () => {
    const row = musicDetailRow(twoVersions({ picked: null }));
    expect(row?.value).toBe('Made for this video · v2 of 2');
  });

  describe('while a version is being made', () => {
    it('says "Making it now" for the first one, and why there is no file', () => {
      const row = musicDetailRow(
        view({ making: { id: 'v1', ask: null, startedAt: iso('13:05') } }),
      );
      expect(row).toEqual({
        label: 'Music',
        value: 'Making it now',
        muted: false,
        sub: 'Written to the cut by ElevenLabs. No music file was in the folder.',
      });
    });

    it('does not claim there was no file when the first version is made over a rule or a file', () => {
      for (const source of ['none', 'supplied', 'series'] as const) {
        const row = musicDetailRow(
          view({ source, making: { id: 'v1', ask: null, startedAt: iso('13:05') } }),
        );
        expect(row?.value, source).toBe('Making it now');
        expect(row?.sub, source).toBe(MUSIC_SHEET_TEXT.makingFirstAnyway);
      }
    });

    it('gives the first version’s ask instead of the default line', () => {
      const row = musicDetailRow(
        view({ making: { id: 'v1', ask: 'calmer', startedAt: iso('13:05') } }),
      );
      expect(row?.sub).toBe('You asked: calmer');
    });

    it('says "Making v3" and the ask for another one', () => {
      const row = musicDetailRow(
        twoVersions({ making: { id: 'v3', ask: 'more bass', startedAt: iso('13:30') } }),
      );
      expect(row).toEqual({
        label: 'Music',
        value: 'Making v3',
        muted: false,
        sub: 'You asked: more bass',
      });
    });

    it('has no second line for another one made without words', () => {
      const row = musicDetailRow(
        twoVersions({ making: { id: 'v3', ask: null, startedAt: iso('13:30') } }),
      );
      expect(row?.value).toBe('Making v3');
      expect(row).not.toHaveProperty('sub');
    });

    it('wins over an earlier failure and over a pick of no music', () => {
      const failure = {
        id: 'v1',
        code: 'down' as const,
        message: 'ElevenLabs could not be reached.',
        at: iso('13:03'),
      };
      const first = { id: 'v1', ask: null, startedAt: iso('13:05') };
      expect(musicDetailRow(view({ failure, making: first }))?.value).toBe('Making it now');
      const third = { id: 'v3', ask: null, startedAt: iso('13:30') };
      expect(musicDetailRow(twoVersions({ picked: 'off', making: third }))?.value).toBe(
        'Making v3',
      );
    });
  });

  it('says "None · you turned it off" for No music, with nothing under it', () => {
    const row = musicDetailRow(twoVersions({ picked: 'off' }));
    expect(row).toEqual({ label: 'Music', value: 'None · you turned it off', muted: false });
  });

  describe('a file from the folder', () => {
    const supplied = (overrides: Partial<MusicView> = {}) =>
      view({
        source: 'supplied',
        file: 'Summer Vibes.mp3',
        picked: 'file',
        picks: [{ id: 'file', at: iso('13:00') }],
        ...overrides,
      });

    it('names the file and says nothing was made', () => {
      expect(musicDetailRow(supplied())).toEqual({
        label: 'Music',
        value: 'Summer Vibes.mp3',
        muted: false,
        sub: 'From the folder. Nothing was made.',
      });
    });

    it('names a file in a sub-folder by its own name', () => {
      expect(musicDetailRow(supplied({ file: 'audio/Summer Vibes.mp3' }))?.value).toBe(
        'Summer Vibes.mp3',
      );
    });

    it('keeps a Hebrew file name as it is', () => {
      expect(musicDetailRow(supplied({ file: 'מוזיקה/שיר קיץ.mp3' }))?.value).toBe('שיר קיץ.mp3');
    });

    it('still says something when the record does not name the file', () => {
      expect(musicDetailRow(supplied({ file: null }))?.value).toBe('A file from the folder');
    });

    it('says No music when it was turned off', () => {
      expect(musicDetailRow(supplied({ picked: 'off' }))?.value).toBe('None · you turned it off');
    });

    it('stays the folder’s file when a make failed over it', () => {
      const failure = {
        id: 'v1',
        code: 'no_credits' as const,
        message: 'ElevenLabs says this month’s credits are used up.',
        at: iso('13:10'),
      };
      const row = musicDetailRow(supplied({ failure }));
      expect(row?.value).toBe('Summer Vibes.mp3');
      expect(row?.tone).toBeUndefined();
    });
  });

  describe('the series’ music', () => {
    it('says it is the series’ and names the kit’s file', () => {
      const row = musicDetailRow(
        view({ source: 'series', file: 'Kit/Theme.mp3', picked: 'series' }),
      );
      expect(row).toEqual({
        label: 'Music',
        value: 'The series’ music',
        muted: false,
        sub: 'Theme.mp3',
      });
    });

    it('has no second line without a file name', () => {
      const row = musicDetailRow(view({ source: 'series', file: null, picked: 'series' }));
      expect(row).toEqual({ label: 'Music', value: 'The series’ music', muted: false });
    });
  });

  describe('no music on purpose', () => {
    it('says "None" and whose rule it was', () => {
      const reason = 'The client’s style says no music under the lawyer’s answers.';
      expect(musicDetailRow(view({ source: 'none', reason }))).toEqual({
        label: 'Music',
        value: 'None',
        muted: false,
        sub: reason,
      });
    });

    it('has no second line when the record gives no reason', () => {
      expect(musicDetailRow(view({ source: 'none', reason: null }))).toEqual({
        label: 'Music',
        value: 'None',
        muted: false,
      });
    });
  });

  // U21: music is made only when the job asks for it.
  describe('no music because nobody asked for it', () => {
    it('says it in plain words, with nothing about a rule', () => {
      expect(musicDetailRow(view({ source: 'none', reason: MUSIC_NOT_ASKED_REASON }))).toEqual({
        label: 'Music',
        value: 'No music asked for',
        muted: false,
        sub: 'Nothing was made.',
      });
      expect(MUSIC_SHEET_TEXT.notAsked).toBe('No music asked for');
    });

    it('has no History lines: nothing was made, picked or failed', () => {
      const music = view({
        source: 'none',
        reason: MUSIC_NOT_ASKED_REASON,
        versions: [],
        picks: [],
      });
      expect(musicHistoryRows(music)).toEqual([]);
    });

    it('says “Making it now” once Make music starts', () => {
      expect(
        musicDetailRow(
          view({
            source: 'none',
            reason: MUSIC_NOT_ASKED_REASON,
            making: { id: 'v1', ask: null, startedAt: iso('13:00') },
          }),
        )?.value,
      ).toBe('Making it now');
    });
  });

  describe('music that could not be made', () => {
    const failure = {
      id: 'v1',
      code: 'no_credits' as const,
      message: 'ElevenLabs says this month’s credits are used up.',
      at: iso('13:10'),
    };

    it('says "None · couldn’t make it" in the failure colour, and the reason under it', () => {
      expect(musicDetailRow(view({ failure }))).toEqual({
        label: 'Music',
        value: 'None · couldn’t make it',
        muted: false,
        sub: failure.message,
        tone: 'failure',
      });
    });

    it('keeps saying what plays when another version failed: the video has v1', () => {
      const row = musicDetailRow(
        makeMusicView({ failure: { ...failure, id: 'v2' }, picked: 'v1' }),
      );
      expect(row?.value).toBe('Made for this video · v1');
      expect(row?.tone).toBeUndefined();
    });
  });

  it('has nothing to say about a record with nothing in it', () => {
    expect(musicDetailRow(view({}))).toBeNull();
  });
});

describe('musicHistoryRows', () => {
  const lines = (music: MusicView | null) =>
    musicHistoryRows(music).map(({ at, text }) => [at, text] as const);

  it('has no lines without a music view', () => {
    expect(musicHistoryRows(null)).toEqual([]);
    expect(musicHistoryRows(undefined)).toEqual([]);
  });

  it('has no lines for a record with nothing in it', () => {
    expect(musicHistoryRows(view({}))).toEqual([]);
  });

  describe('a version made', () => {
    it('by the edit run says its length and ElevenLabs', () => {
      const music = makeMusicView({
        versions: [makeMusicVersion(1, { madeAt: iso('13:10') })],
        picks: [{ id: 'v1', at: iso('13:10') }],
      });
      expect(lines(music)).toEqual([[iso('13:10'), 'Music v1 made · 0:39 · ElevenLabs']]);
    });

    it('by Make another with words says what they asked', () => {
      expect(lines(twoVersions())).toContainEqual([
        iso('13:20'),
        `Music v2 made · you asked: ${ASK}`,
      ]);
    });

    it('by Make another without words says they asked for another', () => {
      const music = twoVersions();
      music.versions[1] = { ...music.versions[1], ask: null } as (typeof music.versions)[number];
      expect(lines(music)).toContainEqual([iso('13:20'), 'Music v2 made · you asked for another']);
    });

    it('by a revise run says it fits the new cut', () => {
      const music = makeMusicView({
        versions: [
          makeMusicVersion(1, { madeAt: iso('13:10') }),
          makeMusicVersion(2, { by: 'revise', madeAt: iso('13:40') }),
        ],
        picked: 'v2',
        picks: [
          { id: 'v1', at: iso('13:10') },
          { id: 'v2', at: iso('13:40') },
        ],
      });
      expect(lines(music)).toEqual([
        [iso('13:10'), 'Music v1 made · 0:39 · ElevenLabs'],
        [iso('13:40'), 'Music v2 made · fits the new cut'],
      ]);
    });

    it('says the length of the version, not the plan', () => {
      const music = makeMusicView({
        versions: [makeMusicVersion(1, { lengthMs: 41_000, madeAt: iso('13:10') })],
        picks: [],
      });
      expect(lines(music)[0]?.[1]).toBe('Music v1 made · 0:41 · ElevenLabs');
    });
  });

  describe('picks', () => {
    it('leaves out the pick a make records for the version the edit run or a revise run made', () => {
      const music = makeMusicView({
        versions: [
          makeMusicVersion(1, { madeAt: iso('13:10') }),
          makeMusicVersion(2, { by: 'revise', madeAt: iso('13:40') }),
        ],
        picked: 'v2',
        picks: [
          { id: 'v1', at: '2026-10-22T13:10:00.250Z' },
          { id: 'v2', at: '2026-10-22T13:40:00.250Z' },
        ],
      });
      expect(lines(music).map(([, text]) => text)).toEqual([
        'Music v1 made · 0:39 · ElevenLabs',
        'Music v2 made · fits the new cut',
      ]);
    });

    it('keeps the pick of a version the owner made themselves: their make is their choice (board "review")', () => {
      expect(lines(twoVersions()).map(([, text]) => text)).toEqual([
        'Music v1 made · 0:39 · ElevenLabs',
        `Music v2 made · you asked: ${ASK}`,
        'You picked music v2',
      ]);
    });

    it('says "You picked music v1" for a pick of an older version', () => {
      const music = twoVersions({
        picked: 'v1',
        picks: [
          { id: 'v1', at: iso('13:10') },
          { id: 'v2', at: iso('13:20') },
          { id: 'v1', at: iso('13:25') },
        ],
      });
      expect(lines(music)).toContainEqual([iso('13:25'), 'You picked music v1']);
    });

    it('says "You turned the music off" for No music', () => {
      const music = twoVersions({
        picked: 'off',
        picks: [
          { id: 'v1', at: iso('13:10') },
          { id: 'v2', at: iso('13:20') },
          { id: 'off', at: iso('13:26') },
        ],
      });
      expect(lines(music)).toContainEqual([iso('13:26'), 'You turned the music off']);
    });

    it('counts only the first pick of a version soon after it was made as the make’s own', () => {
      const music = makeMusicView({
        versions: [makeMusicVersion(1, { madeAt: iso('13:10') })],
        picks: [
          { id: 'v1', at: '2026-10-22T13:10:00.100Z' },
          { id: 'off', at: iso('13:12') },
          { id: 'v1', at: iso('13:13') },
        ],
      });
      expect(lines(music).map(([, text]) => text)).toEqual([
        'Music v1 made · 0:39 · ElevenLabs',
        'You turned the music off',
        'You picked music v1',
      ]);
    });

    it('keeps a pick that comes long after the version was made, as the owner’s', () => {
      const wait = AUTO_PICK_WINDOW_MS + 60_000;
      const madeAt = iso('13:10');
      const music = makeMusicView({
        versions: [makeMusicVersion(1, { madeAt })],
        picks: [{ id: 'v1', at: new Date(Date.parse(madeAt) + wait).toISOString() }],
      });
      expect(lines(music).map(([, text]) => text)).toContain('You picked music v1');
    });

    it('says nothing of the file or the series’ music that was recorded as a pick', () => {
      expect(
        lines(
          view({
            source: 'supplied',
            file: 'Summer Vibes.mp3',
            picked: 'file',
            picks: [{ id: 'file', at: iso('13:00') }],
          }),
        ),
      ).toEqual([]);
      expect(
        lines(
          view({
            source: 'series',
            file: 'Kit/Theme.mp3',
            picked: 'series',
            picks: [{ id: 'series', at: iso('13:00') }],
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('a make that failed', () => {
    it('says "Couldn’t make music: <why>" in the failure tone', () => {
      const music = view({
        failure: {
          id: 'v1',
          code: 'no_credits',
          message: 'ElevenLabs says this month’s credits are used up.',
          at: iso('13:06'),
        },
      });
      expect(musicHistoryRows(music)).toEqual([
        {
          id: 'music-failed',
          at: iso('13:06'),
          text: 'Couldn’t make music: ElevenLabs says this month’s credits are used up.',
          tone: 'failure',
        },
      ]);
    });
  });

  describe('a make going on', () => {
    it('says "Making music for the cut" with the plan’s length for the first version, in the active tone', () => {
      const music = view({
        plan: makeMusicPlan({
          lengthMs: 41_000,
          sections: [{ name: 'All', ms: 41_000, styles: ['a'], avoid: [] }],
        }),
        making: { id: 'v1', ask: null, startedAt: iso('00:19') },
      });
      expect(musicHistoryRows(music)).toEqual([
        {
          id: 'music-making',
          at: iso('00:19'),
          text: 'Making music for the cut · 0:41',
          tone: 'active',
        },
      ]);
    });

    it('leaves the length out when the record has no plan', () => {
      const music = view({ making: { id: 'v1', ask: null, startedAt: iso('00:19') } });
      expect(musicHistoryRows(music)[0]?.text).toBe('Making music for the cut');
    });

    it('names the version and the ask for another one', () => {
      const withAsk = twoVersions({
        making: { id: 'v3', ask: 'more bass', startedAt: iso('13:30') },
      });
      expect(lines(withAsk).at(-1)).toEqual([
        iso('13:30'),
        'Making music v3 · you asked: more bass',
      ]);
      const without = twoVersions({ making: { id: 'v3', ask: null, startedAt: iso('13:30') } });
      expect(lines(without).at(-1)).toEqual([iso('13:30'), 'Making music v3']);
    });
  });

  describe('ids', () => {
    /** A record with a line of every kind. */
    function everything(): MusicView {
      const picks: MusicPick[] = [
        { id: 'v1', at: iso('13:10') },
        { id: 'v2', at: iso('13:20') },
        { id: 'v1', at: iso('13:25') },
        { id: 'off', at: iso('13:26') },
        { id: 'v1', at: iso('13:27') },
      ];
      return twoVersions({
        picked: 'v1',
        picks,
        making: { id: 'v3', ask: null, startedAt: iso('13:30') },
        failure: { id: 'v3', code: 'down', message: 'ElevenLabs is down.', at: iso('13:29') },
      });
    }

    it('are unique within the history, and the history’s own are not taken', () => {
      const ids = musicHistoryRows(everything()).map((line) => line.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(7);
      const taken =
        /^(appeared|settled|started|ready-\d+|sent-\d+|approved|mp4|delivered|paid|archived|failed|cancelled)$/;
      for (const id of ids) expect(id).not.toMatch(taken);
    });

    it('stay the same for a line when later ones are added', () => {
      const before = everything();
      const after = {
        ...before,
        picks: [...before.picks, { id: 'v2' as const, at: iso('13:40') }],
      };
      const idOf = (music: MusicView) =>
        Object.fromEntries(musicHistoryRows(music).map((line) => [line.text + line.at, line.id]));
      const first = idOf(before);
      const second = idOf(after);
      for (const [key, id] of Object.entries(first)) expect(second[key]).toBe(id);
    });
  });
});

describe('in the sheet', () => {
  const music = twoVersions();

  it('gives the Mac’s Details a Music row after Inputs, before Added, for every state of the boards', () => {
    for (const state of JOB_SHEET_STATES) {
      const job = jobSheetJobs[state];
      const labels = detailRows(job, jobSheetNow[state], UTC, music).map((row) => row.label);
      expect(labels, state).toContain('Music');
      const without = detailRows(job, jobSheetNow[state], UTC).map((row) => row.label);
      expect(
        labels.filter((label) => label !== 'Music'),
        state,
      ).toEqual(without);
      expect(labels.indexOf('Music'), state).toBe(labels.indexOf('Added') - 1);
      if (labels.includes('Inputs')) {
        expect(labels.indexOf('Music'), state).toBe(labels.indexOf('Inputs') + 1);
      }
    }
  });

  it('leaves the rows as they were without music, or with a music that has no row', () => {
    for (const state of JOB_SHEET_STATES) {
      const job = jobSheetJobs[state];
      const now = jobSheetNow[state];
      expect(detailRows(job, now, UTC, null), state).toEqual(detailRows(job, now, UTC));
      expect(detailRows(job, now, UTC, view({})), state).toEqual(detailRows(job, now, UTC));
      expect(phoneDetailRows(job, now, UTC, null, null), state).toEqual(
        phoneDetailRows(job, now, UTC, null),
      );
    }
  });

  it('puts the Music row on an Approved job’s phone Details, after Inputs, before Approved', () => {
    const rows = phoneDetailRows(jobSheetJobs.approved, jobSheetNow.approved, UTC, null, music);
    expect(rows?.map((row) => row.label)).toEqual(['Inputs', 'Music', 'Approved', 'File']);
    expect(rows?.[1]?.value).toBe('Made for this video · v2 of 2');
  });

  it('keeps the phone’s Delivered and Paid Details to the boards’ money rows', () => {
    for (const state of ['delivered', 'paid'] as const) {
      const rows = phoneDetailRows(jobSheetJobs[state], jobSheetNow[state], UTC, null, music);
      expect(
        rows?.map((row) => row.label),
        state,
      ).not.toContain('Music');
    }
  });

  it('puts the music lines in History in time order among the others, with their tone', () => {
    const job = jobSheetJobs.review;
    const source = { job, runs: jobSheetRuns.review, notes: jobSheetNotes.review };
    const failing = view({
      failure: {
        id: 'v1',
        code: 'no_credits',
        message: 'ElevenLabs says this month’s credits are used up.',
        at: iso('13:06'),
      },
    });
    const rows = historyRows({ ...source, music: failing }, jobSheetNow.review, UTC);
    expect(rows.map((row) => `${row.time} ${row.text}`)).toEqual([
      '13:01 Folder appeared',
      '13:02 Settled: 8 video clips, 1 audio file, 3 images',
      '13:02 Started · Extra high',
      '13:06 Couldn’t make music: ElevenLabs says this month’s credits are used up.',
      '13:35 First cut ready for review',
    ]);
    expect(rows[3]).toMatchObject({ id: 'music-failed', tone: 'failure' });
    expect(rows.filter((row) => row.tone)).toHaveLength(1);
  });

  it('shows a made version before the cut is ready, and the owner’s Make another and pick after it', () => {
    const job = jobSheetJobs.review;
    const source = { job, runs: jobSheetRuns.review, notes: jobSheetNotes.review };
    const rows = historyRows({ ...source, music }, jobSheetNow.review, UTC);
    expect(rows.map((row) => `${row.time} ${row.text}`)).toEqual([
      '13:01 Folder appeared',
      '13:02 Settled: 8 video clips, 1 audio file, 3 images',
      '13:02 Started · Extra high',
      '13:10 Music v1 made · 0:39 · ElevenLabs',
      '13:20 Music v2 made · you asked: darker, heavier drums',
      '13:20 You picked music v2',
      '13:35 First cut ready for review',
    ]);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.some((row) => 'tone' in row)).toBe(false);
  });

  it('adds no History lines for no music, an empty record, or a null one', () => {
    for (const state of JOB_SHEET_STATES) {
      const source = {
        job: jobSheetJobs[state],
        runs: jobSheetRuns[state],
        notes: jobSheetNotes[state],
      };
      const now = jobSheetNow[state];
      expect(historyRows({ ...source, music: view({}) }, now, UTC), state).toEqual(
        historyRows(source, now, UTC),
      );
      expect(historyRows({ ...source, music: null }, now, UTC), state).toEqual(
        historyRows(source, now, UTC),
      );
    }
  });
});
