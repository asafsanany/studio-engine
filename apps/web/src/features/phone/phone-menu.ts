// The phone job sheet's list of rows (boards MJobSheet*, canvas page Mobile): the entries of the
// row's right-click menu (`rowMenuEntries`), the same ones the Mac's ⋯ menu draws, as rows 48 px
// tall. One list of entries serves three places; this file only decides which of them the phone
// shows and how each is drawn. Pure, so every state is tested without a browser.

import { DEFAULT_EFFORT, effortLabel, type Job } from '@studio/shared';
import { Download, Loader2, type LucideIcon, RotateCcw, Share } from 'lucide-react';
import { gaugeIcon } from '@/components/effort-gauge';
import { type SheetSongFiles, SONG_SHEET_TEXT } from '@/features/job-sheet/sheet-songs';
import { nextStepAction } from '@/features/jobs/cells/row-actions';
import { EFFORT_DEFAULT_ID, effortOfOption } from '@/features/jobs/effort-options';
import type { JobMenuEntry, RowMenuItem, RowMenuSubmenu } from '@/features/jobs/row-menu';
import { SERIES_SUBMENU_ID } from '@/features/series/series-menu';
import {
  gettingLabel,
  SHARE_FAILED_REASON,
  SHARE_UNSUPPORTED_REASON,
  type ShareFlow,
  type ShareTarget,
} from './share-video';

/** What the Effort sub-view says under its title (board MJobSheetEffort). */
export const EFFORT_SUBMENU_HINT = 'How hard the editor works on this video. Higher takes longer.';

/**
 * Every series entry stays on the Mac (boards MJobSheet*, none of which has one): Start a series,
 * Use as the series format, the Series submenu, Open the series and Take out of the series. The
 * phone shows a series (the mark, the sheet's line, the notes' toggles); it does not manage one.
 */
function isSeriesEntry(id: string): boolean {
  return id === SERIES_SUBMENU_ID || id.startsWith('series-');
}

/** The entry that copies the error: the error box has its own Copy error. */
const COPY_ERROR = 'copy';

/**
 * Rename… stays on the Mac too: it is a right-click item with a dialog, and none of the phone's
 * boards has a rename.
 */
const RENAME = 'rename';

/**
 * Note and Effort, which the job locks (the edit has read the note and settled on its level; a ready
 * job is past both). The Mac keeps them in the menu, disabled. The boards leave them out (the
 * Editing board's list is Cancel… alone) and the sheet says the level in Details.
 */
const LOCKED_LEAVES: ReadonlySet<string> = new Set(['note', 'effort']);

/** A choice of a sub-view: a radio row with its hint on the right and a check on the current one. */
export interface PhoneSubmenuOption {
  id: string;
  label: string;
  hint: string;
  /** In front of the label: a gauge at the level's needle for Effort; none for the rest. */
  icon: LucideIcon | null;
  checked: boolean;
  /** A 1 px rule goes above this row (after Default). */
  ruleAbove: boolean;
}

/**
 * The sub-view a row with a submenu opens inside the sheet: "‹ Effort", a line of help (Effort's),
 * then the choices. Choosing one calls `onPick`; the sheet goes back to the list by itself.
 */
export interface PhoneSubmenuView {
  title: string;
  hint: string | null;
  options: readonly PhoneSubmenuOption[];
  onPick: (optionId: string) => void;
}

interface PhoneRowBase {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Drawn at 50% (the sheet still says why under the label when there is a reason). */
  disabled: boolean;
}

/** A row that does something when tapped, or (with `href`) a link: Download MP4. */
export interface PhoneItemRow extends PhoneRowBase {
  kind: 'item';
  /** A name that belongs to the person inside `label`, drawn in its own direction. */
  bidi?: string;
  /** Red: Cancel…. */
  destructive: boolean;
  /** Why it is disabled, under the label; `null` for none. */
  reason: string | null;
  href: string | null;
  onSelect: () => void;
  /**
   * A line under the label that is not a reason (Songs: "With the song · to show the client · 0:39",
   * or why the file without the song is not there, in red with `detailTone`); left out for none.
   */
  detail?: string;
  detailTone?: 'failure';
  /** Something is being made: a spinner, the label, and nothing to press (Songs: the second file). */
  busy?: boolean;
}

/** A row that opens a sub-view: Effort. */
export interface PhoneSubmenuRow extends PhoneRowBase {
  kind: 'submenu';
  /** The muted value before the chevron: the choice in use ("Default · Extra high", "High"). */
  value: string;
  view: PhoneSubmenuView;
}

export type PhoneMenuRow = PhoneItemRow | PhoneSubmenuRow;

