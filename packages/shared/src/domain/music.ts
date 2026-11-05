import { z } from 'zod';
import { clock } from '../format.ts';
import { isoTimestampSchema } from './job.ts';

// Soundtrack (Plane page "Soundtrack — architecture & dev plan"): a video whose job folder has no
// music file gets music made for it by ElevenLabs, written from the brief and fitted to the cut.
// Review lists the versions (v1, v2 …) and No music, makes another one with the same shape, and
// Approve renders the MP4 with the one picked.
//
// This file is the contract the music script, the engine and the page share: the files, the
// limits, the wire shapes (zod) and the small rules all three need. SD0 owns it; later items only
// extend it, and say so in their hand-off. The music script (apps/server/assets/music/
// make-music.mjs) is plain Node and cannot import this, so it writes what these schemas read; its
// tests check every file it writes against them.
//
// On disk, per job (paths relative to the job's edit/ folder, `MUSIC_FILES`):
//
//   music/plan.json      the edit run's plan (MusicPlan)
//   music/v1.mp3 …       the versions, loudness-normalised, never changed once made
//   music/music.json     the record (MusicRecord); written only by the music script
//   preview/music.mp3    what the composition plays: a copy of the pick, or silence of the same
//                        length for No music
//
// No music.json means a job from before Soundtrack, or one edited while the switch was off: no
// Music row and no Music button.
//
// Songs (Plane page "Songs — architecture & dev plan", SG0) extends this contract and nothing else
// of Soundtrack: the song Yael asks for (a reel's screenshot, a link, a name, or "a trending
// song") gets into the edit. The record gains `song` (what was got) and `songFailure` (why it
// could not be), the source and the pick gain `song`, the music script gains a `song` command
// (SG3) and `music/` gains three files (`MUSIC_FILES.songFull`, `.songReel`, `.song`). All of it
// sits behind the `songs` switch (on by default since U22, effective only with `music` on); a record without
// the new keys reads exactly as before, with both `null`. The pieces of Songs that are not about
// the record (the note's attachments, the trending cache, the second export, the events) are in
// songs.ts.

// --- files ---------------------------------------------------------------------------------------

/** The music files, relative to a job's edit/ folder. */
export const MUSIC_FILES = {
  /** The folder the music script owns. */
  dir: 'music',
  /** The edit run's plan. */
  plan: 'music/plan.json',
  /** The record. */
  record: 'music/music.json',
  /** Held while the script works, so one job never has two calls at once. */
  lock: 'music/.lock',
  /** What the composition plays. */
  preview: 'preview/music.mp3',
  /** Songs: the whole song as it was downloaded (m4a), kept so a new part needs no new download. */
  songFull: 'music/song-full.m4a',
  /** Songs: a reel's own audio, kept when the getter has it (for the exact part, SG16). */
  songReel: 'music/song-reel.m4a',
  /** Songs: the part of the song the video uses, loudness-normalised like every version. */
  song: 'music/song.mp3',
} as const;

/** A version's file inside `music/`: "v2.mp3". */
export function musicVersionFile(id: MusicVersionId): string {
  return `${id}.mp3`;
}

// --- limits --------------------------------------------------------------------------------------

export const MUSIC_LIMITS = {
  /** One section of a plan, in ms (3–120 s). */
  sectionMinMs: 3_000,
  sectionMaxMs: 120_000,
  /** The whole track, in ms: what ElevenLabs makes (3 s–10 min). */
  lengthMinMs: 3_000,
  lengthMaxMs: 600_000,
  /** A plan's `describe`, the one line Review and the sheet show, in characters. */
  describeMax: 160,
  /**
   * A version's `describe`, in characters: the plan's line, or "You asked: <words>. Same shape:
   * <the plan's line>" for one made with words, so it has room for both.
   */
  versionDescribeMax: 400,
  /** The words of Make another ("darker, more drums"), in characters. */
  askMax: 200,
} as const;

// --- ids -----------------------------------------------------------------------------------------

const VERSION_ID = /^v[1-9]\d*$/;

/** A version: "v1", "v2" … */
export const musicVersionIdSchema = z.string().regex(VERSION_ID, 'must be v1, v2 …');
export type MusicVersionId = z.infer<typeof musicVersionIdSchema>;

