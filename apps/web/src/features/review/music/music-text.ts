import {
  clock,
  formatMusicLength,
  isMusicVersionId,
  type MusicPickId,
  type MusicPlan,
  type MusicVersion,
  type MusicView,
  musicVersionNumber,
  musicWasNotAsked,
  nextVersionId,
  pickedSong,
  pickedVersion,
  type Song,
  type SongFailure,
  type SongSite,
} from '@studio/shared';
import type { FooterView } from '../notes-logic';
import { FOOTER_TEXT } from '../review-text';

// What Review says about a job's music, and the rules behind it (canvas page "Soundtrack", boards
// SDMusic, SDReview, SDStates, SDPhone; with Songs on, canvas page "Songs", boards SGMusic, SGStates
// and SGPhone). No React, no network: tested on plain values.

/** The Music list's words. */
export const MUSIC_TEXT = {
  title: 'Music',
  pickLegend: 'Pick the music',
  close: 'Close',
  /** The pick's tag. */
  inPreview: 'in the preview',
  noMusic: 'No music',
  /** The folder file's line. */
  fromFolder: 'From the job folder. The editor cut to its beat.',
  seriesTitle: 'The series’ music',
  /** How long a make takes, on the making row. */
  makingTime: '~30 s',
  retry: 'Retry',
  askPlaceholder: 'What should change? (optional)',
  /** The phone board's words for the same field: the sheet has less room, so it gives examples. */
  askPlaceholderPhone: 'What should change? Calmer, piano…',
  makeAnother: 'Make another',
  /** The label of the form when nothing was made yet (the folder's file or a "no music" rule). */
  makeInstead: 'Make music for this video instead',
  /** The same when nothing was made because nobody asked for music (U21): there is nothing to make "instead" of. */
  makeNotAsked: 'Make music for this video',
  /** The header's line for a video whose music was not asked for, and the sheet's value (U21). */
  notAsked: 'No music asked for',
  /** What the header adds to it. */
  notAskedNothing: 'Nothing was made.',
  makeOne: 'Make one',
  making: 'Making…',
  hintAnother:
    'Calmer, darker, piano… or leave it empty for another take. About 30 s, same shape, so the cuts stay on the beat.',
  /** The phone board's shorter hint under Make another. */
  hintAnotherPhone: 'About 30 s. Same shape, so the cuts stay on the beat.',
  hintInstead: 'About 30 s. ElevenLabs writes it to this cut, from the brief.',
  seriesBox:
    'Every episode plays the series’ music. To change it for the whole series, leave a note and turn on Series.',
  /** The phone button's accessible name starts with this: "Music, v2". */
  buttonName: 'Music',
} as const;

/** The words of Songs in the Music list (canvas page "Songs", boards SGMusic and SGStates). */
export const SONG_TEXT = {
  /** What the Music button and the controls' bar say while the song is in the preview. */
  nowPlaying: 'The song',
  /** The end of the song row's line, when the part has beats. */
  beat: 'The cuts sit on its beat.',
  /** The end of the song row's line, when the beat finder found no beats in the part (a ballad). */
  noBeat: 'No steady beat; the cuts sit on its accents.',
  /** Under the list while the song is picked. */
  twoFiles:
    'Approve renders two files: with the song, to show the client, and without it, to post. The client adds the song in Instagram.',
  /** The footer's line while the song is picked, in place of "Approve to render the final video, with music v2." */
  approveTwoFiles: `${FOOTER_TEXT.approveLead} two files: with the song, and without it to post.`,
  /** Under the list while No music is picked and a song could be brought back. */
  offNote: 'The video plays and renders without music. Pick one to bring it back.',
  tabsLabel: 'What to try',
  /** The box's tabs: with a song in the list, and without one. */
  tabAnother: 'Another song',
  tabUse: 'Use a song',
  tabMake: 'Make music instead',
  /** The same tab when nobody asked for music, so there is nothing to make "instead" of (U21). */
  tabMakeNew: 'Make music',
  tabMakeAnother: 'Make another',
  /** Another song: the field, its button, the trending button and the hint. */
  fieldLabel: 'A link or a song name',
  fieldHint: 'Paste a link or type a song name',
  addToNotes: 'Add to notes',
  trend: 'Pick a trending one',
  trendAdded: 'Added to your notes',
  anotherHint:
    'YouTube, Instagram, TikTok or Spotify links, or just the name. Or let the editor pick one that’s rising on Reels. It goes in your notes, and the editor re-cuts when you press Send.',
  /** Make music instead: the field and the hint. */
  makeFieldLabel: 'What should change',
  makeHint:
    'About 30 s. ElevenLabs writes it to this cut. No Claude run, your notes stay as they are.',
  /** The alerts above the list. */
  failedTitle: 'Couldn’t get the song',
  noNameTitle: 'No song name on the screenshot',
  needsKeyTitle: 'Reel links need an Apify key',
  /** The note a Pick a trending one adds to the Review notes, word for word. */
  trendingNote: 'Use a trending song that fits the cut.',
} as const;

