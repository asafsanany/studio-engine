// What the job sheet says about a job's music (Soundtrack plan, "Job sheet"; canvas page
// "Soundtrack", boards SDSheet, SDStates and SDPhone).
//
//   musicDetailRow(music)    the Music row of Details, after Inputs (Mac and phone): a value and
//                            a second, muted line under it. "Made for this video · v2 of 2" and
//                            the version's line, "Summer Vibes.mp3" and "From the folder.
//                            Nothing was made.", "None" and whose rule it was, "None · couldn’t
//                            make it" (in the failure colour) and why. `null` for no row
//   musicHistoryRows(music)  History's music lines, each with its moment: "Music v1 made · 0:39 ·
//                            ElevenLabs", "Music v2 made · you asked: …", "You picked music v1",
//                            "Couldn’t make music: …" (in the failure colour)
//
// With Songs on, the same two read the record's song too (Songs, SG9; board SGSheet): the Music row
// of a video whose music is the song says "[title] · [artist]" and where it came from ("From Yael’s
// screenshot (IMG_4412.PNG). The studio track from YouTube Music; the part used, 0:42 to 1:21."),
// and a song that could not be got says why and which version ElevenLabs made instead. History
// says what the record knows (`songEventText`): the brief found the song, the editor picked a
// trending one, the song was got, the song could not be got.
//
// Both read only the job's MusicView (`useJobMusic(job.id).data`): `null` (the switch is off, or
// the job has no music.json) gives no row and no lines. Pure, like sheet-details.ts and
// sheet-history.ts, which call them.
//
// What the record can say, and so what the sheet says (a version is picked as soon as it is made,
// so a record always has a pick once it has a version):
//   making (a make is running)         "Making it now" for the first version, "Making v3" after
//   source none                        "None" and the record's reason; "No music asked for" and
//                                      "Nothing was made." when the reason is that nobody asked (U21)
//   picked off                         "None · you turned it off"
//   source supplied / series           the folder's file / "The series’ music"
//   source made with versions          "Made for this video · v2 of 2" and the picked one's line
//   source made, no version, a failure "None · couldn’t make it" and the failure's message
//   anything else (an empty record)    nothing to say yet: no row

import {
  clock,
  formatMusicLength,
  type MusicVersion,
  type MusicView,
  musicWasNotAsked,
  pickedSong,
  pickedVersion,
  type Song,
  type SongEvent,
  type SongFailure,
  songEventText,
} from '@studio/shared';
import { compactCount } from '@/features/review/music/music-text';
import type { DetailRow } from './sheet-details';

/**
 * How a History line reads on top of the normal colour: `failure` in the failure colour (red),
 * `active` in the colour of a step that is running now (blue), `warn` in amber (the Generate
 * stage's budget ran out).
 */
export type HistoryTone = 'failure' | 'active' | 'warn';

/** One music line of History before it is placed: an id unique in the job's history, its moment (ISO), its text and its tone. */
export interface MusicHistoryEvent {
  id: string;
  at: string;
  text: string;
  tone?: HistoryTone;
}

/** The sheet's own words for music. */
export const MUSIC_SHEET_TEXT = {
  making: 'Making it now',
  makingFirst: 'Written to the cut by ElevenLabs. No music file was in the folder.',
  makingFirstAnyway: 'Written to the cut by ElevenLabs.',
  made: 'Made for this video',
  none: 'None',
  /** Nobody asked for music (U21): nothing was made on purpose. */
  notAsked: 'No music asked for',
  notAskedSub: 'Nothing was made.',
  off: 'None · you turned it off',
  failed: 'None · couldn’t make it',
  folderNothingMade: 'From the folder. Nothing was made.',
  folderFileUnknown: 'A file from the folder',
  series: 'The series’ music',
  songFailed: 'Couldn’t get the song',
  songOriginalAudio: 'Original audio',
} as const;

/** The second line of a Music row that carries the owner's words for a version (Make another's "darker, more drums"). */
const youAsked = (ask: string): string => `You asked: ${ask}`;

