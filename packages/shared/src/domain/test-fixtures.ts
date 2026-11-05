import type { ClientStyle } from './client.ts';
import type {
  FontFaceInfo,
  FontFamilyDetail,
  FontFamilySummary,
  FontRequest,
  FontStageItem,
} from './fonts.ts';
import type { GenerateState } from './generate.ts';
import type { GraphicDetail, GraphicMessage, GraphicSummary } from './graphics.ts';
import type { Job, JobPreview } from './job.ts';
import type { LutDetail, LutSummary } from './luts.ts';
import type {
  MusicPlan,
  MusicRecord,
  MusicVersion,
  MusicView,
  Song,
  SongFailure,
} from './music.ts';
import type { OrphanDelivery } from './orphan-delivery.ts';
import type { NoteRoute, QuickFix } from './quick-fixes.ts';
import type { ReviewNote } from './review-note.ts';
import type { Series, SeriesSummary } from './series.ts';

/** A valid `queued` job. Tests start from this and override what they care about. */
export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'a1b2c3d4e5f6',
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    name: 'Spring menu',
    relPath: 'Northwind Bakery/Spring menu',
    state: 'queued',
    step: null,
    subProgress: null,
    etaSec: null,
    placeInLine: 2,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 14, audio: 1, image: 0, doc: 1 },
    sizeBytes: 1_181_116_006,
    addedAt: '2026-10-20T11:02:10.000Z',
    lastChangeAt: '2026-10-20T13:40:00.000Z',
    settledAt: '2026-10-20T13:41:00.000Z',
    heldSettledAt: null,
    updatedAt: '2026-10-20T13:41:00.000Z',
    output: null,
    note: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    ...overrides,
  };
}

/**
 * A delivered, unpaid video whose folder was deleted ("Folder deleted · Delivered 21 Oct · ₪40 not
 * paid"). Override what a test cares about; `delivery` is replaced as a whole.
 */
export function makeOrphanDelivery(overrides: Partial<OrphanDelivery> = {}): OrphanDelivery {
  return {
    id: 'ba039bc47665',
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    name: 'History check',
    relPath: 'Northwind Bakery/History check',
    delivery: {
      deliveredAt: '2026-10-21T09:00:00.000Z',
      price: 40,
      currency: 'ILS',
      paidOn: null,
    },
    ...overrides,
  };
}

/** A preview as W2 reads it from a composition: 28.4 s, vertical Full HD. */
export const SAMPLE_PREVIEW: JobPreview = { durationSec: 28.4, width: 1080, height: 1920 };

/** One valid job per state, each filled the way the server fills it for that state. */
export const jobsByState = {
  arriving: makeJob({
    state: 'arriving',
    placeInLine: null,
    settlesAt: '2026-10-20T13:42:00.000Z',
    lastChangeAt: '2026-10-20T13:41:00.000Z',
    settledAt: null,
  }),
  queued: makeJob(),
  held: makeJob({ state: 'held', placeInLine: null, settledAt: null }),
  editing: makeJob({
    state: 'editing',
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
    placeInLine: null,
  }),
  review: makeJob({
    state: 'review',
    step: 7,
    placeInLine: null,
    preview: SAMPLE_PREVIEW,
  }),
  ready: makeJob({
    state: 'ready',
    step: 8,
    placeInLine: null,
    output: {
      fileName: 'Northwind Bakery/Spring menu.mp4',
      durationSec: 45.2,
      width: 1080,
      height: 1920,
      sizeBytes: 65_011_712,
    },
  }),
  failed: makeJob({
    state: 'failed',
    step: 8,
    placeInLine: null,
    failedAt: 8,
    error: 'ffmpeg exited with code 1: no space left on device',
  }),
  cancelled: makeJob({ state: 'cancelled', step: 4, placeInLine: null, stoppedAt: 4 }),
} satisfies Record<Job['state'], Job>;

/** Hebrew and mixed-direction names must pass through untouched. */
export const hebrewJob = makeJob({
  id: '0f9e8d7c6b5a',
  clientId: '4d337086919d',
  client: 'מאפיית הצפון',
  name: 'סרטון גיוס – Hiring video',
  relPath: 'מאפיית הצפון/סרטון גיוס – Hiring video',
});