// --- the button ------------------------------------------------------------------------------------

/**
 * What the Music button says next to "Music": the version in the preview ("v2"), "from the folder",
 * "series", "song" while the song plays (Songs), or "off" for No music (also when nothing is picked:
 * the preview plays no music then).
 */
export function musicButtonLabel(music: Pick<MusicView, 'picked' | 'source'>): string {
  const { picked } = music;
  if (picked === 'song') return 'song';
  if (picked === 'file') return 'from the folder';
  if (picked === 'series' || (picked === null && music.source === 'series')) return 'series';
  if (picked !== null && isMusicVersionId(picked)) return picked;
  return 'off';
}

/** What the preview plays, in the controls' bar: "Music v2", "No music", "Music from the folder", "The series’ music", "The song". */
export function musicNowPlaying(music: Pick<MusicView, 'picked' | 'source'>): string {
  const label = musicButtonLabel(music);
  if (label === 'off') return MUSIC_TEXT.noMusic;
  if (label === 'series') return MUSIC_TEXT.seriesTitle;
  if (label === 'song') return SONG_TEXT.nowPlaying;
  return `Music ${label}`;
}

// --- the footer ------------------------------------------------------------------------------------

/** The footer's line with no notes, without its full stop: the music part follows it. */
const APPROVE_LEAD = FOOTER_TEXT.withoutNotes.replace(/\.$/, '');

/**
 * The footer's line with no notes, when the job has music: "Happy with it? Approve it from the
 * job's right-click menu to render the final video, with music v2." / "…, without music." Says what
 * Approve will render; while the song
 * is picked, that it renders two files (Songs). `null` for a job with no music: the line stays as it
 * was before Soundtrack.
 */
export function approveMusicLine(music: MusicView | null | undefined): string | null {
  if (music === null || music === undefined) return null;
  const label = musicButtonLabel(music);
  if (label === 'song') return SONG_TEXT.approveTwoFiles;
  if (label === 'off') return `${APPROVE_LEAD}, without music.`;
  if (label === 'from the folder') return `${APPROVE_LEAD}, with the music from the folder.`;
  if (label === 'series') return `${APPROVE_LEAD}, with the series’ music.`;
  return `${APPROVE_LEAD}, with music ${label}.`;
}

/** Approve waits while a version is being made (the engine refuses it with this): the button says why. */
export function musicMakingReason(
  music: Pick<MusicView, 'making'> | null | undefined,
): string | null {
  return music?.making ? `Music ${music.making.id} is still being made.` : null;
}

/**
 * The footer of a job that has music. With no notes it says what Approve will render ("…, with music
 * v2."); while a version is being made Approve waits, and the line says so. Send is not changed.
 * With Quick fixes on, a fix being made keeps its own line, and "Fixed here…" keeps its words (the
 * music still makes Approve wait).
 */
export function musicFooter(footer: FooterView, music: MusicView | null | undefined): FooterView {
  if (music === null || music === undefined || footer.action !== 'approve') return footer;
  // A fix being made comes first (the server answers with its words first): its line stays.
  if (footer.quickFix === 'busy') return footer;
  const waiting = musicMakingReason(music);
  if (waiting !== null) {
    return {
      ...footer,
      text: `${waiting} Approve when it is ready.`,
      disabled: true,
      disabledReason: waiting,
    };
  }
  // "Fixed here. Approve…" says what happened; the music's line is for the plain Approve.
  if (footer.quickFix === 'fixed') return footer;
  return { ...footer, text: approveMusicLine(music) ?? footer.text };
}

// --- when ------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A minute is "just now"; later it is the clock time. */
const JUST_NOW_MS = 60_000;

interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of an instant in `timeZone` (an IANA name) or, without one, the browser's own. */
function localParts(ms: number, timeZone: string | undefined): Local {
  const key = timeZone ?? '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(key, formatter);
  }
  const parts: Local = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of formatter.formatToParts(ms)) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day' ||
      part.type === 'hour' ||
      part.type === 'minute'
    ) {
      parts[part.type] = Number(part.value);
    }
  }
  // Some engines report midnight as 24 even with hourCycle h23.
  parts.hour %= 24;
  return parts;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * When a version was made, for the list's right column: "just now" for the first minute, then the
 * clock time in the viewer's zone ("23:58"), and with the day ("22 Oct, 23:58") when it is not today.
 * `timeZone` pins a zone (tests do); `''` for a time that cannot be read.
 */
export function musicWhen(madeAt: string, now: number, timeZone?: string): string {
  const then = Date.parse(madeAt);
  if (!Number.isFinite(then)) return '';
  if (now - then < JUST_NOW_MS) return 'just now';
  const at = localParts(then, timeZone);
  const today = localParts(now, timeZone);
  const time = `${pad2(at.hour)}:${pad2(at.minute)}`;
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
  return sameDay ? time : `${at.day} ${MONTHS[at.month - 1]}, ${time}`;
}

// --- the cut's shape -------------------------------------------------------------------------------

/** One part of the cut's shape: a section of the plan, its weight and where it starts. */
export interface MusicShapeBlock {
  name: string;
  /** Its length in ms: the block's weight on the strip. */
  ms: number;
  startMs: number;
  /** The biggest moment (the drop): drawn in the accent colour. */
  hot: boolean;
}

/** One word group of the caption: "drop at 0:18" is lit when it names the biggest moment. */
export interface MusicCaptionPart {
  text: string;
  hot: boolean;
}

export interface MusicShape {
  blocks: MusicShapeBlock[];
  /** The caption under the strip, in parts: "Build", "rise", "drop at 0:18" (lit), "golden", "logo at 0:35". */
  parts: MusicCaptionPart[];
  /** The same as one line: "Build, rise, drop at 0:18, golden, logo at 0:35". */
  caption: string;
  /** What a screen reader gets in place of the strip. */
  label: string;
}

/** Section names that mark the biggest moment of a track. */
const PEAK_NAME = /\b(drop|climax|peak|chorus|payoff|hook)\b/i;
/** Styles that do, when no name does. */
const PEAK_STYLE = /\b(drop|climax|peak)\b/i;

/**
 * The index of the biggest-moment section: the first whose name says so ("Drop"), else the first
 * whose styles do, else `null` (nothing is highlighted rather than a guess).
 */
export function peakSection(plan: Pick<MusicPlan, 'sections'>): number | null {
  const byName = plan.sections.findIndex((section) => PEAK_NAME.test(section.name));
  if (byName !== -1) return byName;
  const byStyle = plan.sections.findIndex((section) =>
    section.styles.some((style) => PEAK_STYLE.test(style)),
  );
  return byStyle === -1 ? null : byStyle;
}

/** "Build", "rise": the first word group starts with a capital, the others are lower case. */
function captionText(index: number, text: string): string {
  if (index > 0) return text.toLowerCase();
  return text.replace(/^./u, (first) => first.toUpperCase());
}

/**
 * The strip under the playing version and its caption, from the plan's sections: a block per
 * section as long as the section, the biggest moment lit, and "Build, rise, drop at 0:18, golden,
 * logo at 0:35" (the lit section and the last one say when they start).
 */
export function musicShape(plan: Pick<MusicPlan, 'sections'>): MusicShape | null {
  if (plan.sections.length === 0) return null;
  const hotIndex = peakSection(plan);
  let start = 0;
  const blocks = plan.sections.map((section, index): MusicShapeBlock => {
    const block = { name: section.name, ms: section.ms, startMs: start, hot: index === hotIndex };
    start += section.ms;
    return block;
  });
  const last = blocks.length - 1;
  const parts = blocks.map((block, index): MusicCaptionPart => {
    const says = index > 0 && (block.hot || index === last);
    const text = says ? `${block.name} at ${clock(block.startMs / 1000)}` : block.name;
    return { text: captionText(index, text), hot: block.hot };
  });
  const spans = blocks.map((block) => {
    const from = clock(block.startMs / 1000);
    const to = clock((block.startMs + block.ms) / 1000);
    return `${block.name.toLowerCase()} ${from} to ${to}`;
  });
  return {
    blocks,
    parts,
    caption: parts.map((part) => part.text).join(', '),
    label: `Written to the cut: ${spans.join(', ')}`,
  };
}