/** A file's name without its folders: "music/Summer Vibes.mp3" is "Summer Vibes.mp3". */
function fileName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** A Music row: its value and, when it has one, the muted line under it. */
function row(value: string, sub?: string | null, tone?: 'failure'): DetailRow {
  return {
    label: 'Music',
    value,
    muted: false,
    ...(sub ? { sub } : {}),
    ...(tone ? { tone } : {}),
  };
}

// --- the song ------------------------------------------------------------------------------------

/** Where a song was asked for, as the Music row says it: "From Yael’s screenshot (IMG_4412.PNG)." */
function askedText(song: Song): string {
  const { asked, trending } = song;
  if (asked.from === 'trending' || asked.by === 'editor') {
    const niche = trending === null ? '' : ` in ${trending.niche}`;
    const reels =
      trending !== null && trending.reels !== null && trending.reels > 0
        ? ` In ${compactCount(trending.reels)} ${trending.reels === 1 ? 'reel' : 'reels'}.`
        : '';
    return `Picked by the editor as rising on Reels${niche}.${reels}`;
  }
  switch (asked.from) {
    case 'screenshot':
      return asked.file === null
        ? 'From Yael’s screenshot.'
        : `From Yael’s screenshot (${asked.file}).`;
    case 'link':
      return asked.by === 'you' ? 'From the link you sent.' : 'From a link Yael sent.';
    default:
      return 'From your note.';
  }
}

/** What the song is when it is not the studio track as released: "The sped up version". */
function songWhat(song: Song, original: string): string {
  const { version } = song;
  return version === null || version === 'original' ? original : `The ${version} version`;
}

/** Where the audio came from, and the part of it in the video: "The studio track from YouTube Music; the part used, 0:42 to 1:21." */
function gotText(song: Song): string {
  const { part } = song;
  const span = `${clock(part.startMs / 1000)} to ${clock(part.endMs / 1000)}`;
  const used =
    part.how === 'whole'
      ? `the whole song, ${clock(song.fullMs / 1000)}`
      : part.how === 'reel'
        ? `the part the reel uses, ${span}`
        : `the part used, ${span}`;
  const where = (() => {
    switch (song.source.site) {
      case 'youtube-music':
        return `${songWhat(song, 'The studio track')} from YouTube Music`;
      case 'youtube':
        return `${songWhat(song, 'The track')} from YouTube`;
      case 'instagram':
        return 'The reel’s own audio from Instagram';
      case 'tiktok':
        return 'The video’s own audio from TikTok';
    }
  })();
  return `${where}; ${used}.`;
}

/** The Music row of a video whose music is the song. */
function songRow(song: Song): DetailRow {
  return row(`${song.title} · ${song.artist}`, `${askedText(song)} ${gotText(song)}`);
}

/**
 * The Music row of a song that could not be got. The record leaves the earlier pick, so this is a
 * version ElevenLabs made instead (`version`), or none. "Original audio" is not an error: there is
 * no song to look up, and the row says so plainly.
 */
function songFailureRow(failure: SongFailure, version: MusicVersion | null): DetailRow {
  const instead = version === null ? '' : ` ElevenLabs made ${version.id} instead.`;
  if (failure.code === 'original_audio') {
    const account = /@[\w.]+/.exec(failure.asked)?.[0];
    const says = account === undefined ? 'Original audio' : `Original audio · ${account}`;
    return row(
      MUSIC_SHEET_TEXT.songOriginalAudio,
      `The screenshot says “${says}”, so there’s nothing to look up.${instead}`,
    );
  }
  return row(MUSIC_SHEET_TEXT.songFailed, `${failure.message}${instead}`, 'failure');
}