/** "Default · Extra high" for the choice that says its level, the label for the others. */
function currentValue(entry: RowMenuSubmenu): string {
  const current = entry.options.find((option) => option.id === entry.value);
  if (current === undefined) return entry.trailing ?? '';
  // Default says the level it runs at; the levels' own hints ("slower") are only for choosing.
  return entry.id === 'effort' && current.id === EFFORT_DEFAULT_ID
    ? `${current.label} · ${current.hint}`
    : current.label;
}

function submenuRow(entry: RowMenuSubmenu): PhoneSubmenuRow {
  return {
    kind: 'submenu',
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    disabled: entry.disabled === true,
    value: currentValue(entry),
    view: {
      title: entry.label,
      // A submenu says its own line of help; Effort without one has the phone's.
      hint:
        entry.help !== undefined ? entry.help : entry.id === 'effort' ? EFFORT_SUBMENU_HINT : null,
      options: entry.options.map((option, index) => ({
        id: option.id,
        label: option.label,
        hint: option.hint,
        // An option brings its own icon (Auto's sparkles, a review level's gauge); the edit's Effort draws a gauge per level.
        icon: option.icon ?? (entry.id === 'effort' ? gaugeIcon(effortOfOption(option.id)) : null),
        checked: option.id === entry.value,
        ruleAbove: index > 0 && entry.options[index - 1]?.separatorAfter === true,
      })),
      onPick: entry.onValueChange,
    },
  };
}

function itemRow(entry: RowMenuItem): PhoneItemRow {
  return {
    kind: 'item',
    id: entry.id,
    label: entry.label,
    ...(entry.bidi === undefined ? {} : { bidi: entry.bidi }),
    icon: entry.icon,
    destructive: entry.destructive === true,
    disabled: entry.disabled === true,
    reason: entry.disabled === true ? (entry.disabledReason ?? null) : null,
    href: entry.href ?? null,
    onSelect: entry.onSelect,
  };
}

/** Where the job's share flow is, for the row that replaces Download MP4 (`phoneMenuRows`). */
export interface PhoneShareMenu {
  flow: ShareFlow;
  target: ShareTarget;
  /** Tapped on the row: starts getting the video, or opens the share sheet once it is in hand. */
  onShare: () => void;
}

/**
 * The row that replaces Download MP4 on the phone (U16), by where the share flow is:
 *
 * - not asked yet or in hand: Share video; the tap fetches the video, or opens the share sheet
 * - on its way: "Preparing the video · 12 of 27 MB" (the tap does nothing until it is in hand)
 * - a browser that can't share a file, or a fetch that failed: Download MP4 (the Mac's link), with
 *   the reason under it
 */
export function shareMenuRow(share: PhoneShareMenu): PhoneItemRow {
  const { flow, target } = share;
  const base = { kind: 'item', id: 'share', destructive: false, disabled: false } as const;
  if (flow.phase === 'unsupported' || flow.phase === 'failed') {
    return {
      ...base,
      id: 'download',
      label: 'Download MP4',
      icon: Download,
      reason:
        flow.phase === 'failed' ? SHARE_FAILED_REASON(flow.message) : SHARE_UNSUPPORTED_REASON,
      href: target.url,
      onSelect: () => {},
    };
  }
  const getting =
    flow.phase === 'getting' ? gettingLabel(flow.loaded, flow.total, 'Preparing').label : null;
  return {
    ...base,
    label: getting ?? 'Share video',
    icon: Share,
    reason: null,
    href: null,
    onSelect: share.onShare,
  };
}

/**
 * The menu entry the sheet's big button already is: the Mac's next step, except Mark delivered,
 * which stays in the list while the button is Share video (Mobile 4), for a video sent another way.
 */
function buttonEntry(job: Job): string | null {
  const next = nextStepAction(job)?.kind ?? null;
  return next === 'deliver' ? null : next;
}

/**
 * The phone's rows from a job's menu entries, in the menu's order:
 *
 * - Left out because the sheet already has them: the entry the big button is (`button`; by
 *   default the next step: Release, Retry from Render, Review, Mark paid…; an Approved job's
 *   button is Share video, so Mark delivered stays, and when the phone can't share, the button is
 *   Download MP4, which the sheet passes) and Copy error (the error box).
 * - Left out because they stay on the Mac: every series entry (see {@link isSeriesEntry}) and
 *   Rename…. (Show in Finder is not in the menu.)
 * - Left out because the job has locked them: Add note… / Effort when disabled (see
 *   {@link LOCKED_LEAVES}). Any other disabled row stays, at 50%, with its reason under the label.
 * - The Mac's lines between groups are left out: the boards' list is flat, one 48 px row after the
 *   other.
 * - A submenu (Effort) is a row with the choice in use at its end; it opens a sub-view.
 * - Download MP4 is the Mac's. With `share` (the phone), an Approved job's goes (its big button is
 *   Share video) and a Delivered or Paid job's becomes the Share video row (`shareMenuRow`), which
 *   is a Download MP4 link again only where the browser can't share a file.
 * - With `songRows` (a video whose music is a song, Songs: `songFileRows`) Download MP4 is replaced
 *   by the two files' rows, after the Share video row of a Delivered or Paid job.
 *
 * `job` says which entry is the next step when `button` is not given.
 */