/** Whether `id` names a version ("v3"), not off, the folder's file, the series' or the song. */
export function isMusicVersionId(id: string): id is MusicVersionId {
  return VERSION_ID.test(id);
}

/** The number of a version id ("v12" is 12), or `null` for anything else. */
export function musicVersionNumber(id: string): number | null {
  return isMusicVersionId(id) ? Number(id.slice(1)) : null;
}

/**
 * What can be picked: a version, `off` (No music: silence of the same length), `file` (the music
 * file the job folder brought), `series` (the series kit's music) or `song` (the song got for the
 * video, Songs; the record's `song`).
 */
export const musicPickIdSchema = z.union([
  musicVersionIdSchema,
  z.literal('off'),
  z.literal('file'),
  z.literal('series'),
  z.literal('song'),
]);
export type MusicPickId = z.infer<typeof musicPickIdSchema>;

// --- the plan ------------------------------------------------------------------------------------

/** One style or one thing to avoid: "120 BPM", "vocals". */
const styleSchema = z.string().min(1);

/** One section of a plan: its name, its exact length and its own styles. */
export const musicSectionSchema = z.object({
  name: z.string().min(1),
  ms: z.number().int().min(MUSIC_LIMITS.sectionMinMs).max(MUSIC_LIMITS.sectionMaxMs),
  styles: z.array(styleSchema),
  avoid: z.array(styleSchema),
});
export type MusicSection = z.infer<typeof musicSectionSchema>;

/**
 * edit/music/plan.json: what the edit run asks for, model-agnostic (the script maps it to the
 * API). The sections add up to `lengthMs` exactly; `describe` is the one line Review and the sheet
 * show.
 */
export const musicPlanSchema = z
  .object({
    lengthMs: z.number().int().min(MUSIC_LIMITS.lengthMinMs).max(MUSIC_LIMITS.lengthMaxMs),
    styles: z.array(styleSchema).min(1),
    avoid: z.array(styleSchema),
    sections: z.array(musicSectionSchema).min(1),
    describe: z.string().min(1).max(MUSIC_LIMITS.describeMax),
  })
  .superRefine((plan, ctx) => {
    const sum = plan.sections.reduce((total, section) => total + section.ms, 0);
    if (sum !== plan.lengthMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `must add up to lengthMs (${plan.lengthMs} ms), not ${sum} ms`,
      });
    }
  });
export type MusicPlan = z.infer<typeof musicPlanSchema>;

// --- the record ----------------------------------------------------------------------------------

/**
 * Where a job's music came from: `made` by ElevenLabs, `supplied` by the job folder, the
 * `series` kit's, `none` because a rule says no music (the record's `reason` says whose), or a
 * `song` that was asked for and got (the record's `song`; Songs).
 */
export const MUSIC_SOURCES = ['made', 'supplied', 'series', 'none', 'song'] as const;
export const musicSourceSchema = z.enum(MUSIC_SOURCES);
export type MusicSource = z.infer<typeof musicSourceSchema>;

/**
 * The reason a `none` record carries when nothing asked for music (U21): the edit run runs the
 * music script's `none` command with these words, word for word, and Review and the job sheet tell
 * this case from a rule that says no music by them. Music is made or fetched only when the job
 * asks for it explicitly.
 */
export const MUSIC_NOT_ASKED_REASON = 'Music was not asked for.';

/**
 * Whether the record says no music was made because none was asked for (not because a rule says no
 * music): the actions that add some (Make music, Another song) are what Review offers then.
 */
export function musicWasNotAsked(record: Pick<MusicRecord, 'source' | 'reason'> | null): boolean {
  return record?.source === 'none' && record.reason === MUSIC_NOT_ASKED_REASON;
}

/** Who made a version: the edit run, a revise run, or the owner with Make another. */
export const MUSIC_MAKERS = ['edit', 'revise', 'you'] as const;
export const musicBySchema = z.enum(MUSIC_MAKERS);
export type MusicBy = z.infer<typeof musicBySchema>;

/**
 * Why a make failed: ElevenLabs said no (`no_credits`, `no_access`, `no_key`), it could not be
 * reached or took too long (`down`), the plan does not fit the contract (`bad_plan`), or anything
 * else (`failed`).
 */
