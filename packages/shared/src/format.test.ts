import { describe, expect, it } from 'vitest';
import type { Job } from './domain/job.ts';
import { JOB_STATES } from './domain/status.ts';
import { makeJob, SAMPLE_PREVIEW } from './domain/test-fixtures.ts';
import {
  absoluteTime,
  clientHue,
  clock,
  cutRound,
  editingDetail,
  eta,
  fileSize,
  initials,
  inputTooltip,
  listDetail,
  relativeTime,
  resolution,
  runKindDetail,
  spanText,
  statusDetail,
  stepLabel,
} from './format.ts';

// The canvas shows Tue 20 Oct 2026, 13:42. Times are pinned to Asia/Jerusalem, which is UTC+3 on
// every date used below (daylight saving ends on 25 Oct 2026), so no suite depends on the machine's
// own zone and none changes the global TZ.
const TZ = 'Asia/Jerusalem';
const local = (day: number, hour: number, minute: number, second = 0): string =>
  new Date(Date.UTC(2026, 9, day, hour - 3, minute, second)).toISOString();
const NOW = local(20, 13, 42, 30);
const NOW_MS = Date.parse(NOW);
const secondsAgo = (sec: number): string => new Date(NOW_MS - sec * 1000).toISOString();

// ---------------------------------------------------------------------------------------------
// The twelve jobs of the approved "Jobs" board, strings copied from its mock data.
// ---------------------------------------------------------------------------------------------

type Counts = [video: number, audio: number, image: number, doc: number];

interface CanvasRow {
  id: string;
  client: string;
  initials: string;
  inputs: Counts;
  tooltips: [string, string, string, string];
  sizeBytes: number;
  size: string;
  addedAt: string;
  addedRel: string;
  addedAbs: string;
  updatedAt: string;
  updRel: string;
  updAbs: string;
  job: Partial<Job>;
  /** statusDetail, or stepLabel and eta for the editing job. */
  detail: string;
  stepLabel: string;
  eta: string;
}

const READY = (durationSec: number, width: number, height: number, sizeBytes: number) => ({
  fileName: 'Client/Job.mp4',
  durationSec,
  width,
  height,
  sizeBytes,
});