/** A valid `ready` client style (version 2, learned from a job). Override what a test cares about. */
export function makeClientStyle(overrides: Partial<ClientStyle> = {}): ClientStyle {
  return {
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    state: 'ready',
    version: 2,
    updatedAt: '2026-10-20T14:05:00.000Z',
    error: null,
    sourceJobId: 'a1b2c3d4e5f6',
    ...overrides,
  };
}

/** A valid unsent text note. Override what a test cares about. */
export function makeReviewNote(overrides: Partial<ReviewNote> = {}): ReviewNote {
  return {
    id: 'n1',
    jobId: 'a1b2c3d4e5f6',
    round: null,
    atSec: 2.4,
    kind: 'text',
    text: 'The title goes too fast.',
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: false,
    addToSeries: false,
    createdAt: '2026-10-20T14:00:00.000Z',
    sentAt: null,
    routeStatus: null,
    route: null,
    format: null,
    fixId: null,
    fixedAt: null,
    ...overrides,
  };
}

// --- quick fixes -------------------------------------------------------------------------------

/** A quick note's route: the caption font. Override what a test cares about. */
export function makeNoteRoute(overrides: Partial<NoteRoute> = {}): NoteRoute {
  return { tier: 'quick', kind: 'Changing the caption font', why: '', ...overrides };
}

/** A fix of {@link makeReviewNote}'s note that is done: 48 s, Sonnet at Medium. Override what a test cares about. */
export function makeQuickFix(overrides: Partial<QuickFix> = {}): QuickFix {
  return {
    id: 'f1',
    jobId: 'a1b2c3d4e5f6',
    noteId: 'n1',
    round: 1,
    status: 'fixed',
    step: null,
    stepLabel: null,
    said: 'The captions are Heebo Bold now.',
    why: null,
    model: 'sonnet',
    effort: 'medium',
    startedAt: '2026-10-25T09:00:00.000Z',
    endedAt: '2026-10-25T09:00:48.000Z',
    durationSec: 48,
    hasCompare: true,
    ...overrides,
  };
}

// --- series (the real case of the Series plan: two shows of one lawyer) -------------------------

/** The client of the series fixtures, and its id (`clientIdFor`). */
export const SERIES_CLIENT = { clientId: '4b16f268bd46', client: 'עו״ד דוד לוי' } as const;

/** The series fixtures' series: "מיתוס או אמת", id `seriesIdFor(clientId, name)`. */
export const SERIES_NAME = 'מיתוס או אמת';
export const SERIES_ID = '622212180eef';

/**
 * The format job: episode 5, ready and approved, the job "מיתוס או אמת" was started from. It is
 * in the series too.
 */
export const formatJob = makeJob({
  ...SERIES_CLIENT,
  id: '947ef344672b',
  name: 'מיתוס או אמת 5',
  relPath: 'עו״ד דוד לוי/מיתוס או אמת 5',
  state: 'ready',
  step: 8,
  placeInLine: null,
  output: {
    fileName: 'עו״ד דוד לוי/מיתוס או אמת 5.mp4',
    durationSec: 52.4,
    width: 1080,
    height: 1920,
    sizeBytes: 48_234_496,
  },
  approvedAt: '2026-10-21T09:30:00.000Z',
  seriesId: SERIES_ID,
  episode: 5,
});

/** An episode: "מיתוס או אמת 6", queued, joined by its name. */
export const episodeJob = makeJob({
  ...SERIES_CLIENT,
  id: '6554b401d32d',
  name: 'מיתוס או אמת 6',
  relPath: 'עו״ד דוד לוי/מיתוס או אמת 6',
  seriesId: SERIES_ID,
  episode: 6,
});

/** A valid `ready` series (version 1, its format from {@link formatJob}). Override what a test cares about. */
export function makeSeries(overrides: Partial<Series> = {}): Series {
  return {
    id: SERIES_ID,
    ...SERIES_CLIENT,
    name: SERIES_NAME,
    state: 'ready',
    error: null,
    version: 1,
    formatJobId: formatJob.id,
    formatJob: formatJob.name,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:04:00.000Z',
    pass: null,
    ...overrides,
  };
}