export const MUSIC_FAILURE_CODES = [
  'no_credits',
  'no_access',
  'no_key',
  'down',
  'bad_plan',
  'failed',
] as const;
export const musicFailureCodeSchema = z.enum(MUSIC_FAILURE_CODES);
export type MusicFailureCode = z.infer<typeof musicFailureCodeSchema>;

/** One version: v1.mp3, v2.mp3 … Never changed once made. */
export const musicVersionSchema = z.object({
  id: musicVersionIdSchema,
  /** The file inside edit/music/: "v2.mp3". */
  file: z.string().regex(/^v[1-9]\d*\.mp3$/, 'must be v1.mp3, v2.mp3 …'),
  /** The line Review and the sheet show for it. */
  describe: z.string().min(1).max(MUSIC_LIMITS.versionDescribeMax),
  /** Make another's words, or `null`. */
  ask: z.string().min(1).max(MUSIC_LIMITS.askMax).nullable(),
  seed: z.number().int().nonnegative(),
  /** The model that made it ("music_v2_5"); `fake` for the fake path's tone. */
  model: z.string().min(1),
  lengthMs: z.number().int().positive(),
  by: musicBySchema,
  madeAt: isoTimestampSchema,
});
export type MusicVersion = z.infer<typeof musicVersionSchema>;

/** One pick, oldest first: what was picked and when. */
export const musicPickSchema = z.object({ id: musicPickIdSchema, at: isoTimestampSchema });
export type MusicPick = z.infer<typeof musicPickSchema>;

/** The version being made right now. */
export const musicMakingSchema = z.object({
  id: musicVersionIdSchema,
  ask: z.string().min(1).max(MUSIC_LIMITS.askMax).nullable(),
  startedAt: isoTimestampSchema,
});
export type MusicMaking = z.infer<typeof musicMakingSchema>;

/** The last make that failed; cleared when a make succeeds. */
export const musicFailureSchema = z.object({
  /** The version it was making. */
  id: musicVersionIdSchema,
  code: musicFailureCodeSchema,
  /** One plain sentence for the owner, with any key redacted. */
  message: z.string().min(1),
  at: isoTimestampSchema,
});
export type MusicFailure = z.infer<typeof musicFailureSchema>;

// --- songs ---------------------------------------------------------------------------------------

/** What the getter and the song command accept and write for a song (Songs, SG0). */
export const SONG_LIMITS = {
  /** A title or an artist, in characters. */
  titleMax: 120,
  artistMax: 120,
  /** The line for adding the song in Instagram, in characters. */
  instagramLineMax: 240,
  /** The part of the song the video uses, in ms (3–120 s). */
  partMinMs: 3_000,
  partMaxMs: 120_000,
} as const;

/** The kinds of a song, when its name says so; `original` is the studio track as released. */
export const SONG_VERSIONS = ['original', 'sped up', 'slowed', 'remix'] as const;
export const songVersionSchema = z.enum(SONG_VERSIONS);
export type SongVersion = z.infer<typeof songVersionSchema>;

/**
 * How the song was asked for: from a `screenshot` (a reel's song under it), a `link` (a reel, a
 * video or a Spotify / Apple Music page), a `name` (typed in the note), a Review `note` (Another
 * song), or as `trending` (the editor picks one).
 */
export const SONG_ASKED_FROM = ['screenshot', 'link', 'name', 'note', 'trending'] as const;
export const songAskedFromSchema = z.enum(SONG_ASKED_FROM);
export type SongAskedFrom = z.infer<typeof songAskedFromSchema>;

/** Who asked: the `brief` (Yael's request, read by the Brief run), `you` (the owner, in Review) or the `editor` (a trending pick). */
export const SONG_ASKED_BY = ['brief', 'you', 'editor'] as const;
export const songAskedBySchema = z.enum(SONG_ASKED_BY);
export type SongAskedBy = z.infer<typeof songAskedBySchema>;

/** The sites a song can come from. YouTube (Music) is downloaded with yt-dlp, a reel's page with Apify. */
export const SONG_SITES = ['youtube-music', 'youtube', 'instagram', 'tiktok'] as const;
export const songSiteSchema = z.enum(SONG_SITES);
export type SongSite = z.infer<typeof songSiteSchema>;