const CANVAS_ROWS: CanvasRow[] = [
  {
    id: 'j1 arriving',
    client: 'מאפיית הצפון',
    initials: 'מה',
    inputs: [14, 3, 1, 1],
    tooltips: ['14 video clips', '3 audio files', '1 image', '1 document'],
    sizeBytes: 3_100_000_000,
    size: '3.1 GB',
    addedAt: local(20, 13, 41),
    addedRel: '1 min ago',
    addedAbs: 'Tue 20 Oct 2026, 13:41',
    updatedAt: local(20, 13, 41),
    updRel: '1 min ago',
    updAbs: 'Tue 20 Oct 2026, 13:41',
    job: {
      state: 'arriving',
      placeInLine: null,
      settlesAt: new Date(NOW_MS + 42_000).toISOString(),
    },
    detail: 'settles in 0:42',
    stepLabel: '',
    eta: '',
  },
  {
    id: 'j2 queued',
    client: 'Arc Fitness',
    initials: 'AF',
    inputs: [0, 1, 5, 0],
    tooltips: ['0 video clips', '1 audio file', '5 images', '0 documents'],
    sizeBytes: 48_000_000,
    size: '48 MB',
    addedAt: local(20, 13, 30),
    addedRel: '12 min ago',
    addedAbs: 'Tue 20 Oct 2026, 13:30',
    updatedAt: local(20, 13, 31),
    updRel: '11 min ago',
    updAbs: 'Tue 20 Oct 2026, 13:31',
    job: { state: 'queued', placeInLine: 2 },
    detail: '#2 in line',
    stepLabel: '',
    eta: '',
  },
  {
    id: 'j3 held',
    client: 'מאפיית הצפון',
    initials: 'מה',
    inputs: [6, 2, 1, 0],
    tooltips: ['6 video clips', '2 audio files', '1 image', '0 documents'],
    sizeBytes: 1_100_000_000,
    size: '1.1 GB',
    addedAt: local(20, 13, 17),
    addedRel: '25 min ago',
    addedAbs: 'Tue 20 Oct 2026, 13:17',
    updatedAt: local(20, 13, 22),
    updRel: '20 min ago',
    updAbs: 'Tue 20 Oct 2026, 13:22',
    job: { state: 'held', placeInLine: null },
    detail: '',
    stepLabel: '',
    eta: '',
  },
  {
    id: 'j4 queued',
    client: 'מרפאת מירה',
    initials: 'ממ',
    inputs: [2, 1, 4, 0],
    tooltips: ['2 video clips', '1 audio file', '4 images', '0 documents'],
    sizeBytes: 1_400_000_000,
    size: '1.4 GB',
    addedAt: local(20, 13, 11),
    addedRel: '31 min ago',
    addedAbs: 'Tue 20 Oct 2026, 13:11',
    updatedAt: local(20, 13, 12),
    updRel: '30 min ago',
    updAbs: 'Tue 20 Oct 2026, 13:12',
    job: { state: 'queued', placeInLine: 1 },
    detail: '#1 in line',
    stepLabel: '',
    eta: '',
  },
  {
    id: 'j5 editing',
    client: 'Arc Fitness',
    initials: 'AF',
    inputs: [9, 0, 1, 1],
    tooltips: ['9 video clips', '0 audio files', '1 image', '1 document'],
    sizeBytes: 2_200_000_000,
    size: '2.2 GB',
    addedAt: local(20, 12, 54),
    addedRel: '48 min ago',
    addedAbs: 'Tue 20 Oct 2026, 12:54',
    updatedAt: local(20, 13, 42),
    updRel: 'Just now',
    updAbs: 'Tue 20 Oct 2026, 13:42',
    job: { state: 'editing', step: 5, subProgress: 'graphics 2/5', etaSec: 240, placeInLine: null },
    detail: '',
    stepLabel: 'Cut · graphics 2/5',
    eta: '~4 min left',
  },
  {
    id: 'j6 ready',
    client: 'Kova Coffee',
    initials: 'KC',
    inputs: [11, 0, 7, 0],
    tooltips: ['11 video clips', '0 audio files', '7 images', '0 documents'],
    sizeBytes: 2_800_000_000,
    size: '2.8 GB',
    addedAt: local(20, 11, 42),
    addedRel: '2 h ago',
    addedAbs: 'Tue 20 Oct 2026, 11:42',
    updatedAt: local(20, 11, 58),
    updRel: '1 h ago',
    updAbs: 'Tue 20 Oct 2026, 11:58',
    job: {
      state: 'ready',
      step: 8,
      placeInLine: null,
      output: READY(45.2, 1080, 1920, 61_900_000),
    },
    detail: '0:45 · 1080×1920 · 62 MB',
    stepLabel: 'Render',
    eta: '',
  },
  {
    id: 'j7 failed',
    client: 'טל נכסים',
    initials: 'טנ',
    inputs: [22, 0, 0, 1],
    tooltips: ['22 video clips', '0 audio files', '0 images', '1 document'],
    sizeBytes: 7_900_000_000,
    size: '7.9 GB',
    addedAt: local(20, 10, 42),
    addedRel: '3 h ago',
    addedAbs: 'Tue 20 Oct 2026, 10:42',
    updatedAt: local(20, 12, 7),
    updRel: '1 h ago',
    updAbs: 'Tue 20 Oct 2026, 12:07',
    job: { state: 'failed', step: 8, failedAt: 8, placeInLine: null },
    detail: 'at Render',
    stepLabel: 'Render',
    eta: '',
  },
  {
    id: 'j8 cancelled',
    client: 'Kova Coffee',
    initials: 'KC',
    inputs: [5, 1, 2, 0],
    tooltips: ['5 video clips', '1 audio file', '2 images', '0 documents'],
    sizeBytes: 900_000_000,
    size: '900 MB',
    addedAt: local(20, 8, 42),
    addedRel: '5 h ago',
    addedAbs: 'Tue 20 Oct 2026, 08:42',
    updatedAt: local(20, 9, 2),
    updRel: '4 h ago',
    updAbs: 'Tue 20 Oct 2026, 09:02',
    job: { state: 'cancelled', step: 4, stoppedAt: 4, placeInLine: null },
    detail: 'at Plan',
    stepLabel: 'Plan',
    eta: '',
  },
  {
    id: 'j9 ready',
    client: 'מרפאת מירה',
    initials: 'ממ',
    inputs: [4, 2, 0, 0],
    tooltips: ['4 video clips', '2 audio files', '0 images', '0 documents'],
    sizeBytes: 1_600_000_000,
    size: '1.6 GB',
    addedAt: local(19, 13, 20),
    addedRel: 'Yesterday',
    addedAbs: 'Mon 19 Oct 2026, 13:20',
    updatedAt: local(19, 13, 22),
    updRel: 'Yesterday',
    updAbs: 'Mon 19 Oct 2026, 13:22',
    job: { state: 'ready', step: 8, placeInLine: null, output: READY(72, 1080, 1920, 96_000_000) },
    detail: '1:12 · 1080×1920 · 96 MB',
    stepLabel: 'Render',
    eta: '',
  },
  {
    id: 'j10 ready',
    client: 'Arc Fitness',
    initials: 'AF',
    inputs: [8, 0, 1, 0],
    tooltips: ['8 video clips', '0 audio files', '1 image', '0 documents'],
    sizeBytes: 2_000_000_000,
    size: '2.0 GB',
    addedAt: local(19, 12, 22),
    addedRel: 'Yesterday',
    addedAbs: 'Mon 19 Oct 2026, 12:22',
    updatedAt: local(19, 12, 32),
    updRel: 'Yesterday',
    updAbs: 'Mon 19 Oct 2026, 12:32',
    job: {
      state: 'ready',
      step: 8,
      placeInLine: null,
      output: READY(57.6, 1920, 1080, 120_000_000),
    },
    detail: '0:58 · 1920×1080 · 120 MB',
    stepLabel: 'Render',
    eta: '',
  },
  {
    id: 'j11 ready',
    client: 'טל נכסים',
    initials: 'טנ',
    inputs: [12, 0, 0, 1],
    tooltips: ['12 video clips', '0 audio files', '0 images', '1 document'],
    sizeBytes: 3_300_000_000,
    size: '3.3 GB',
    addedAt: local(18, 15, 10),
    addedRel: '2 days ago',
    addedAbs: 'Sun 18 Oct 2026, 15:10',
    updatedAt: local(18, 15, 32),
    updRel: '2 days ago',
    updAbs: 'Sun 18 Oct 2026, 15:32',
    job: { state: 'ready', step: 8, placeInLine: null, output: READY(90, 1920, 1080, 180_000_000) },
    detail: '1:30 · 1920×1080 · 180 MB',
    stepLabel: 'Render',
    eta: '',
  },
  {
    id: 'j12 ready',
    client: 'מאפיית הצפון',
    initials: 'מה',
    inputs: [6, 1, 0, 0],
    tooltips: ['6 video clips', '1 audio file', '0 images', '0 documents'],
    sizeBytes: 640_000_000,
    size: '640 MB',
    addedAt: local(17, 10, 15),
    addedRel: '3 days ago',
    addedAbs: 'Sat 17 Oct 2026, 10:15',
    updatedAt: local(17, 8, 32),
    updRel: '3 days ago',
    updAbs: 'Sat 17 Oct 2026, 08:32',
    job: { state: 'ready', step: 8, placeInLine: null, output: READY(30, 1080, 1920, 41_000_000) },
    detail: '0:30 · 1080×1920 · 41 MB',
    stepLabel: 'Render',
    eta: '',
  },
];