// --- songs -----------------------------------------------------------------------------------------

/** The header's line for a song: who asked for it and how it came, or that the editor picked it. */
export function songSourceLine(song: Pick<Song, 'asked' | 'trending'>): string {
  const { asked } = song;
  if (asked.from === 'trending' || asked.by === 'editor') {
    const niche = song.trending?.niche;
    return niche === undefined
      ? 'Picked by the editor · rising on Reels'
      : `Picked by the editor · rising on Reels in ${niche}`;
  }
  const you = asked.by === 'you';
  const who = you ? 'The song you asked for' : 'The song Yael asked for';
  switch (asked.from) {
    case 'screenshot':
      return `${who} · ${you ? 'from a screenshot' : 'from her screenshot'}`;
    case 'link':
      return `${who} · from a link`;
    case 'name':
    case 'note':
      return `${who} · from your note`;
  }
}

/** 18400 is "18.4K", 1250000 is "1.3M", 950 is "950". */
export function compactCount(count: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    count,
  );
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The song's part on a bar as long as the whole song: the part lit with its start and end under it
 * ("the part used · 0:42 to 1:21"), or all of it lit for a song no longer than the cut ("the whole
 * song"). A part the reel itself uses (`reel`, reserved for later) says so.
 */
export function songPartBar(song: Pick<Song, 'fullMs' | 'part'>): MusicPartBar {
  const full = Math.max(1, song.fullMs);
  const { part } = song;
  const to = clock(full / 1000);
  if (part.how === 'whole') {
    return {
      startPct: 0,
      widthPct: 100,
      from: clock(0),
      to,
      caption: 'the whole song',
      label: `The whole ${to} song is used`,
    };
  }
  const start = Math.min(Math.max(0, part.startMs), full);
  const end = Math.min(Math.max(start, part.endMs), full);
  const startPct = round1((start / full) * 100);
  const widthPct = Math.min(round1(((end - start) / full) * 100), round1(100 - startPct));
  const span = `${clock(start / 1000)} to ${clock(end / 1000)}`;
  const lead = part.how === 'reel' ? 'the part the reel uses' : 'the part used';
  return {
    startPct,
    widthPct,
    from: clock(0),
    to,
    caption: `${lead} · ${span}`,
    label: `${lead.replace(/^./u, (first) => first.toUpperCase())}: ${span} of the ${to} song`,
  };
}

/** Where a song came from, for its row's line. */
const SONG_WHERE: Record<SongSite, string> = {
  'youtube-music': 'YouTube Music, the studio track',
  youtube: 'YouTube',
  instagram: 'Instagram, the reel’s own audio',
  tiktok: 'TikTok, the video’s own audio',
};
const SONG_SITE_NAME: Record<SongSite, string> = {
  'youtube-music': 'YouTube Music',
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

/**
 * The song row's line: where it came from ("YouTube Music, the studio track."), or for a trending
 * pick what Instagram says about it ("In 18.4K reels. 3 of the top 20 #fpv reels this month use
 * it."), then that the cuts follow its beat, or, when the part has no beats (`part.beatCount` is 0:
 * a ballad), that they follow its accents. A record that never counted them (`beatCount` missing,
 * made before C73) keeps saying the beat.
 */
export function songLine(
  song: Pick<Song, 'source' | 'trending' | 'version'> & { part: Pick<Song['part'], 'beatCount'> },
): string {
  const { trending } = song;
  const facts: string[] = [];
  if (trending !== null) {
    if (trending.reels !== null && trending.reels > 0) {
      facts.push(`In ${compactCount(trending.reels)} ${trending.reels === 1 ? 'reel' : 'reels'}.`);
    }
    if (trending.nicheTop20 !== null && trending.nicheTop20 > 0) {
      facts.push(`${trending.nicheTop20} of the top 20 ${trending.niche} reels this month use it.`);
    }
  }
  const { site } = song.source;
  const other = song.version !== null && song.version !== 'original' ? song.version : null;
  const where = other === null ? SONG_WHERE[site] : `${SONG_SITE_NAME[site]}, ${other}`;
  const lead = facts.length > 0 ? facts.join(' ') : `${where}.`;
  const steady = song.part.beatCount === undefined || song.part.beatCount > 0;
  return `${lead} ${steady ? SONG_TEXT.beat : SONG_TEXT.noBeat}`;
}

/** What to do next, by why the song could not be got; '' when nothing the owner pastes would help. */
function songAsk(code: SongFailure['code']): string {
  switch (code) {
    case 'not_found':
    case 'unavailable':
    case 'blocked':
    case 'failed':
      return 'Paste a YouTube link or type the song’s name and the editor tries again when you press Send.';
    case 'no_trending':
      return 'Paste a link or type a song’s name and the editor tries again when you press Send.';
    default:
      return '';
  }
}

/**
 * The box above the list for a song that could not be got: amber with the record's own words for a
 * failure (ElevenLabs made the music instead), a plain one for "Original audio" (nothing to look up:
 * it asks for the reel's link) and for a missing Apify key. `null` without a failure.
 */
export function songAlert(failure: SongFailure | null): MusicAlert | null {
  if (failure === null) return null;
  if (failure.code === 'original_audio') {
    const account = /@[\w.]+/.exec(failure.asked)?.[0];
    const says = account === undefined ? 'Original audio' : `Original audio · ${account}`;
    return {
      tone: 'plain',
      title: SONG_TEXT.noNameTitle,
      text: `It says “${says}”, so there’s nothing to look up.`,
      ask: 'Paste that reel’s link and the editor takes the song from it.',
    };
  }
  if (failure.code === 'needs_key') {
    return {
      tone: 'plain',
      title: SONG_TEXT.needsKeyTitle,
      text: 'Add it to .env as APIFY_TOKEN.',
      ask: 'Or paste a YouTube link or type the song’s name, and the editor tries again when you press Send.',
    };
  }
  return {
    tone: 'amber',
    title: SONG_TEXT.failedTitle,
    text: failure.message,
    ask: songAsk(failure.code),
  };
}

// --- Another song: the notes it adds ---------------------------------------------------------------

/** What Another song or Pick a trending one adds to the Review notes. */
export interface SongNote {
  /** A name typed, a link pasted, or the editor's pick. */
  kind: 'name' | 'link' | 'trending';
  /** The note, word for word: "Use [name] instead.", "Use the song from [link] instead." */
  text: string;
}

/** The note Pick a trending one adds. */
export const TRENDING_NOTE: SongNote = { kind: 'trending', text: SONG_TEXT.trendingNote };

/** The sites whose links Another song takes without "https://" in front. */
const LINK_HOSTS =
  /^(?:[a-z0-9-]+\.)*(?:instagram\.com|tiktok\.com|youtube\.com|youtu\.be|spotify\.com|spotify\.link|music\.apple\.com|apple\.co)(?:[/?#:]|$)/i;

/** Whether what was typed is a link (one word with a scheme, "www.", or a known site) and not a song's name. */
export function isSongLink(text: string): boolean {
  const word = text.trim();
  if (word === '' || /\s/u.test(word)) return false;
  return /^(?:https?:\/\/|www\.)\S+$/i.test(word) || LINK_HOSTS.test(word);
}

/**
 * The note for what was typed in Another song: "Use נתתי לך בית instead." for a name, "Use the song
 * from [link] instead." for a link. `null` for nothing (blank).
 */
export function songNote(input: string): SongNote | null {
  const text = input.trim();
  if (text === '') return null;
  return isSongLink(text)
    ? { kind: 'link', text: `Use the song from ${text} instead.` }
    : { kind: 'name', text: `Use ${text} instead.` };
}

/**
 * The status line under the list once a note is added: what was added, word for word, and what
 * the editor does with it on Send. A trending pick names the client's niche when the client is known.
 */
export function songNotedText(note: SongNote, client: string | null): string {
  const head = `Added to your notes: “${note.text}”`;
  if (note.kind === 'trending') {
    const niche = client === null || client === '' ? 'the client’s niche' : `${client}’s niche`;
    return `${head} On Send, the editor picks one that’s rising on Reels in ${niche} and re-cuts the video to it.`;
  }
  return `${head} The editor re-cuts the video to it when you press Send.`;
}

// --- the list --------------------------------------------------------------------------------------

/** What a row of the list stands for. */
export type MusicRowKind = 'version' | 'file' | 'series' | 'off' | 'song';

/** The song's part on a bar as long as the whole song (board SGMusic: the part lit, the words under it). */
export interface MusicPartBar {
  /** Where the lit part starts and how wide it is, in percent of the bar (one decimal). */
  startPct: number;
  widthPct: number;
  /** The bar's ends: "0:00" and the song's length. */
  from: string;
  to: string;
  /** Between them: "the part used · 0:42 to 1:21", or "the whole song". */
  caption: string;
  /** What a screen reader gets in place of the bar. */
  label: string;
}

export interface MusicRow {
  /** What picking it sends: a version, `off`, the folder's file / the series' music, or `song`. */
  id: MusicPickId;
  kind: MusicRowKind;
  title: string;
  /** The song's artist, after the title; '' for every other row. */
  artist: string;
  /** The line under the title; '' for none. */
  describe: string;
  /** When it was made ("just now", "23:58"); '' for none. */
  when: string;
  checked: boolean;
  /** The one in the preview now: tagged "in the preview". */
  playing: boolean;
  /** The cut's shape, under the version that is playing. */
  shape: MusicShape | null;
  /** The part of the song the video uses, under the song when it is picked. */
  part: MusicPartBar | null;
  /** Can't be changed here: the series' music. */
  locked: boolean;
}

/** The row while a version is being made: at the top, before the versions. */
export interface MusicMakingRow {
  title: string;
  text: string;
  time: string;
}

/** The red box after a failed make. */
export interface MusicFailureBox {
  title: string;
  text: string;
}

/**
 * The box above the list when a song could not be got, or a screenshot had no song name (Songs):
 * `amber` for a failure with a fallback, `plain` for what is only a thing to ask.
 */
export interface MusicAlert {
  tone: 'amber' | 'plain';
  title: string;
  /** What happened, in the record's own words (or the plain box's). */
  text: string;
  /** What to do next, as its own line (it can be in another language than `text`); '' when nothing the owner pastes would help. */
  ask: string;
}

/** The two tabs of the box under the list when Songs are on, and the words of Another song. */
export interface MusicSongBox {
  /** The tab labels: "Another song" / "Make music instead", or "Use a song" / "Make another". */
  tabs: { song: string; make: string };
  /** The Another song tab: its field, its button, the trending button and the hint under them. */
  song: {
    label: string;
    placeholder: string;
    button: string;
    trendButton: string;
    trendAdded: string;
    hint: string;
  };
  /** The Make tab's field (its button and hint are the form's). */
  makeField: { label: string; placeholder: string };
}

/** The form under the list. */
export interface MusicMakeForm {
  /** The words above the field. */
  label: string;
  /** The button: "Make v3", "Make one", "Making…". */
  button: string;
  hint: string;
  /** A version is being made. */
  busy: boolean;
}

export interface MusicListModel {
  /** The header's second line: "Made for this video by ElevenLabs · 0:39". */
  source: string;
  /** Songs: why there is no song, above the list. */
  alert: MusicAlert | null;
  making: MusicMakingRow | null;
  rows: MusicRow[];
  failure: MusicFailureBox | null;
  /** A line under the rows ("The video plays and renders without music…"). */
  note: string | null;
  /** `null` for a series episode: its music is the series'. */
  make: MusicMakeForm | null;
  /** Songs on (and not an episode): the box has two tabs, Another song and Make. Else `null`: the form alone, as before Songs. */
  songBox: MusicSongBox | null;
  /** A series episode's box in place of the form. */
  seriesBox: string | null;
}

export interface MusicListOptions {
  /** Epoch ms, for "just now". */
  now: number;
  /** Pins the zone of the times (tests). */
  timeZone?: string;
  /** "Episode 6 of <series>" and the series' name, for an episode; `null` until they are known. */
  series?: { line: string; name: string | null } | null;
  /** Songs are on (`/api/health`'s `songs`): the alerts, the tabs and Another song. Default off: the list is as it was. */
  songs?: boolean;
}

/** The last part of a path: "audio/Summer Vibes.mp3" is "Summer Vibes.mp3". */
function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function lengthOf(music: MusicView): number | null {
  const picked = pickedVersion(music);
  const ms = music.plan?.lengthMs ?? picked?.lengthMs ?? music.versions.at(-1)?.lengthMs ?? null;
  return ms !== null && ms > 0 ? ms : null;
}

function sourceLine(music: MusicView, series: MusicListOptions['series']): string {
  // While the song plays the header says where it came from, whatever the record's source says.
  const playing = pickedSong(music);
  if (playing !== null) return songSourceLine(playing);
  switch (music.source) {
    case 'supplied':
      return 'From the folder';
    case 'series':
      return series?.line ?? 'From the series';
    case 'none':
      // Nobody asked for music (U21): said in plain words, not as a rule.
      if (musicWasNotAsked(music)) return `${MUSIC_TEXT.notAsked}. ${MUSIC_TEXT.notAskedNothing}`;
      return music.reason === null ? 'None.' : `None. ${music.reason}`;
    case 'song':
      // Only a record from a run with `songs` on has it; No music picked leaves the song's line.
      return music.song === null ? 'The song asked for' : songSourceLine(music.song);
    case 'made': {
      const ms = lengthOf(music);
      const made = 'Made for this video by ElevenLabs';
      return ms === null ? made : `${made} · ${formatMusicLength(ms)}`;
    }
  }
}

/** Newest first: v3, v2, v1. */
function newestFirst(versions: readonly MusicVersion[]): MusicVersion[] {
  return [...versions].sort(
    (a, b) => (musicVersionNumber(b.id) ?? 0) - (musicVersionNumber(a.id) ?? 0),
  );
}

function makingRow(music: MusicView): MusicMakingRow | null {
  const { making } = music;
  if (making === null) return null;
  const playing = pickedVersion(music);
  const head =
    making.ask !== null
      ? `Making it: ${making.ask}.`
      : music.versions.length > 0
        ? 'Making another take.'
        : 'Making the music for this video.';
  let tail = '';
  if (playing !== null) {
    tail = making.ask !== null ? `${playing.id} keeps playing.` : 'The current one keeps playing.';
  } else if (music.picked === 'file') {
    tail = 'The folder’s music keeps playing.';
  }
  return {
    title: making.id,
    text: tail === '' ? head : `${head} ${tail}`,
    time: MUSIC_TEXT.makingTime,
  };
}

function failureBox(music: MusicView): MusicFailureBox | null {
  const { failure } = music;
  if (failure === null || music.making !== null) return null;
  const playing = pickedVersion(music);
  const parts: string[] = [failure.message];
  if (playing !== null) parts.push(`${playing.id} stays in the video.`);
  else if (music.picked === 'off' || music.picked === null) {
    parts.push('The video stays without music.');
  }
  if (failure.code === 'no_credits') {
    parts.push('Credits come back when your plan renews, or top up on elevenlabs.io.');
  }
  return { title: `Couldn’t make ${failure.id}`, text: parts.join(' ') };
}

/**
 * Everything the list shows, from the job's music: the header's source line, the making row, the
 * rows (versions newest first, the folder's file, the series' music, No music), the failure box, the
 * note under the rows, and the form (or, for a series episode, the box that stands for it).
 */
export function musicListModel(music: MusicView, options: MusicListOptions): MusicListModel {
  const { now, timeZone, series = null, songs = false } = options;
  const shape = music.plan === null ? null : musicShape(music.plan);
  const rows: MusicRow[] = [];
  const { song } = music;

  if (music.source === 'series') {
    rows.push({
      id: 'series',
      kind: 'series',
      title: MUSIC_TEXT.seriesTitle,
      artist: '',
      describe:
        series?.name != null
          ? `Theme from ${series.name}, the same in every episode.`
          : 'The same in every episode.',
      when: '',
      checked: true,
      playing: true,
      shape: null,
      part: null,
      locked: true,
    });
  } else {
    // The song Yael asked for comes first, with the part of it the video uses; the versions ElevenLabs
    // made list under it as before.
    if (song !== null) {
      const checked = music.picked === 'song';
      rows.push({
        id: 'song',
        kind: 'song',
        title: song.title,
        artist: song.artist,
        describe: songLine(song),
        when: '',
        checked,
        playing: checked,
        shape: null,
        part: checked ? songPartBar(song) : null,
        locked: false,
      });
    }
    for (const version of newestFirst(music.versions)) {
      const checked = music.picked === version.id;
      rows.push({
        id: version.id,
        kind: 'version',
        title: version.id,
        artist: '',
        describe: version.describe,
        when: musicWhen(version.madeAt, now, timeZone),
        checked,
        playing: checked,
        shape: checked ? shape : null,
        part: null,
        locked: false,
      });
    }
    // The folder's file stays an option after a version was made instead (it is still in the folder).
    if (music.file !== null) {
      const checked = music.picked === 'file';
      rows.push({
        id: 'file',
        kind: 'file',
        title: fileName(music.file),
        artist: '',
        describe: MUSIC_TEXT.fromFolder,
        when: '',
        checked,
        playing: checked,
        shape: null,
        part: null,
        locked: false,
      });
    }
    rows.push({
      id: 'off',
      kind: 'off',
      title: MUSIC_TEXT.noMusic,
      artist: '',
      describe: '',
      when: '',
      checked: music.picked === 'off' || music.picked === null,
      playing: false,
      shape: null,
      part: null,
      locked: false,
    });
  }

  const noneYet = music.source === 'supplied' || music.source === 'none';
  // Nobody asked for music (U21): the form makes some for the first time, so it is not "instead".
  const notAsked = musicWasNotAsked(music);
  const next = music.making?.id ?? nextVersionId(music);
  const busy = music.making !== null;
  // Songs on: the box has the board's tabs, and the Make tab the board's words (a song in the list, or
  // nothing made yet, makes it "Make one" under "Make music instead").
  const withSongs = songs && music.source !== 'series';
  const hasSong = song !== null;
  const insteadOf = hasSong || noneYet;
  const make: MusicMakeForm | null =
    music.source === 'series'
      ? null
      : {
          label: notAsked
            ? MUSIC_TEXT.makeNotAsked
            : noneYet
              ? MUSIC_TEXT.makeInstead
              : MUSIC_TEXT.makeAnother,
          button: busy
            ? MUSIC_TEXT.making
            : (withSongs ? insteadOf : noneYet)
              ? MUSIC_TEXT.makeOne
              : `Make ${next}`,
          hint: withSongs
            ? SONG_TEXT.makeHint
            : noneYet
              ? MUSIC_TEXT.hintInstead
              : MUSIC_TEXT.hintAnother,
          busy,
        };
  const songBox: MusicSongBox | null = withSongs
    ? {
        tabs: {
          song: hasSong ? SONG_TEXT.tabAnother : SONG_TEXT.tabUse,
          make: notAsked
            ? SONG_TEXT.tabMakeNew
            : insteadOf
              ? SONG_TEXT.tabMake
              : SONG_TEXT.tabMakeAnother,
        },
        song: {
          label: SONG_TEXT.fieldLabel,
          placeholder: SONG_TEXT.fieldHint,
          button: SONG_TEXT.addToNotes,
          trendButton: SONG_TEXT.trend,
          trendAdded: SONG_TEXT.trendAdded,
          hint: SONG_TEXT.anotherHint,
        },
        makeField: { label: SONG_TEXT.makeFieldLabel, placeholder: MUSIC_TEXT.askPlaceholder },
      }
    : null;

  let note: string | null = null;
  if (music.picked === 'off' && music.source !== 'none') {
    note =
      song !== null
        ? SONG_TEXT.offNote
        : music.source === 'supplied'
          ? 'The video plays and renders without music. Pick the file to bring it back.'
          : 'The video plays and renders without music. Pick a version to bring it back.';
  } else if (music.picked === 'song') {
    note = SONG_TEXT.twoFiles;
  }

  return {
    source: sourceLine(music, series),
    alert: songs ? songAlert(music.songFailure) : null,
    making: makingRow(music),
    rows,
    failure: failureBox(music),
    note,
    make,
    songBox,
    seriesBox: music.source === 'series' ? MUSIC_TEXT.seriesBox : null,
  };
}

/**
 * What a Retry asks for: the words of the make that failed, found from what the page sent (the
 * record forgets the words once a make fails). Only a make whose answer was this failure's version
 * counts; a failure from the edit run, or from an older session, retries with no words.
 */
export function retryAsk(
  failedId: string | null,
  sent: ReadonlyArray<{ ask: string | undefined; madeId: string | null }>,
): string | undefined {
  if (failedId === null) return undefined;
  for (let index = sent.length - 1; index >= 0; index--) {
    const make = sent[index];
    if (make?.madeId === failedId) return make.ask;
  }
  return undefined;
}