/** What got it: `yt-dlp` (YouTube and YouTube Music) or `apify` (Instagram and TikTok; never Instagram directly). */
export const SONG_VIAS = ['yt-dlp', 'apify'] as const;
export const songViaSchema = z.enum(SONG_VIAS);
export type SongVia = z.infer<typeof songViaSchema>;

/**
 * How the part was chosen: `measured` (the window of the cut's length with the biggest rise, a
 * drop or a chorus, starting on a downbeat), `whole` (the song is no longer than the cut, so all
 * of it) or `reel` (matched from the reel's own audio: reserved for SG16, nothing sets it now).
 */
export const SONG_PART_HOWS = ['measured', 'whole', 'reel'] as const;
export const songPartHowSchema = z.enum(SONG_PART_HOWS);
export type SongPartHow = z.infer<typeof songPartHowSchema>;

/**
 * Why a song could not be got: `not_found` (no such song, or the link has none), `unavailable` (the
 * site or the downloader did not answer, or the video is gone), `blocked` (the site refused the
 * request), `update_needed` (yt-dlp is too old for the site), `tool_missing` (yt-dlp, deno or ffmpeg
 * is not installed), `needs_key` (a reel or a trending pick needs the Apify key and .env has none),
 * `original_audio` (the reel's audio is "Original audio": there is no song to look up, so the
 * edit asks for the reel's link or the name), `no_trending` (Instagram's numbers gave no song that
 * fits), or anything else (`failed`).
 */
export const SONG_FAILURE_CODES = [
  'not_found',
  'unavailable',
  'blocked',
  'update_needed',
  'tool_missing',
  'needs_key',
  'original_audio',
  'no_trending',
  'failed',
] as const;
export const songFailureCodeSchema = z.enum(SONG_FAILURE_CODES);
export type SongFailureCode = z.infer<typeof songFailureCodeSchema>;

/** The part of the song the video uses. */
export const songPartSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    how: songPartHowSchema,
    /**
     * How many beats the beat finder found inside the part (C73). `0` is a part with no steady
     * beat (a ballad, or the finder gave none): Review then does not say the cuts sit on its beat.
     * Optional so records written before it still parse; absent means it was not counted.
     */
    beatCount: z.number().int().nonnegative().optional(),
  })
  .superRefine((part, ctx) => {
    const length = part.endMs - part.startMs;
    if (length < SONG_LIMITS.partMinMs || length > SONG_LIMITS.partMaxMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['endMs'],
        message: `must be 3 to 120 s after startMs, not ${length} ms`,
      });
    }
  });
export type SongPart = z.infer<typeof songPartSchema>;

/** What Instagram says about a song that was picked as trending (SG10); `null` for a song nobody picked as trending. */
export const songTrendingSchema = z.object({
  /** Reels that use the sound; `null` when Instagram did not say. */
  reels: z.number().int().nonnegative().nullable(),
  /** Instagram's own trending flag on the sound; `null` when Instagram did not say. */
  isTrending: z.boolean().nullable(),
  /** How many of the niche's top 20 recent reels use the sound; `null` when that was not counted. */
  nicheTop20: z.number().int().min(0).max(20).nullable(),
  /** The niche it was ranked in: "#fpv #drone". */
  niche: z.string().min(1),
});
export type SongTrending = z.infer<typeof songTrendingSchema>;

/**
 * The song a video uses: edit/music/music.json's `song`. Written only by the music script's `song`
 * command. `file` is `music/song.mp3`, the part (`part`) cut from the whole song
 * (`MUSIC_FILES.songFull`), at -20 LUFS like every version; edit/preview/music.mp3 is a copy of it
 * while `picked` is `song`.
 */