/** The Music row of Details, or `null` for none. */
export function musicDetailRow(music: MusicView | null | undefined): DetailRow | null {
  if (!music) return null;
  const { making, source, picked, versions, failure } = music;

  if (making !== null) {
    if (versions.length > 0) return row(`Making ${making.id}`, making.ask && youAsked(making.ask));
    const sub =
      making.ask !== null
        ? youAsked(making.ask)
        : source === 'made'
          ? MUSIC_SHEET_TEXT.makingFirst
          : MUSIC_SHEET_TEXT.makingFirstAnyway;
    return row(MUSIC_SHEET_TEXT.making, sub);
  }

  if (musicWasNotAsked(music)) {
    return row(MUSIC_SHEET_TEXT.notAsked, MUSIC_SHEET_TEXT.notAskedSub);
  }
  if (source === 'none') return row(MUSIC_SHEET_TEXT.none, music.reason);
  if (picked === 'off') return row(MUSIC_SHEET_TEXT.off);

  if (source === 'supplied') {
    const name = music.file === null ? MUSIC_SHEET_TEXT.folderFileUnknown : fileName(music.file);
    return row(name, MUSIC_SHEET_TEXT.folderNothingMade);
  }
  if (source === 'series') {
    return row(MUSIC_SHEET_TEXT.series, music.file === null ? null : fileName(music.file));
  }

  // The song (Songs): it plays, or it could not be got and ElevenLabs made music instead.
  const song = pickedSong(music);
  if (song !== null) return songRow(song);

  // Made by ElevenLabs. A pick that names no version (it should not happen) reads as the latest.
  const version = pickedVersion(music) ?? versions.at(-1) ?? null;
  if (music.songFailure !== null && (version !== null || failure === null)) {
    return songFailureRow(music.songFailure, version);
  }
  if (version !== null) {
    const count = versions.length;
    const which = count > 1 ? `${version.id} of ${count}` : version.id;
    return row(`${MUSIC_SHEET_TEXT.made} · ${which}`, version.describe);
  }
  if (failure !== null) return row(MUSIC_SHEET_TEXT.failed, failure.message, 'failure');
  return null;
}

// --- history ------------------------------------------------------------------------------------

/**
 * How soon after a version was made its own pick is recorded for it to count as the make's: the
 * music script picks the version it makes in the same call, within a moment.
 */
export const AUTO_PICK_WINDOW_MS = 10_000;

const ms = (iso: string): number => Date.parse(iso);

/** "Music v2 made · you asked: darker, heavier drums": who made it, and why, after the version. */
function madeText(version: MusicVersion): string {
  const head = `Music ${version.id} made`;
  switch (version.by) {
    case 'edit':
      return `${head} · ${formatMusicLength(version.lengthMs)} · ElevenLabs`;
    case 'revise':
      return `${head} · fits the new cut`;
    case 'you':
      return version.ask === null
        ? `${head} · you asked for another`
        : `${head} · you asked: ${version.ask}`;
  }
}

/**
 * The picks that were not the owner's choice, by their place in `picks`: the pick a make records for
 * the version it made, when the edit run or a revise run made it. The owner's own Make another is their
 * choice, so its pick stays (the board shows "Music v2 made · you asked: …" and then "You picked
 * music v2"). A version has at most one such pick: the first of its own id after it was made.
 */
function automaticPicks(music: MusicView): Set<number> {
  const automatic = new Set<number>();
  for (const version of music.versions) {
    if (version.by === 'you') continue;
    const index = music.picks.findIndex((pick) => {
      const wait = ms(pick.at) - ms(version.madeAt);
      return pick.id === version.id && wait >= 0 && wait <= AUTO_PICK_WINDOW_MS;
    });
    if (index >= 0) automatic.add(index);
  }
  return automatic;
}

/**
 * The place in `picks` of the pick the song command recorded for the song it got, if it is there:
 * the first pick of `song` made within a moment after the song was got. The owner's own pick of the song
 * (back from No music, or from a version) comes later and is a line of its own.
 */
function automaticSongPick(music: MusicView): number {
  const { song } = music;
  if (song === null) return -1;
  return music.picks.findIndex((pick) => {
    const wait = ms(pick.at) - ms(song.gotAt);
    return pick.id === 'song' && wait >= 0 && wait <= AUTO_PICK_WINDOW_MS;
  });
}