/** One valid series per state, each filled the way the server fills it for that state. */
export const seriesByState = {
  learning: makeSeries({
    state: 'learning',
    version: 0,
    updatedAt: '2026-10-21T10:00:00.000Z',
    pass: { kind: 'series', mode: 'start', fileCount: 0, jobId: formatJob.id, job: formatJob.name },
  }),
  ready: makeSeries(),
  failed: makeSeries({
    state: 'failed',
    version: 0,
    error: 'Series stopped: series.md.new was not written.',
  }),
} satisfies Record<Series['state'], Series>;

/** The client page's line for {@link makeSeries}: two episodes (5 and 6). Override what a test cares about. */
export function makeSeriesSummary(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  const { id, name, state, error, formatJobId, formatJob: job, version, updatedAt } = makeSeries();
  return {
    id,
    name,
    state,
    error,
    formatJobId,
    formatJob: job,
    version,
    updatedAt,
    episodeCount: 2,
    lastEpisodeAt: episodeJob.addedAt,
    ...overrides,
  };
}

// --- graphics (the Graphics plan: "Name on a white pill", a lower third at v2) ------------------

/** The graphic fixtures' graphic id (12 hex). */
export const GRAPHIC_ID = '3f9a1c2b7d4e';

/** A ready lower third at v2. Override what a test cares about. */
export function makeGraphicSummary(overrides: Partial<GraphicSummary> = {}): GraphicSummary {
  return {
    id: GRAPHIC_ID,
    name: 'Name on a white pill',
    kind: 'lower-third',
    lengthSec: 3,
    version: 2,
    uses: true,
    status: 'ready',
    makingVersion: null,
    failedVersion: null,
    updatedAt: '2026-10-22T10:04:00.000Z',
    ...overrides,
  };
}

/** Claude's row that made v1. Override what a test cares about. */
export function makeGraphicMessage(overrides: Partial<GraphicMessage> = {}): GraphicMessage {
  return {
    id: 'm-claude-1',
    role: 'claude',
    text: 'Made v1. A white pill with the name in Heebo Bold.',
    refs: [],
    effort: null,
    version: 1,
    status: 'done',
    step: null,
    error: null,
    startedAt: '2026-10-22T10:00:01.000Z',
    endedAt: '2026-10-22T10:02:00.000Z',
    createdAt: '2026-10-22T10:00:01.000Z',
    ...overrides,
  };
}

/** The owner's first message. */
export function makeYourGraphicMessage(overrides: Partial<GraphicMessage> = {}): GraphicMessage {
  return makeGraphicMessage({
    id: 'm-you-1',
    role: 'you',
    text: 'A lower third: the name on a white pill, sliding in from the left.',
    refs: ['pill.png'],
    effort: 'xhigh',
    version: null,
    status: null,
    startedAt: null,
    endedAt: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  });
}

/** {@link makeGraphicSummary} with its page's fields: two versions, two text fields. */
export function makeGraphicDetail(overrides: Partial<GraphicDetail> = {}): GraphicDetail {
  return {
    ...makeGraphicSummary(),
    when: 'The first time a person is named on camera.',
    whenEdited: false,
    variables: [
      { id: 'name', label: 'Name', default: 'דנה לוי' },
      { id: 'role', label: 'Role', default: 'Founder' },
    ],
    usedIn: null,
    folder: 'Name on a white pill',
    createdAt: '2026-10-22T10:00:00.000Z',
    messages: [
      makeYourGraphicMessage(),
      makeGraphicMessage(),
      makeYourGraphicMessage({
        id: 'm-you-2',
        text: 'Make the slide-in a bit slower.',
        refs: [],
        createdAt: '2026-10-22T10:03:00.000Z',
      }),
      makeGraphicMessage({
        id: 'm-claude-2',
        text: 'Made v2. The pill slides in over 0.6 s now.',
        version: 2,
        startedAt: '2026-10-22T10:03:00.000Z',
        endedAt: '2026-10-22T10:04:00.000Z',
        createdAt: '2026-10-22T10:03:00.000Z',
      }),
    ],
    ...overrides,
  };
}

// --- Soundtrack -----------------------------------------------------------------------------------