export const songSchema = z.object({
  /** As written on the site, in the song's own language and spelling. */
  title: z.string().min(1).max(SONG_LIMITS.titleMax),
  artist: z.string().min(1).max(SONG_LIMITS.artistMax),
  version: songVersionSchema.nullable(),
  asked: z.object({
    from: songAskedFromSchema,
    /** The screenshot (or other file) it was read from, as its name in the job folder or in the note's attachments; else `null`. */
    file: z.string().min(1).nullable(),
    /** The link it was asked for with; else `null`. */
    url: z.string().min(1).nullable(),
    by: songAskedBySchema,
  }),
  /** Where the audio really came from (not where it was asked for: a reel's song is got from YouTube Music). */
  source: z.object({
    site: songSiteSchema,
    via: songViaSchema,
    url: z.string().min(1),
    /** The site's own id for it (a video id, a reel's shortcode). */
    id: z.string().min(1),
  }),
  /** The whole song's length. */
  fullMs: z.number().int().positive(),
  part: songPartSchema,
  trending: songTrendingSchema.nullable(),
  file: z.literal('song.mp3'),
  /** The line for adding the song in Instagram: `instagramLine(song)`. */
  instagramLine: z.string().min(1).max(SONG_LIMITS.instagramLineMax),
  gotAt: isoTimestampSchema,
});
export type Song = z.infer<typeof songSchema>;

/** The last song that could not be got; cleared when a song is got. */
export const songFailureSchema = z.object({
  /** What was asked for, in a few words the owner recognises: "נתתי לך בית by Ofek Adanek", the link, "a trending song". */
  asked: z.string().min(1),
  code: songFailureCodeSchema,
  /** One plain sentence for the owner, with any key redacted. */
  message: z.string().min(1),
  at: isoTimestampSchema,
});
export type SongFailure = z.infer<typeof songFailureSchema>;

/** 42000 ms is "0:42". */
function songClock(ms: number): string {
  return clock(ms / 1000);
}

/** `text` cut to at most `max` UTF-16 units, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const characters = Array.from(text);
  while (characters.length > 0 && characters.join('').length + 1 > max) characters.pop();
  return `${characters.join('')}…`;
}

/**
 * The line to send with the file that has no song: "In Instagram tap Add audio, pick נתתי לך בית by
 * Ofek Adanek and slide it to start at 0:42." (the part's start as m:ss). Never longer than
 * `SONG_LIMITS.instagramLineMax`: a title and an artist that would not fit are cut, with an ellipsis.
 */
export function instagramLine(song: Pick<Song, 'title' | 'artist' | 'part'>): string {
  const build = (title: string, artist: string): string =>
    `In Instagram tap Add audio, pick ${title} by ${artist} and slide it to start at ${songClock(song.part.startMs)}.`;
  const room = SONG_LIMITS.instagramLineMax - build('', '').length;
  const half = Math.floor(room / 2);
  let { title, artist } = song;
  if (title.length + artist.length > room) {
    if (title.length <= half) artist = clip(artist, room - title.length);
    else if (artist.length <= half) title = clip(title, room - artist.length);
    else {
      title = clip(title, half);
      artist = clip(artist, room - half);
    }
  }
  return build(title, artist);
}

/** The song that is picked, or `null` when the pick is a version, off, a file, the series' or nothing. */
export function pickedSong(record: Pick<MusicRecord, 'picked' | 'song'> | null): Song | null {
  return record?.picked === 'song' ? record.song : null;
}

const musicRecordShape = {
  v: z.literal(1),
  source: musicSourceSchema,
  /** For `none`: whose rule says no music. */
  reason: z.string().min(1).nullable(),
  /** For `supplied`: the job folder's file; for `series`: the kit's file. */
  file: z.string().min(1).nullable(),
  /** The plan the versions were made from (the last one used). */
  plan: musicPlanSchema.nullable(),
  /** What edit/preview/music.mp3 is now; `null` before anything is picked, and for `none`. */
  picked: musicPickIdSchema.nullable(),
  versions: z.array(musicVersionSchema),
  picks: z.array(musicPickSchema),
  making: musicMakingSchema.nullable(),
  failure: musicFailureSchema.nullable(),
  /**
   * Songs: the song that was got for the video (`source` and `picked` are `song` while it is the
   * music). `null` when none was asked for or got. A record written before Songs has no such key
   * and reads as `null`.
   */
  song: songSchema.nullable().default(null),
  /**
   * Songs: why the last song could not be got (the edit then falls back to `made`, as before
   * Songs); cleared when a song is got. Read as `null` when the key is absent.
   */
  songFailure: songFailureSchema.nullable().default(null),
};