export function phoneMenuRows(
  entries: readonly JobMenuEntry[],
  job: Job,
  button: string | null = buttonEntry(job),
  share: PhoneShareMenu | null = null,
  songRows: readonly PhoneItemRow[] | null = null,
): PhoneMenuRow[] {
  const rows: PhoneMenuRow[] = [];
  for (const entry of entries) {
    if (entry.type === 'separator') continue;
    if (
      entry.id === button ||
      entry.id === COPY_ERROR ||
      entry.id === RENAME ||
      isSeriesEntry(entry.id)
    ) {
      continue;
    }
    if (entry.id === 'download' && songRows !== null) {
      // A video with a song has two files (Songs): Download MP4 becomes one row for each, after
      // the Share video row where there is one (a Delivered or Paid job; an Approved job's is the
      // big button).
      if (share !== null && nextStepAction(job)?.kind !== 'deliver') rows.push(shareMenuRow(share));
      rows.push(...songRows);
      continue;
    }
    if (entry.id === 'download' && share !== null) {
      if (nextStepAction(job)?.kind !== 'deliver') rows.push(shareMenuRow(share));
      continue;
    }
    // The sheet already has a View preview button beside its next step. Approved uses Share
    // instead of NowButtons, so its preview stays in the list.
    if (entry.id === 'view-preview' && nextStepAction(job)?.kind !== 'deliver') continue;
    if (entry.disabled === true && LOCKED_LEAVES.has(entry.id)) continue;
    rows.push(entry.type === 'submenu' ? submenuRow(entry) : itemRow(entry));
  }
  return rows;
}

/** The level a job with Default effort runs at, for the Details row ("Default · Extra high"). */
export function effortDetail(job: Pick<Job, 'effort'>): string {
  return job.effort === null ? `Default · ${effortLabel(DEFAULT_EFFORT)}` : effortLabel(job.effort);
}

// --- the song's two files (Songs, SG9) ------------------------------------------------------------

/** What Try again needs: the press, and whether the engine has not answered the last one. */
export interface SongRetry {
  onTryAgain: () => void;
  pending: boolean;
}

/** A Download row of a file: its name, "With the song · to show the client · 0:39" under it. */
function songDownloadRow(file: {
  id: string;
  name: string;
  sub: string;
  href: string;
}): PhoneItemRow {
  return {
    kind: 'item',
    id: file.id === 'with-song' ? 'download' : 'download-no-song',
    label: file.name,
    detail: file.sub,
    icon: Download,
    destructive: false,
    disabled: false,
    reason: null,
    href: file.href,
    onSelect: () => {},
  };
}

/**
 * The rows that stand in for Download MP4 on a video with a song (board SGSheet, Files, as list
 * rows): a Download row for the file with the song, then the second file by where it stands: a
 * Download row, "Making the file without the song…" with a spinner, or Try again with the reason
 * in red under it. `[]` for a job whose sheet is plain.
 */
export function songFileRows(files: SheetSongFiles, retry: SongRetry): PhoneItemRow[] {
  if (files.kind !== 'files') return [];
  const { noSong } = files;
  const second = ((): PhoneItemRow => {
    switch (noSong.state) {
      case 'ready':
        return songDownloadRow(noSong.file);
      case 'making':
        return {
          kind: 'item',
          id: 'no-song-making',
          label: SONG_SHEET_TEXT.making,
          icon: Loader2,
          destructive: false,
          disabled: false,
          reason: null,
          href: null,
          onSelect: () => {},
          busy: true,
        };
      case 'failed':
        return {
          kind: 'item',
          id: 'no-song-retry',
          label: SONG_SHEET_TEXT.tryAgain,
          detail: noSong.message,
          detailTone: 'failure',
          icon: RotateCcw,
          destructive: false,
          disabled: retry.pending,
          reason: null,
          href: null,
          onSelect: retry.onTryAgain,
        };
    }
  })();
  return [songDownloadRow(files.withSong), second];
}