/** The plan page's example: Horizon FPV / Demo, 39 s, a big drop at 0:18 on a 120 BPM grid. */
export function makeMusicPlan(overrides: Partial<MusicPlan> = {}): MusicPlan {
  return {
    lengthMs: 39_000,
    styles: ['intense cinematic electronic', '120 BPM', 'big drop', 'instrumental'],
    avoid: ['vocals', 'singing', 'lyrics'],
    sections: [
      { name: 'Build', ms: 10_000, styles: ['sparse pulse', 'rising'], avoid: [] },
      { name: 'Rise', ms: 8_000, styles: ['risers', 'snare roll'], avoid: [] },
      { name: 'Drop', ms: 6_000, styles: ['full drop', 'sub bass'], avoid: [] },
      { name: 'Golden', ms: 10_000, styles: ['wide pads', 'steady beat'], avoid: [] },
      { name: 'Logo', ms: 5_000, styles: ['hit', 'tail'], avoid: [] },
    ],
    describe:
      'Intense cinematic electronic, 120 BPM. Builds to a big drop at 0:18 and lands on the logo at 0:35.',
    ...overrides,
  };
}

/** Version `n` of the example, made by the edit run. */
export function makeMusicVersion(n = 1, overrides: Partial<MusicVersion> = {}): MusicVersion {
  return {
    id: `v${n}`,
    file: `v${n}.mp3`,
    describe: makeMusicPlan().describe,
    ask: null,
    seed: 4710 + n,
    model: 'music_v2_5',
    lengthMs: 39_000,
    by: 'edit',
    madeAt: `2026-10-23T09:0${Math.min(n, 9)}:00.000Z`,
    ...overrides,
  };
}

/** A made record: v1 by the edit run, picked. Tests override what they care about. */
export function makeMusicRecord(overrides: Partial<MusicRecord> = {}): MusicRecord {
  return {
    v: 1,
    source: 'made',
    reason: null,
    file: null,
    plan: makeMusicPlan(),
    picked: 'v1',
    versions: [makeMusicVersion(1)],
    picks: [{ id: 'v1', at: '2026-10-23T09:01:00.000Z' }],
    making: null,
    failure: null,
    song: null,
    songFailure: null,
    ...overrides,
  };
}

/**
 * The song of the Songs boards: נתתי לך בית by Ofek Adanek, from Yael's screenshot, the studio track
 * from YouTube Music (3:12), the part with its drop 0:42 to 1:21. Override what a test cares about.
 */
export function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    title: 'נתתי לך בית',
    artist: 'Ofek Adanek',
    version: null,
    asked: { from: 'screenshot', file: 'IMG_4412.PNG', url: null, by: 'brief' },
    source: {
      site: 'youtube-music',
      via: 'yt-dlp',
      url: 'https://music.youtube.com/watch?v=Zq3Rk1pXo9A',
      id: 'Zq3Rk1pXo9A',
    },
    fullMs: 192_000,
    part: { startMs: 42_000, endMs: 81_000, how: 'measured' },
    trending: null,
    file: 'song.mp3',
    instagramLine:
      'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42.',
    gotAt: '2026-10-25T21:03:00.000Z',
    ...overrides,
  };
}

/** The record of a video whose music is the song: source and pick `song`. */
export function makeSongRecord(overrides: Partial<MusicRecord> = {}): MusicRecord {
  return makeMusicRecord({
    source: 'song',
    plan: null,
    picked: 'song',
    versions: [],
    picks: [{ id: 'song', at: '2026-10-25T21:03:00.000Z' }],
    song: makeSong(),
    ...overrides,
  });
}

/** A song that could not be got: the reel link's downloader did not answer. */
export function makeSongFailure(overrides: Partial<SongFailure> = {}): SongFailure {
  return {
    asked: 'https://www.instagram.com/reel/DQx7mK2kF9a/',
    code: 'unavailable',
    message: 'The downloader didn’t answer, so ElevenLabs made the music instead.',
    at: '2026-10-25T21:03:00.000Z',
    ...overrides,
  };
}

/** The API's answer for a made record. */
export function makeMusicView(overrides: Partial<MusicView> = {}): MusicView {
  return {
    ...makeMusicRecord(),
    canMake: true,
    whyNot: null,
    rev: 1_792_700_000_000,
    ...overrides,
  };
}

// --- Generated videos -------------------------------------------------------------------------------