/** What the music lines can use of the rest of the job. */
export interface MusicHistoryContext {
  /**
   * When the Brief run ended (the end of the first edit run's step 1), for "The brief found the
   * song on Yael’s screenshot": the record knows when the song was got, not when it was named.
   * Left out, the song is found at the moment it was got.
   */
  briefAt?: string | null;
}

/**
 * The song's lines (Songs): what the record knows, in the words of `songEventText`. A trending pick
 * says what the editor picked (the number of songs it looked at is not in the record, so the line
 * does not say it); any other song says who found it and from what. Then the song got, and a song
 * that could not be got (in the failure colour).
 */
function songHistoryRows(music: MusicView, briefAt: string | null): MusicHistoryEvent[] {
  const lines: MusicHistoryEvent[] = [];
  const add = (id: string, event: SongEvent, tone?: MusicHistoryEvent['tone']) => {
    lines.push({ id, at: event.at, text: songEventText(event), ...(tone ? { tone } : {}) });
  };
  const { song, songFailure } = music;
  if (song !== null) {
    const { asked, trending } = song;
    if ((asked.from === 'trending' || asked.by === 'editor') && trending !== null) {
      // The pick and the song command run together: the pick is the first thing the record knows.
      add('song-trending', {
        type: 'music.song.trending',
        at: song.gotAt,
        niche: trending.niche,
        looked: 0,
        pick: { title: song.title, artist: song.artist },
      });
    } else {
      // Named by the Brief run before anything was fetched: never later than the song was got.
      const named =
        asked.by === 'brief' && briefAt !== null && ms(briefAt) <= ms(song.gotAt)
          ? briefAt
          : song.gotAt;
      add('song-found', {
        type: 'music.song.found',
        at: named,
        from: asked.from,
        by: asked.by,
        file: asked.file,
        url: asked.url,
        title: song.title,
        artist: song.artist,
      });
    }
    add('song-got', {
      type: 'music.song.got',
      at: song.gotAt,
      site: song.source.site,
      via: song.source.via,
      fullMs: song.fullMs,
      part: song.part,
    });
  }
  if (songFailure !== null) {
    add(
      'song-failed',
      {
        type: 'music.song.failed',
        at: songFailure.at,
        code: songFailure.code,
        message: songFailure.message,
      },
      'failure',
    );
  }
  return lines;
}

/** History's music lines, in any order (History sorts them by `at`). */
export function musicHistoryRows(
  music: MusicView | null | undefined,
  { briefAt = null }: MusicHistoryContext = {},
): MusicHistoryEvent[] {
  if (!music) return [];
  const lines: MusicHistoryEvent[] = [];

  for (const version of music.versions) {
    lines.push({ id: `music-made-${version.id}`, at: version.madeAt, text: madeText(version) });
  }

  // The picks are only ever added to, so a pick's place in the list names it for good. A supplied
  // or series file is recorded as a pick too (`file`, `series`), but nobody chose it. Neither did
  // anybody choose the song that was got: the song command picks it as it puts it in the job.
  const automatic = automaticPicks(music);
  const songPick = automaticSongPick(music);
  music.picks.forEach((pick, index) => {
    if (pick.id === 'file' || pick.id === 'series' || automatic.has(index) || index === songPick) {
      return;
    }
    lines.push({
      id: `music-pick-${index}`,
      at: pick.at,
      text:
        pick.id === 'off'
          ? 'You turned the music off'
          : pick.id === 'song'
            ? 'You picked the song'
            : `You picked music ${pick.id}`,
    });
  });

  const { making, failure, plan } = music;
  if (making !== null) {
    const text =
      music.versions.length === 0
        ? `Making music for the cut${plan === null ? '' : ` · ${formatMusicLength(plan.lengthMs)}`}`
        : `Making music ${making.id}${making.ask === null ? '' : ` · you asked: ${making.ask}`}`;
    lines.push({ id: 'music-making', at: making.startedAt, text, tone: 'active' });
  }
  if (failure !== null) {
    lines.push({
      id: 'music-failed',
      at: failure.at,
      text: `Couldn’t make music: ${failure.message}`,
      tone: 'failure',
    });
  }
  lines.push(...songHistoryRows(music, briefAt));
  return lines;
}