describe('the approved Jobs board, row by row', () => {
  describe.each(CANVAS_ROWS)('$id', (row) => {
    const job = makeJob({
      client: row.client,
      sizeBytes: row.sizeBytes,
      inputs: {
        video: row.inputs[0],
        audio: row.inputs[1],
        image: row.inputs[2],
        doc: row.inputs[3],
      },
      addedAt: row.addedAt,
      updatedAt: row.updatedAt,
      ...row.job,
    });

    it('Added', () => {
      expect(relativeTime(job.addedAt, NOW, TZ)).toBe(row.addedRel);
      expect(absoluteTime(job.addedAt, TZ)).toBe(row.addedAbs);
    });

    it('Last updated', () => {
      expect(relativeTime(job.updatedAt, NOW, TZ)).toBe(row.updRel);
      expect(absoluteTime(job.updatedAt, TZ)).toBe(row.updAbs);
    });

    it('Size', () => {
      expect(fileSize(job.sizeBytes)).toBe(row.size);
    });

    it('Client avatar', () => {
      expect(initials(job.client)).toBe(row.initials);
    });

    it('Inputs tooltips, in video, audio, image, document order', () => {
      expect([
        inputTooltip('video', job.inputs.video),
        inputTooltip('audio', job.inputs.audio),
        inputTooltip('image', job.inputs.image),
        inputTooltip('doc', job.inputs.doc),
      ]).toEqual(row.tooltips);
    });

    it('Status detail', () => {
      expect(statusDetail(job, NOW)).toBe(row.detail);
    });

    it('Step label and ETA', () => {
      expect(stepLabel(job)).toBe(row.stepLabel);
      expect(eta(job.etaSec)).toBe(row.eta);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('relativeTime', () => {
  it('says "Just now" under 60 seconds', () => {
    expect(relativeTime(secondsAgo(0), NOW, TZ)).toBe('Just now');
    expect(relativeTime(secondsAgo(59), NOW, TZ)).toBe('Just now');
    expect(relativeTime(secondsAgo(59.9), NOW, TZ)).toBe('Just now');
  });

  it('counts whole minutes, rounded down, up to an hour', () => {
    expect(relativeTime(secondsAgo(60), NOW, TZ)).toBe('1 min ago');
    expect(relativeTime(secondsAgo(119), NOW, TZ)).toBe('1 min ago');
    expect(relativeTime(secondsAgo(120), NOW, TZ)).toBe('2 min ago');
    expect(relativeTime(secondsAgo(12 * 60 + 30), NOW, TZ)).toBe('12 min ago');
    expect(relativeTime(secondsAgo(59 * 60 + 59), NOW, TZ)).toBe('59 min ago');
  });

  it('counts whole hours, rounded down, within the same day', () => {
    expect(relativeTime(secondsAgo(3600), NOW, TZ)).toBe('1 h ago');
    expect(relativeTime(secondsAgo(2 * 3600 - 1), NOW, TZ)).toBe('1 h ago');
    expect(relativeTime(secondsAgo(2 * 3600), NOW, TZ)).toBe('2 h ago');
    expect(relativeTime(local(20, 0, 0), NOW, TZ)).toBe('13 h ago');
  });

  it('treats a time in the future (clock skew) as "Just now"', () => {
    expect(relativeTime(secondsAgo(-1), NOW, TZ)).toBe('Just now');
    expect(relativeTime(secondsAgo(-3600), NOW, TZ)).toBe('Just now');
    expect(relativeTime(local(22, 9, 0), NOW, TZ)).toBe('Just now');
  });

  describe('calendar days, not 24-hour blocks', () => {
    const midnight = local(20, 0, 30);

    it('an hour or more ago on the previous calendar day is "Yesterday"', () => {
      expect(relativeTime(local(19, 23, 30), midnight, TZ)).toBe('Yesterday');
      expect(relativeTime(local(19, 23, 10), midnight, TZ)).toBe('Yesterday');
      expect(relativeTime(local(19, 0, 0), midnight, TZ)).toBe('Yesterday');
    });

    it('under an hour ago still counts minutes across midnight', () => {
      expect(relativeTime(local(19, 23, 50), midnight, TZ)).toBe('40 min ago');
      expect(relativeTime(local(19, 23, 31), midnight, TZ)).toBe('59 min ago');
    });

    it('the day before yesterday is "2 days ago", however few hours it is', () => {
      expect(relativeTime(local(18, 23, 59), midnight, TZ)).toBe('2 days ago');
      expect(relativeTime(local(18, 23, 59), local(20, 0, 1), TZ)).toBe('2 days ago');
    });

    it('later in the day than now is still "Yesterday" the next day', () => {
      expect(relativeTime(local(19, 23, 59), local(20, 13, 42), TZ)).toBe('Yesterday');
    });

    it('counts further back in days', () => {
      expect(relativeTime(local(17, 10, 15), NOW, TZ)).toBe('3 days ago');
      expect(relativeTime(local(10, 10, 15), NOW, TZ)).toBe('10 days ago');
      expect(relativeTime('2026-09-05T10:00:00.000Z', NOW, TZ)).toBe('45 days ago');
    });
  });

  describe('time zones', () => {
    // 22:30 UTC on the 19th is 01:30 on the 20th in Jerusalem.
    const then = '2026-10-19T22:30:00.000Z';
    const now = '2026-10-20T00:10:00.000Z';

    it('the same two instants give different days in different zones', () => {
      expect(relativeTime(then, now, 'UTC')).toBe('Yesterday');
      expect(relativeTime(then, now, TZ)).toBe('1 h ago');
    });

    it('follows daylight saving: a 25-hour day', () => {
      // 00:30 EDT on 1 Nov 2026 to 00:30 EST on 2 Nov 2026.
      expect(
        relativeTime('2026-11-01T04:30:00.000Z', '2026-11-02T05:30:00.000Z', 'America/New_York'),
      ).toBe('Yesterday');
    });

    it('follows daylight saving: the hour that does not exist', () => {
      // 01:30 EST to 03:30 EDT on 8 Mar 2026 is one hour of real time.
      expect(
        relativeTime('2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z', 'America/New_York'),
      ).toBe('1 h ago');
    });

    it('without a zone, uses the system zone', () => {
      const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
      for (const row of CANVAS_ROWS) {
        expect(relativeTime(row.addedAt, NOW)).toBe(relativeTime(row.addedAt, NOW, system));
        expect(relativeTime(row.updatedAt, NOW)).toBe(relativeTime(row.updatedAt, NOW, system));
      }
    });

    it('rejects a time zone that does not exist', () => {
      expect(() => relativeTime(then, now, 'Not/AZone')).toThrow(RangeError);
    });
  });

  it('accepts a Date or epoch milliseconds for either argument', () => {
    expect(relativeTime(new Date(NOW_MS - 12 * 60_000), NOW_MS, TZ)).toBe('12 min ago');
    expect(relativeTime(NOW_MS - 12 * 60_000, new Date(NOW_MS), TZ)).toBe('12 min ago');
  });

  it('gives "" for a time it cannot read', () => {
    expect(relativeTime('', NOW, TZ)).toBe('');
    expect(relativeTime('yesterday-ish', NOW, TZ)).toBe('');
    expect(relativeTime(NOW, 'not a time', TZ)).toBe('');
    expect(relativeTime(Number.NaN, NOW, TZ)).toBe('');
  });
});

describe('absoluteTime', () => {
  it('formats the example from the board', () => {
    expect(absoluteTime(local(20, 13, 41), TZ)).toBe('Tue 20 Oct 2026, 13:41');
  });

  it('shows the same instant in the zone asked for', () => {
    const instant = '2026-10-20T10:41:00.000Z';
    expect(absoluteTime(instant, 'UTC')).toBe('Tue 20 Oct 2026, 10:41');
    expect(absoluteTime(instant, TZ)).toBe('Tue 20 Oct 2026, 13:41');
    expect(absoluteTime(instant, 'America/New_York')).toBe('Tue 20 Oct 2026, 06:41');
    expect(absoluteTime(instant, 'Asia/Tokyo')).toBe('Tue 20 Oct 2026, 19:41');
  });

  it('moves the date, weekday and year with the zone', () => {
    expect(absoluteTime('2026-12-31T23:30:00.000Z', TZ)).toBe('Fri 1 Jan 2027, 01:30');
    expect(absoluteTime('2026-12-31T23:30:00.000Z', 'America/New_York')).toBe(
      'Thu 31 Dec 2026, 18:30',
    );
  });

  it('pads the hour and minute but not the day', () => {
    expect(absoluteTime('2026-10-05T06:05:00.000Z', 'UTC')).toBe('Mon 5 Oct 2026, 06:05');
  });

  it('shows midnight as 00:00, never 24:00', () => {
    expect(absoluteTime(local(20, 0, 0), TZ)).toBe('Tue 20 Oct 2026, 00:00');
    expect(absoluteTime(local(20, 0, 5), TZ)).toBe('Tue 20 Oct 2026, 00:05');
    expect(absoluteTime(local(20, 23, 59), TZ)).toBe('Tue 20 Oct 2026, 23:59');
  });

  it('spells every month and weekday in English', () => {
    const fifteenth = [
      'Thu 15 Jan 2026',
      'Sun 15 Feb 2026',
      'Sun 15 Mar 2026',
      'Wed 15 Apr 2026',
      'Fri 15 May 2026',
      'Mon 15 Jun 2026',
      'Wed 15 Jul 2026',
      'Sat 15 Aug 2026',
      'Tue 15 Sep 2026',
      'Thu 15 Oct 2026',
      'Sun 15 Nov 2026',
      'Tue 15 Dec 2026',
    ];
    expect(fifteenth.map((_, month) => absoluteTime(Date.UTC(2026, month, 15, 12), 'UTC'))).toEqual(
      fifteenth.map((date) => `${date}, 12:00`),
    );
  });

  it('handles 29 February', () => {
    expect(absoluteTime('2028-02-29T12:00:00.000Z', 'UTC')).toBe('Tue 29 Feb 2028, 12:00');
  });

  it('without a zone, uses the system zone', () => {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const row of CANVAS_ROWS) {
      expect(absoluteTime(row.addedAt)).toBe(absoluteTime(row.addedAt, system));
    }
  });

  it('accepts a Date or epoch milliseconds', () => {
    expect(absoluteTime(new Date('2026-10-20T10:41:00.000Z'), 'UTC')).toBe(
      'Tue 20 Oct 2026, 10:41',
    );
    expect(absoluteTime(Date.parse('2026-10-20T10:41:00.000Z'), 'UTC')).toBe(
      'Tue 20 Oct 2026, 10:41',
    );
  });

  it('gives "" for a time it cannot read', () => {
    expect(absoluteTime('', TZ)).toBe('');
    expect(absoluteTime('soon', TZ)).toBe('');
    expect(absoluteTime(Number.NaN, TZ)).toBe('');
  });
});

describe('fileSize', () => {
  it.each([
    [48_000_000, '48 MB'],
    [640_000_000, '640 MB'],
    [900_000_000, '900 MB'],
    [62_000_000, '62 MB'],
    [180_000_000, '180 MB'],
    [1_100_000_000, '1.1 GB'],
    [3_100_000_000, '3.1 GB'],
    [7_900_000_000, '7.9 GB'],
  ])('%d bytes is %s', (bytes, expected) => {
    expect(fileSize(bytes)).toBe(expected);
  });

  it('shows whole GB with one decimal ("2.0 GB"), never "2 GB"', () => {
    expect(fileSize(2_000_000_000)).toBe('2.0 GB');
  });

  it('uses decimal units: 1 MB is 1,000,000 bytes, not 1,048,576', () => {
    expect(fileSize(1_000_000)).toBe('1 MB');
    // A 1,024 base would call 3,100 MB "3.0 GB" and 1,100 MB "1.0 GB".
    expect(fileSize(3_100 * 1_000_000)).toBe('3.1 GB');
    expect(fileSize(1_048_576)).toBe('1 MB');
  });

  it('rounds MB to the nearest whole number', () => {
    expect(fileSize(1_499_999)).toBe('1 MB');
    expect(fileSize(1_500_000)).toBe('2 MB');
    expect(fileSize(999_499_999)).toBe('999 MB');
  });

  it('switches to GB at 1,000 MB, and never shows "1000 MB"', () => {
    expect(fileSize(999_499_999)).toBe('999 MB');
    expect(fileSize(999_500_000)).toBe('1.0 GB');
    expect(fileSize(1_000_000_000)).toBe('1.0 GB');
  });

  it('rounds GB to one decimal, halves up', () => {
    expect(fileSize(1_049_999_999)).toBe('1.0 GB');
    expect(fileSize(1_050_000_000)).toBe('1.1 GB');
    expect(fileSize(1_150_000_000)).toBe('1.2 GB');
    expect(fileSize(12_340_000_000)).toBe('12.3 GB');
  });

  it('shows anything under 1 MB as "< 1 MB", and nothing as "0 MB"', () => {
    expect(fileSize(1)).toBe('< 1 MB');
    expect(fileSize(300_000)).toBe('< 1 MB');
    expect(fileSize(999_999)).toBe('< 1 MB');
    expect(fileSize(0)).toBe('0 MB');
  });

  it('gives "0 MB" for values that are not a size', () => {
    expect(fileSize(-5)).toBe('0 MB');
    expect(fileSize(Number.NaN)).toBe('0 MB');
    expect(fileSize(Number.POSITIVE_INFINITY)).toBe('0 MB');
  });
});

describe('spanText', () => {
  it('says seconds under a minute and minutes under an hour', () => {
    expect(spanText(0)).toBe('0 s');
    expect(spanText(45)).toBe('45 s');
    expect(spanText(60)).toBe('1 min');
    expect(spanText(89)).toBe('1 min');
    expect(spanText(90)).toBe('2 min');
    expect(spanText(52 * 60)).toBe('52 min');
  });

  it('rounds the last seconds up into the next unit instead of saying 60 of anything', () => {
    expect(spanText(59.6)).toBe('1 min');
    expect(spanText(3599)).toBe('1 h');
  });

  it('says hours and minutes from an hour up, as the board does', () => {
    expect(spanText(3600)).toBe('1 h');
    expect(spanText(2 * 3600 + 40 * 60)).toBe('2 h 40 m');
    expect(spanText(1 * 3600 + 52 * 60)).toBe('1 h 52 m');
    expect(spanText(23 * 3600 + 59 * 60)).toBe('23 h 59 m');
  });

  it('says days and hours from a day up', () => {
    expect(spanText(86_400)).toBe('1 d');
    expect(spanText(86_400 + 4 * 3600)).toBe('1 d 4 h');
    expect(spanText(86_400 + 23.5 * 3600)).toBe('2 d');
  });

  it('reads a negative or broken length as zero', () => {
    expect(spanText(-5)).toBe('0 s');
    expect(spanText(Number.NaN)).toBe('0 s');
    expect(spanText(Number.POSITIVE_INFINITY)).toBe('0 s');
  });
});

describe('clock', () => {
  it.each([
    [42, '0:42'],
    [72, '1:12'],
    [45, '0:45'],
    [58, '0:58'],
    [90, '1:30'],
    [30, '0:30'],
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [600, '10:00'],
    [3599, '59:59'],
  ])('%d s is %s', (sec, expected) => {
    expect(clock(sec)).toBe(expected);
  });

  it('rounds to the nearest second', () => {
    expect(clock(45.2)).toBe('0:45');
    expect(clock(44.5)).toBe('0:45');
    expect(clock(59.6)).toBe('1:00');
    expect(clock(0.4)).toBe('0:00');
  });

  it('adds hours from one hour up', () => {
    expect(clock(3600)).toBe('1:00:00');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(36_000)).toBe('10:00:00');
  });

  it('gives "0:00" for values that are not a duration', () => {
    expect(clock(-3)).toBe('0:00');
    expect(clock(Number.NaN)).toBe('0:00');
    expect(clock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('resolution', () => {
  it('joins width and height with the multiplication sign', () => {
    expect(resolution(1080, 1920)).toBe('1080×1920');
    expect(resolution(1920, 1080)).toBe('1920×1080');
  });

  it('uses U+00D7, not the letter x', () => {
    expect(resolution(1080, 1920).codePointAt(4)).toBe(0x00d7);
    expect(resolution(1080, 1920)).not.toContain('x');
  });
});

describe('statusDetail', () => {
  const at = (iso: string) => Date.parse(iso);

  describe('arriving', () => {
    const job = makeJob({
      state: 'arriving',
      placeInLine: null,
      settlesAt: '2026-10-20T10:42:00.000Z',
    });

    it('counts down to the settle time', () => {
      expect(statusDetail(job, at('2026-10-20T10:41:18.000Z'))).toBe('settles in 0:42');
      expect(statusDetail(job, at('2026-10-20T10:40:00.000Z'))).toBe('settles in 2:00');
    });

    it('rounds a part second up, so the timer shows 0:01 until it fires', () => {
      expect(statusDetail(job, at('2026-10-20T10:41:18.400Z'))).toBe('settles in 0:42');
      expect(statusDetail(job, at('2026-10-20T10:41:59.100Z'))).toBe('settles in 0:01');
    });

    it('stops at 0:00 once the settle time has passed', () => {
      expect(statusDetail(job, at('2026-10-20T10:42:00.000Z'))).toBe('settles in 0:00');
      expect(statusDetail(job, at('2026-10-20T10:50:00.000Z'))).toBe('settles in 0:00');
    });

    it('is empty with no settle time', () => {
      expect(statusDetail({ ...job, settlesAt: null }, NOW)).toBe('');
    });

    it('takes `now` as an ISO string, Date or number', () => {
      expect(statusDetail(job, '2026-10-20T10:41:18.000Z')).toBe('settles in 0:42');
      expect(statusDetail(job, new Date('2026-10-20T10:41:18.000Z'))).toBe('settles in 0:42');
    });
  });

  it('queued shows the place in line', () => {
    expect(statusDetail(makeJob({ state: 'queued', placeInLine: 1 }), NOW)).toBe('#1 in line');
    expect(statusDetail(makeJob({ state: 'queued', placeInLine: 2 }), NOW)).toBe('#2 in line');
    expect(statusDetail(makeJob({ state: 'queued', placeInLine: 12 }), NOW)).toBe('#12 in line');
    expect(statusDetail(makeJob({ state: 'queued', placeInLine: null }), NOW)).toBe('');
  });

  it('review shows the preview length and frame size, then the round once notes were sent', () => {
    const review = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: SAMPLE_PREVIEW,
    });
    expect(statusDetail(review, NOW)).toBe('0:28 · 1080×1920');
    expect(statusDetail({ ...review, round: 0 }, NOW)).toBe('0:28 · 1080×1920');
    // Job.round counts the rounds of notes sent, so the cut made from them is one more.
    expect(statusDetail({ ...review, round: 1 }, NOW)).toBe('0:28 · 1080×1920 · round 2');
    expect(statusDetail({ ...review, round: 2 }, NOW)).toBe('0:28 · 1080×1920 · round 3');
  });

  it('review reads hours for a long preview', () => {
    const review = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: { durationSec: 3725, width: 3840, height: 2160 },
    });
    expect(statusDetail(review, NOW)).toBe('1:02:05 · 3840×2160');
  });

  it('review without a preview has no detail, even in a later round', () => {
    const review = makeJob({ state: 'review', step: 7, placeInLine: null, preview: null });
    expect(statusDetail(review, NOW)).toBe('');
    expect(statusDetail({ ...review, round: 2 }, NOW)).toBe('');
  });

  it('review ignores the output', () => {
    const review = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: SAMPLE_PREVIEW,
      output: READY(45.2, 1080, 1920, 61_900_000),
    });
    expect(statusDetail(review, NOW)).toBe('0:28 · 1080×1920');
  });

  it('a held job with a preview and a round has no detail', () => {
    const held = makeJob({
      state: 'held',
      placeInLine: null,
      preview: SAMPLE_PREVIEW,
      round: 3,
    });
    expect(statusDetail(held, NOW)).toBe('');
  });

  it('ready shows duration, frame size and file size', () => {
    const ready = makeJob({
      state: 'ready',
      placeInLine: null,
      output: READY(45.2, 1080, 1920, 61_900_000),
    });
    expect(statusDetail(ready, NOW)).toBe('0:45 · 1080×1920 · 62 MB');
    expect(statusDetail({ ...ready, output: READY(3725, 3840, 2160, 2_450_000_000) }, NOW)).toBe(
      '1:02:05 · 3840×2160 · 2.5 GB',
    );
    expect(statusDetail({ ...ready, output: null }, NOW)).toBe('');
  });

  it('uses a middle dot (U+00B7) with a space on each side', () => {
    const ready = makeJob({
      state: 'ready',
      placeInLine: null,
      output: READY(45, 1080, 1920, 62_000_000),
    });
    expect(statusDetail(ready, NOW).split('·')).toHaveLength(3);
  });

  it('failed shows the step it failed at', () => {
    expect(statusDetail(makeJob({ state: 'failed', failedAt: 8 }), NOW)).toBe('at Render');
    expect(statusDetail(makeJob({ state: 'failed', failedAt: 2 }), NOW)).toBe('at Transcribe');
    expect(statusDetail(makeJob({ state: 'failed', failedAt: null }), NOW)).toBe('');
  });

  it('cancelled shows the step it was stopped at', () => {
    expect(statusDetail(makeJob({ state: 'cancelled', stoppedAt: 4 }), NOW)).toBe('at Plan');
    expect(statusDetail(makeJob({ state: 'cancelled', stoppedAt: null }), NOW)).toBe('');
  });

  it('failed and cancelled read their own step, not the other one', () => {
    expect(statusDetail(makeJob({ state: 'failed', failedAt: 8, stoppedAt: 4 }), NOW)).toBe(
      'at Render',
    );
    expect(statusDetail(makeJob({ state: 'cancelled', failedAt: 8, stoppedAt: 4 }), NOW)).toBe(
      'at Plan',
    );
  });

  it('held and editing have no detail', () => {
    expect(statusDetail(makeJob({ state: 'held', placeInLine: null }), NOW)).toBe('');
    expect(
      statusDetail(
        makeJob({ state: 'editing', step: 5, subProgress: '2/5', placeInLine: null }),
        NOW,
      ),
    ).toBe('');
  });

  it('ignores fields that belong to other states', () => {
    const stale = makeJob({ state: 'held', placeInLine: 3, failedAt: 3, stoppedAt: 3 });
    expect(statusDetail(stale, NOW)).toBe('');
  });
});

describe('stepLabel', () => {
  it('adds the progress inside the step after a middle dot', () => {
    expect(stepLabel({ step: 5, subProgress: 'graphics 2/5' })).toBe('Cut · graphics 2/5');
    expect(stepLabel({ step: 2, subProgress: '6/14' })).toBe('Transcribe · 6/14');
    expect(stepLabel({ step: 7, subProgress: 'pass 2/3' })).toBe('Check · pass 2/3');
  });

  it('is just the step name without progress', () => {
    expect(stepLabel({ step: 8, subProgress: null })).toBe('Render');
    expect(stepLabel({ step: 8, subProgress: '' })).toBe('Render');
  });

  it('names all eight steps', () => {
    expect(
      ([1, 2, 3, 4, 5, 6, 7, 8] as const).map((step) => stepLabel({ step, subProgress: null })),
    ).toEqual(['Brief', 'Transcribe', 'Scan', 'Plan', 'Cut', 'Preview', 'Check', 'Render']);
  });

  it('is empty when the job has no step', () => {
    expect(stepLabel({ step: null, subProgress: null })).toBe('');
    expect(stepLabel({ step: null, subProgress: '2/5' })).toBe('');
  });

  it('keeps the label of a failed or cancelled job, which keep their step', () => {
    expect(stepLabel(makeJob({ state: 'failed', step: 8, failedAt: 8 }))).toBe('Render');
    expect(stepLabel(makeJob({ state: 'cancelled', step: 4, stoppedAt: 4 }))).toBe('Plan');
  });
});

describe('eta', () => {
  it('shows whole minutes with a tilde', () => {
    expect(eta(240)).toBe('~4 min left');
    expect(eta(60)).toBe('~1 min left');
    expect(eta(3600)).toBe('~60 min left');
  });

  it('rounds up, so it never promises to finish sooner than it will', () => {
    expect(eta(61)).toBe('~2 min left');
    expect(eta(241)).toBe('~5 min left');
    expect(eta(179.2)).toBe('~3 min left');
  });

  it('says "< 1 min left" under a minute, including 0 and negative', () => {
    expect(eta(59)).toBe('< 1 min left');
    expect(eta(59.9)).toBe('< 1 min left');
    expect(eta(1)).toBe('< 1 min left');
    expect(eta(0)).toBe('< 1 min left');
    expect(eta(-10)).toBe('< 1 min left');
  });

  it('is empty when there is no estimate', () => {
    expect(eta(null)).toBe('');
    expect(eta(undefined)).toBe('');
    expect(eta(Number.NaN)).toBe('');
    expect(eta(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('cutRound', () => {
  it('numbers the cut as the job sheet does: one more than the rounds of notes sent', () => {
    expect(cutRound({ round: 0 })).toBe(1);
    expect(cutRound({ round: 1 })).toBe(2);
    expect(cutRound({ round: 2 })).toBe(3);
  });
});

describe('runKindDetail', () => {
  it('is empty for an edit', () => {
    expect(runKindDetail({ runKind: 'edit', round: 0 })).toBe('');
  });

  it('names the cut a revise run makes: one more than the rounds of notes sent', () => {
    expect(runKindDetail({ runKind: 'revise', round: 1 })).toBe('round 2');
    expect(runKindDetail({ runKind: 'revise', round: 2 })).toBe('round 3');
  });

  it('says approved for the render run', () => {
    expect(runKindDetail({ runKind: 'render', round: 1 })).toBe('approved');
  });
});

describe('editingDetail', () => {
  it('is the time left alone for an edit', () => {
    expect(editingDetail({ runKind: 'edit', round: 0, etaSec: 240 })).toBe('~4 min left');
  });

  it('puts the round before the time left on a revise run', () => {
    expect(editingDetail({ runKind: 'revise', round: 1, etaSec: 240 })).toBe(
      'round 2 · ~4 min left',
    );
    expect(editingDetail({ runKind: 'revise', round: 2, etaSec: 30 })).toBe(
      'round 3 · < 1 min left',
    );
  });

  it('puts approved before the time left on the render run', () => {
    expect(editingDetail({ runKind: 'render', round: 1, etaSec: 180 })).toBe(
      'approved · ~3 min left',
    );
  });

  it('keeps the run alone when there is no estimate', () => {
    expect(editingDetail({ runKind: 'render', round: 1, etaSec: null })).toBe('approved');
    expect(editingDetail({ runKind: 'revise', round: 1, etaSec: null })).toBe('round 2');
  });

  it('is empty for an edit without an estimate', () => {
    expect(editingDetail({ runKind: 'edit', round: 0, etaSec: null })).toBe('');
  });
});

describe('listDetail', () => {
  const at = (iso: string) => Date.parse(iso);

  describe('arriving', () => {
    const job = makeJob({
      state: 'arriving',
      placeInLine: null,
      settlesAt: '2026-10-20T10:42:00.000Z',
    });

    it('says "Arriving" and counts down to the settle time', () => {
      expect(listDetail(job, at('2026-10-20T10:41:18.000Z'))).toBe('Arriving · settles in 0:42');
      expect(listDetail(job, at('2026-10-20T10:40:00.000Z'))).toBe('Arriving · settles in 2:00');
    });

    it('rounds a part second up and stops at 0:00, as the badge did', () => {
      expect(listDetail(job, at('2026-10-20T10:41:59.100Z'))).toBe('Arriving · settles in 0:01');
      expect(listDetail(job, at('2026-10-20T10:50:00.000Z'))).toBe('Arriving · settles in 0:00');
    });

    it('is just "Arriving" with no settle time', () => {
      expect(listDetail({ ...job, settlesAt: null }, NOW)).toBe('Arriving');
    });
  });

  describe('queued', () => {
    it('says the place in line', () => {
      expect(listDetail(makeJob({ state: 'queued', placeInLine: 1 }), NOW)).toBe(
        'Queued · #1 in line',
      );
      expect(listDetail(makeJob({ state: 'queued', placeInLine: 2 }), NOW)).toBe(
        'Queued · #2 in line',
      );
      expect(listDetail(makeJob({ state: 'queued', placeInLine: 12 }), NOW)).toBe(
        'Queued · #12 in line',
      );
    });

    it('is just "Queued" with no place in line', () => {
      expect(listDetail(makeJob({ state: 'queued', placeInLine: null }), NOW)).toBe('Queued');
    });
  });

  it('held is "Held", whatever else the job still carries', () => {
    expect(listDetail(makeJob({ state: 'held', placeInLine: null }), NOW)).toBe('Held');
    const stale = makeJob({
      state: 'held',
      placeInLine: 3,
      failedAt: 3,
      stoppedAt: 3,
      preview: SAMPLE_PREVIEW,
      round: 3,
    });
    expect(listDetail(stale, NOW)).toBe('Held');
  });

  describe('editing', () => {
    const editing = (overrides: Partial<Job>) =>
      makeJob({ state: 'editing', placeInLine: null, ...overrides });

    it('is the step with its count, then the time left', () => {
      const job = editing({ step: 5, subProgress: 'graphics 2/5', etaSec: 240 });
      expect(listDetail(job, NOW)).toBe('Cut · graphics 2/5 · ~4 min left');
    });

    it('puts the round of a revise run between the step and the time left', () => {
      const job = editing({ step: 4, runKind: 'revise', round: 1, etaSec: 240 });
      expect(listDetail(job, NOW)).toBe('Plan · round 2 · ~4 min left');
    });

    it('puts "approved" between the render step and the time left', () => {
      const job = editing({ step: 8, runKind: 'render', round: 1, etaSec: 180 });
      expect(listDetail(job, NOW)).toBe('Render · approved · ~3 min left');
    });

    it('skips what is empty: no count, no estimate, a plain edit', () => {
      expect(listDetail(editing({ step: 5, subProgress: 'graphics 2/5' }), NOW)).toBe(
        'Cut · graphics 2/5',
      );
      expect(listDetail(editing({ step: 2, etaSec: 90 }), NOW)).toBe('Transcribe · ~2 min left');
      expect(listDetail(editing({ step: 8, runKind: 'render', round: 1 }), NOW)).toBe(
        'Render · approved',
      );
      expect(listDetail(editing({ step: 1 }), NOW)).toBe('Brief');
    });

    it('is just "Editing" with no step', () => {
      expect(listDetail(editing({ step: null }), NOW)).toBe('Editing');
      expect(listDetail(editing({ step: null, subProgress: '2/5', etaSec: 240 }), NOW)).toBe(
        'Editing',
      );
    });
  });

  describe('review', () => {
    const review = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: { durationSec: 44, width: 1080, height: 1920 },
    });

    it('says the length of the preview, and no frame size', () => {
      expect(listDetail(review, NOW)).toBe('Ready to review · 0:44');
      expect(listDetail({ ...review, preview: SAMPLE_PREVIEW }, NOW)).toBe(
        'Ready to review · 0:28',
      );
      expect(listDetail(review, NOW)).not.toContain('1080');
    });

    it("adds the cut's round once notes were sent (one more than the rounds of notes)", () => {
      expect(listDetail({ ...review, round: 0 }, NOW)).toBe('Ready to review · 0:44');
      expect(listDetail({ ...review, round: 1 }, NOW)).toBe('Ready to review · 0:44 · round 2');
      expect(listDetail({ ...review, round: 2 }, NOW)).toBe('Ready to review · 0:44 · round 3');
    });

    it('reads hours for a long preview', () => {
      const long = { ...review, preview: { durationSec: 3725, width: 3840, height: 2160 } };
      expect(listDetail(long, NOW)).toBe('Ready to review · 1:02:05');
    });

    it('is just "Ready to review" with no preview, even in a later round', () => {
      expect(listDetail({ ...review, preview: null }, NOW)).toBe('Ready to review');
      expect(listDetail({ ...review, preview: null, round: 2 }, NOW)).toBe('Ready to review');
    });

    it('ignores the output', () => {
      expect(listDetail({ ...review, output: READY(45.2, 1080, 1920, 61_900_000) }, NOW)).toBe(
        'Ready to review · 0:44',
      );
    });

    describe('with quick fixes', () => {
      it('says a note is being fixed, with its time rounded down as Review labels it', () => {
        expect(listDetail({ ...review, fixing: { atSec: 12 } }, NOW)).toBe(
          'Review · fixing a note at 0:12…',
        );
        expect(listDetail({ ...review, fixing: { atSec: 12.9 } }, NOW)).toBe(
          'Review · fixing a note at 0:12…',
        );
        expect(listDetail({ ...review, fixing: { atSec: 0 } }, NOW)).toBe(
          'Review · fixing a note at 0:00…',
        );
        expect(listDetail({ ...review, fixing: { atSec: 3725 } }, NOW)).toBe(
          'Review · fixing a note at 1:02:05…',
        );
      });

      it('says how many notes were fixed here, with the cut they are in', () => {
        expect(listDetail({ ...review, round: 1, fixedCount: 1 }, NOW)).toBe(
          'Review · cut 2 · 1 fixed here',
        );
        expect(listDetail({ ...review, round: 2, fixedCount: 3 }, NOW)).toBe(
          'Review · cut 3 · 3 fixed here',
        );
      });

      it('numbers the first cut too, as cut 1', () => {
        expect(listDetail({ ...review, round: 0, fixedCount: 2 }, NOW)).toBe(
          'Review · cut 1 · 2 fixed here',
        );
      });

      it('says the fix under way before the ones already fixed', () => {
        expect(listDetail({ ...review, round: 1, fixing: { atSec: 7 }, fixedCount: 2 }, NOW)).toBe(
          'Review · fixing a note at 0:07…',
        );
      });

      it('leaves the usual line when no fix is running and none was fixed', () => {
        expect(listDetail({ ...review, round: 1, fixing: null, fixedCount: 0 }, NOW)).toBe(
          'Ready to review · 0:44 · round 2',
        );
      });

      it('says them without a preview too', () => {
        expect(listDetail({ ...review, preview: null, fixing: { atSec: 12 } }, NOW)).toBe(
          'Review · fixing a note at 0:12…',
        );
        expect(listDetail({ ...review, preview: null, round: 1, fixedCount: 1 }, NOW)).toBe(
          'Review · cut 2 · 1 fixed here',
        );
      });

      it('is only for a job in Review', () => {
        const editing = makeJob({
          state: 'editing',
          step: 4,
          placeInLine: null,
          fixing: { atSec: 12 },
          fixedCount: 2,
        });
        expect(listDetail(editing, NOW)).not.toContain('fixing');
        expect(listDetail(editing, NOW)).not.toContain('fixed here');
      });
    });
  });

  describe('ready', () => {
    const ready = makeJob({
      state: 'ready',
      placeInLine: null,
      output: READY(30, 1080, 1920, 27_000_000),
    });

    it('is the length and the file size of the export, with no frame size', () => {
      expect(listDetail(ready, NOW)).toBe('0:30 · 27 MB');
      expect(listDetail({ ...ready, output: READY(45.2, 1080, 1920, 61_900_000) }, NOW)).toBe(
        '0:45 · 62 MB',
      );
    });

    it('reads hours and gigabytes for a long export', () => {
      expect(listDetail({ ...ready, output: READY(3725, 3840, 2160, 2_450_000_000) }, NOW)).toBe(
        '1:02:05 · 2.5 GB',
      );
    });

    it('is just "Approved" with no export record', () => {
      expect(listDetail({ ...ready, output: null }, NOW)).toBe('Approved');
    });

    it('does not say the preview length or the round', () => {
      expect(listDetail({ ...ready, preview: SAMPLE_PREVIEW, round: 2 }, NOW)).toBe('0:30 · 27 MB');
    });
  });

  it('failed says the step it failed at', () => {
    expect(listDetail(makeJob({ state: 'failed', failedAt: 8 }), NOW)).toBe('Failed at Render');
    expect(listDetail(makeJob({ state: 'failed', failedAt: 2 }), NOW)).toBe('Failed at Transcribe');
  });

  it('failed is just "Failed" with no step', () => {
    expect(listDetail(makeJob({ state: 'failed', failedAt: null }), NOW)).toBe('Failed');
  });

  it('cancelled says the step it was stopped at', () => {
    expect(listDetail(makeJob({ state: 'cancelled', stoppedAt: 4 }), NOW)).toBe(
      'Cancelled at Plan',
    );
  });

  it('cancelled is just "Cancelled" with no step', () => {
    expect(listDetail(makeJob({ state: 'cancelled', stoppedAt: null }), NOW)).toBe('Cancelled');
  });

  it('failed and cancelled read their own step, not the other one', () => {
    expect(listDetail(makeJob({ state: 'failed', failedAt: 8, stoppedAt: 4 }), NOW)).toBe(
      'Failed at Render',
    );
    expect(listDetail(makeJob({ state: 'cancelled', failedAt: 8, stoppedAt: 4 }), NOW)).toBe(
      'Cancelled at Plan',
    );
  });

  it('uses a middle dot (U+00B7) with a space on each side, and never the multiplication sign', () => {
    const ready = makeJob({
      state: 'ready',
      placeInLine: null,
      output: READY(45, 1080, 1920, 62_000_000),
    });
    expect(listDetail(ready, NOW).split(' · ')).toHaveLength(2);
    const states = [
      makeJob({ state: 'queued', placeInLine: 1 }),
      makeJob({ state: 'review', step: 7, preview: SAMPLE_PREVIEW, round: 1 }),
      makeJob({ state: 'editing', step: 5, subProgress: '2/5', etaSec: 60 }),
      ready,
    ];
    for (const job of states) expect(listDetail(job, NOW), job.state).not.toContain('×');
  });

  it('takes `now` as an ISO string, Date or number', () => {
    const job = makeJob({
      state: 'arriving',
      placeInLine: null,
      settlesAt: '2026-10-20T10:42:00.000Z',
    });
    expect(listDetail(job, '2026-10-20T10:41:18.000Z')).toBe('Arriving · settles in 0:42');
    expect(listDetail(job, new Date('2026-10-20T10:41:18.000Z'))).toBe(
      'Arriving · settles in 0:42',
    );
  });

  it('gives every state some text, never an empty string', () => {
    for (const state of JOB_STATES) {
      expect(listDetail(makeJob({ state, placeInLine: null }), NOW), state).not.toBe('');
    }
  });
});

describe('inputTooltip', () => {
  it.each([
    ['video', 14, '14 video clips'],
    ['video', 1, '1 video clip'],
    ['video', 0, '0 video clips'],
    ['audio', 1, '1 audio file'],
    ['audio', 3, '3 audio files'],
    ['audio', 0, '0 audio files'],
    ['image', 1, '1 image'],
    ['image', 0, '0 images'],
    ['image', 5, '5 images'],
    ['doc', 1, '1 document'],
    ['doc', 0, '0 documents'],
    ['doc', 2, '2 documents'],
  ] as const)('%s × %d is "%s"', (type, n, expected) => {
    expect(inputTooltip(type, n)).toBe(expected);
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Arc Fitness')).toBe('AF');
    expect(initials('Kova Coffee')).toBe('KC');
  });

  it('works for Hebrew', () => {
    expect(initials('מאפיית הצפון')).toBe('מה');
    expect(initials('מרפאת מירה')).toBe('ממ');
    expect(initials('טל נכסים')).toBe('טנ');
  });

  it('upper-cases Latin letters', () => {
    expect(initials('arc fitness')).toBe('AF');
    expect(initials('éclair shop')).toBe('ÉS');
  });

  it('uses only the first two words', () => {
    expect(initials('Arc Fitness Club')).toBe('AF');
    expect(initials('The Hebrew Language Academy')).toBe('TH');
  });

  it('gives one letter for a one-word name', () => {
    expect(initials('Kova')).toBe('K');
    expect(initials('kova')).toBe('K');
    expect(initials('מאפייה')).toBe('מ');
  });

  it('ignores extra and unusual whitespace', () => {
    expect(initials('  Arc   Fitness  ')).toBe('AF');
    expect(initials('Arc\tFitness')).toBe('AF');
    expect(initials('Arc Fitness')).toBe('AF');
  });

  it('mixes scripts', () => {
    expect(initials('Arc מאפיית')).toBe('Aמ');
    expect(initials('מאפיית Arc')).toBe('מA');
  });

  it('counts digits', () => {
    expect(initials('3D Studio')).toBe('3S');
  });

  it('skips leading punctuation and words that are only punctuation', () => {
    expect(initials('Fish & Chips')).toBe('FC');
    expect(initials('(Test) Client')).toBe('TC');
    expect(initials('"Kova" Coffee')).toBe('KC');
    expect(initials('- Arc Fitness')).toBe('AF');
  });

  it('keeps an emoji whole', () => {
    expect(initials('🍞 Bakery')).toBe('🍞B');
    expect(initials('Bakery 🍞')).toBe('B🍞');
    expect(initials('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧F');
    expect(initials('🇮🇱 Israel')).toBe('🇮🇱I');
  });

  it('keeps a letter together with its combining marks', () => {
    expect(initials('Éclair Shop')).toBe('ÉS');
    expect(initials('מָאפיית הצפון')).toBe('מָה');
  });

  it('is empty when there is nothing to take', () => {
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
    expect(initials('& - ()')).toBe('');
  });
});

describe('clientHue', () => {
  it('is the same for the same client, whatever the case or spacing', () => {
    expect(clientHue('Arc Fitness')).toBe(clientHue(' arc fitness '));
  });

  it('is a whole hue from 0 to 359 and tells different clients apart', () => {
    const hues = ['Arc Fitness', 'מאפיית הצפון', 'Dror', 'Fish & Chips'].map(clientHue);
    for (const hue of hues) {
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(new Set(hues).size).toBe(hues.length);
  });
});