/** A generated job making its clips: the voice, looks and keyframes done, 4 of 6 clips, $1.65 of $3. */
export function makeGenerateState(overrides: Partial<GenerateState> = {}): GenerateState {
  return {
    phase: 'clips',
    counts: {
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 7, total: 7 },
      clips: { done: 4, total: 6 },
      belowBar: 0,
    },
    spendUsd: 1.65,
    budgetUsd: 3,
    ...overrides,
  };
}

// --- LUTs -----------------------------------------------------------------------------------------

/** A LUT of Yours, a look at 33 points that three jobs used. Override what a test cares about. */
export function makeLutSummary(overrides: Partial<LutSummary> = {}): LutSummary {
  return {
    slug: 'golden-hour-warm',
    name: 'Golden Hour Warm',
    kind: 'look',
    size: 33,
    owner: 'yours',
    used: 3,
    usedLabel: '3 jobs',
    addedAt: '2026-10-22T10:00:00.000Z',
    isNew: false,
    ...overrides,
  };
}

/** A built-in LUT: no added time, never new. */
export function makeBuiltInLutSummary(overrides: Partial<LutSummary> = {}): LutSummary {
  return makeLutSummary({
    slug: 'film-contrast',
    name: 'Film contrast',
    owner: 'builtIn',
    used: 0,
    usedLabel: 'Used by the cinematic look',
    addedAt: null,
    ...overrides,
  });
}

/** {@link makeLutSummary} with its pane's fields. */
export function makeLutDetail(overrides: Partial<LutDetail> = {}): LutDetail {
  return {
    ...makeLutSummary(),
    description: 'Gold-amber highlights over slightly cool shadows.',
    note: null,
    file: 'Golden Hour Warm.cube',
    sizeLabel: '33 × 33 × 33',
    bytes: 1_468_006,
    usedIn: null,
    ...overrides,
  };
}

// --- Fonts ----------------------------------------------------------------------------------------

/** Heebo Bold, a face of the Hebrew + English family Heebo. Override what a test cares about. */
export function makeFontFace(overrides: Partial<FontFaceInfo> = {}): FontFaceInfo {
  return {
    name: 'Heebo Bold',
    family: 'Heebo',
    weight: 700,
    italic: false,
    fileId: '3f9a1c7e5b20',
    bytes: 46_000,
    format: 'ttf',
    version: '1761350400000',
    ...overrides,
  };
}

/** Heebo: Hebrew + English, Sans, all nine weights, used by 14 jobs. */
export function makeFontFamilySummary(
  overrides: Partial<FontFamilySummary> = {},
): FontFamilySummary {
  return {
    slug: 'heebo',
    name: 'Heebo',
    he: true,
    style: 'Sans',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    weightsLabel: '9 weights',
    used: 14,
    usedLabel: '14 jobs',
    addedAt: '2026-10-22T10:07:00.000Z',
    isNew: false,
    ...overrides,
  };
}

/** {@link makeFontFamilySummary} with its pane's fields: one Bold face of one file. */
export function makeFontFamilyDetail(overrides: Partial<FontFamilyDetail> = {}): FontFamilyDetail {
  return {
    ...makeFontFamilySummary(),
    faces: [makeFontFace()],
    files: 9,
    bytes: 420_000,
    usedIn: 14,
    ...overrides,
  };
}

/** A note of the job "Horizon FPV" asked for Gotham Bold, which the library does not have. */
export function makeFontRequest(overrides: Partial<FontRequest> = {}): FontRequest {
  return {
    id: 'a3c19e0b7d44',
    name: 'Gotham Bold',
    jobId: 'a1b2c3d4e5f6',
    jobName: 'Horizon FPV',
    round: 1,
    at: '2026-10-24T09:30:00.000Z',
    ...overrides,
  };
}

/** A new family in an import, three files of Hebrew + English. */
export function makeFontStageItem(overrides: Partial<FontStageItem> = {}): FontStageItem {
  return {
    id: 'karantina',
    name: 'Karantina',
    files: 3,
    he: true,
    weights: [300, 400, 700],
    bytes: 210_000,
    status: 'new',
    info: '3 files · Hebrew + English · 0.2 MB',
    ...overrides,
  };
}