/** edit/music/music.json: where the job's music came from, its versions and its picks. */
export const musicRecordSchema = z.object(musicRecordShape);
export type MusicRecord = z.infer<typeof musicRecordSchema>;

/** A record with nothing in it yet: the first make or pick of a job starts from this. */
export function emptyMusicRecord(): MusicRecord {
  return {
    v: 1,
    source: 'made',
    reason: null,
    file: null,
    plan: null,
    picked: null,
    versions: [],
    picks: [],
    making: null,
    failure: null,
    song: null,
    songFailure: null,
  };
}

// --- the API -------------------------------------------------------------------------------------

/**
 * `GET /api/jobs/:id/music` (and the `job.music` event): the record, plus whether Make another and
 * Pick are allowed now (`canMake`, with `whyNot` saying why not), and `rev`, a number that changes
 * whenever edit/preview/music.mp3 does (the page puts it in the preview's URL, so the player loads
 * the new music). The answer is `null` for a job with no music.json.
 */
export const musicViewSchema = z.object({
  ...musicRecordShape,
  canMake: z.boolean(),
  whyNot: z.string().min(1).nullable(),
  rev: z.number().int().nonnegative(),
});
export type MusicView = z.infer<typeof musicViewSchema>;

/** `GET /api/jobs/:id/music`: the job's music, or `null` when it has no music.json. */
export const musicResponseSchema = musicViewSchema.nullable();
export type MusicResponse = z.infer<typeof musicResponseSchema>;

/**
 * `POST /api/jobs/:id/music` body: Make another, with the owner's words or without. Answers 202 with the
 * MusicView, now `making`. Blank words are no words.
 */
export const makeMusicRequestSchema = z.object({
  ask: z.string().trim().max(MUSIC_LIMITS.askMax).optional(),
});
export type MakeMusicRequest = z.infer<typeof makeMusicRequestSchema>;

/**
 * `PUT /api/jobs/:id/music/pick` body: a version, `off` for No music, or `file` / `series` for the
 * music the job folder or the series brought, back after No music. Answers the MusicView.
 */
export const pickMusicRequestSchema = z.object({ id: musicPickIdSchema });
export type PickMusicRequest = z.infer<typeof pickMusicRequestSchema>;

/**
 * The engine's words for the refusals of the music routes (`{ error }`, the status is in each
 * comment) and for `MusicView.whyNot`, which says the same thing when Make another and Pick are not
 * allowed. Plain sentences for the owner; the page shows them as they are.
 */
export const MUSIC_MESSAGES = {
  /** 404, every music route while the Soundtrack switch is off. */
  off: 'Music is off.',
  /** 409 and `whyNot`: the video is not waiting for the owner's review (it is editing, queued, approved …). */
  notInReview: 'Music can be changed while the video waits for your review.',
  /** 409 and `whyNot`: an episode of a series plays the series' music. */
  episode: 'Episodes play the series’ music.',
  /**
   * 409 and `whyNot`: there is no plan to make a version from (the music came from the folder, from
   * the series' kit, or a rule says none). A record that has a plan is allowed whatever else it
   * lacks, a first make that failed (no versions, nothing picked) included: Make another is how the
   * music gets made once ElevenLabs works again.
   */
  noPlan: 'There’s no music plan for this video.',
  /** 409 and `whyNot`: a Pick is under way (it takes a moment). */
  busy: 'The music is being changed. Try again in a moment.',
  /** 409: the engine is shutting down. */
  stopping: 'The engine is shutting down.',
  /** 404, Pick: the job has no such version. */
  noSuchVersion: 'There is no such music version.',
} as const;

/** 409 and `whyNot`: a version is being made, so nothing can be changed and Approve waits. */
export function musicStillBeingMade(id: string): string {
  return `Music ${id} is still being made.`;
}

// --- the music script's answer -------------------------------------------------------------------

/**
 * What the music script printed on success: the id it made or picked (`v2`, `off`, `file`,
 * `series`, `song` for the `song` command, or `none` for a record of no music) and the music's
 * length (`null` when it has none, or a supplied file's length could not be read; the song's part
 * for `song`).
 */
export const musicScriptOkSchema = z.object({
  ok: z.literal(true),
  id: z.union([musicPickIdSchema, z.literal('none')]),
  lengthMs: z.number().int().nonnegative().nullable(),
});

/**
 * What the music script printed on failure: a Soundtrack failure code (`make`, `pick` …) or, for
 * the `song` command (Songs, SG3), a song failure code. `failed` is both's.
 */
export const musicScriptCodeSchema = z.union([musicFailureCodeSchema, songFailureCodeSchema]);
export type MusicScriptCode = z.infer<typeof musicScriptCodeSchema>;

export const musicScriptErrorSchema = z.object({
  ok: z.literal(false),
  code: musicScriptCodeSchema,
  message: z.string().min(1),
});

/** The one JSON line the music script prints on stdout. */
export const musicScriptLineSchema = z.discriminatedUnion('ok', [
  musicScriptOkSchema,
  musicScriptErrorSchema,
]);
export type MusicScriptLine = z.infer<typeof musicScriptLineSchema>;

/**
 * The script's exit codes: 0 done, 2 refused (ElevenLabs said no: credits, access, key; a song
 * cannot be got until the owner acts: `needs_key`, `tool_missing`, or there is no song to get:
 * `original_audio`), 3 it is down or timed out (ElevenLabs; a song's site or downloader:
 * `unavailable`, `blocked`), 1 anything else (a bad plan, a bad call, a broken file; a song that
 * was not found, `update_needed`, `no_trending`, `failed`).
 */
export const MUSIC_EXIT_CODES = { ok: 0, failed: 1, refused: 2, down: 3 } as const;

/** The exit code that goes with a failure code. */
export function musicExitCode(code: MusicScriptCode): number {
  switch (code) {
    case 'no_credits':
    case 'no_access':
    case 'no_key':
    case 'needs_key':
    case 'tool_missing':
    case 'original_audio':
      return MUSIC_EXIT_CODES.refused;
    case 'down':
    case 'unavailable':
    case 'blocked':
      return MUSIC_EXIT_CODES.down;
    case 'bad_plan':
    case 'not_found':
    case 'update_needed':
    case 'no_trending':
    case 'failed':
      return MUSIC_EXIT_CODES.failed;
  }
}

/**
 * The script's answer from what it printed: the last line of stdout that is a valid answer, or
 * `null` when there is none (it crashed before printing).
 */
export function parseMusicScriptLine(stdout: string): MusicScriptLine | null {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = musicScriptLineSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: an earlier line.
    }
  }
  return null;
}

// --- small rules ---------------------------------------------------------------------------------

/**
 * The id the next make gets: one past the highest version made ("v1" for a record with none). A
 * failed make leaves no version, so the next try reuses its id.
 */
export function nextVersionId(record: Pick<MusicRecord, 'versions'> | null): MusicVersionId {
  let highest = 0;
  for (const version of record?.versions ?? []) {
    highest = Math.max(highest, musicVersionNumber(version.id) ?? 0);
  }
  return `v${highest + 1}`;
}

/** The version that is picked, or `null` when the pick is off, a file, the series' or nothing. */
export function pickedVersion(
  record: Pick<MusicRecord, 'picked' | 'versions'> | null,
): MusicVersion | null {
  const picked = record?.picked;
  if (picked == null || !isMusicVersionId(picked)) return null;
  return record?.versions.find((version) => version.id === picked) ?? null;
}

/** A version by its id, or `null`. */
export function findMusicVersion(
  record: Pick<MusicRecord, 'versions'> | null,
  id: string,
): MusicVersion | null {
  return record?.versions.find((version) => version.id === id) ?? null;
}

/** A length of music as the page and the usage line say it: 39000 ms is "0:39". */
export function formatMusicLength(ms: number): string {
  return clock(ms / 1000);
}

/**
 * The length in seconds that a usage line of the music ends with: "Made music v2 for Horizon FPV / Demo
 * (0:39)" is 39. `null` for a line that does not end like that.
 */
export function musicLengthSecOfUsageLine(did: string): number | null {
  const match = /\((?:(\d+):)?(\d{1,2}):(\d{2})\)\s*$/.exec(did);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Whether a version is being made right now. */
export function isMakingMusic(record: Pick<MusicRecord, 'making'> | null): boolean {
  return record?.making != null;
}
