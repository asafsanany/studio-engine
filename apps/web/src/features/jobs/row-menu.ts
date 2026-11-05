import {
  canArchive,
  canEditEffort,
  canEditNote,
  canRename,
  type Effort,
  effortLabel,
  isArchived,
  isFolderDeleted,
  type Job,
  jobStage,
  renameBlockedReason,
} from '@studio/shared';
import {
  Archive,
  ArchiveRestore,
  Check,
  History,
  type LucideIcon,
  MessageSquarePlus,
  MessageSquareText,
  Palette,
  Pencil,
  Trash2,
} from 'lucide-react';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { ROW_ACTION_ICONS } from '@/components/jobs/IconAction';
import { askForVersions } from '@/features/job-sheet/job-sheet-section';
import { canViewPreview, openPreview } from '@/features/review/preview-viewer';
import { openReview } from '@/features/review/review-dialog';
import {
  NO_SERIES_MENU,
  type SeriesMenuContext,
  seriesMenuEntries,
} from '@/features/series/series-menu';
import {
  approveAction,
  menuActions,
  REVIEW_LABELS,
  type RowAction,
  STAGE_LABELS,
  stageUndoAction,
} from './cells/row-actions';
import type { RowActions } from './cells/use-row-actions';
import { copyError } from './copy-error';
import { askToDelete } from './delete-job-dialog';
import {
  EFFORT_OPTIONS,
  effortOfOption,
  optionIdOf,
  REVIEW_EFFORT_WORDS,
  REVIEW_ROW_EFFORT_OPTIONS,
  reviewChoiceOf,
  reviewEffortOf,
} from './effort-options';
import { askToMarkPaid } from './mark-paid/request';
import { askForNote } from './note-dialog';
import { askToRename } from './rename-job-dialog';
import { askToUseLook } from './use-look/use-look-dialog';

/** One item of a row's right-click menu. */
export interface RowMenuItem {
  type: 'item';
  /** Stable within a menu: the React key. */
  id: string;
  /** The text and the accessible name: "Hold", "Retry from Render", "Cancel…". */
  label: string;
  /**
   * A name inside `label` that belongs to the person (a client, in Hebrew, Latin or mixed): drawn
   * in a `<bdi>`, so it keeps its own direction inside the English words around it.
   */
  bidi?: string;
  /** Drawn muted in front of the label (red for a destructive item). */
  icon: LucideIcon;
  /** Red: Cancel…. */
  destructive?: boolean;
  disabled?: boolean;
  /** Why the item is disabled, said as its tooltip (the item still takes the pointer, to say it). */
  disabledReason?: string;
  /** A link instead of a button: Download MP4 hands the browser the file. */
  href?: string;
  /** Runs when the item is chosen. The menu closes by itself afterwards. */
  onSelect: () => void;
}

export interface RowMenuSeparator {
  type: 'separator';
  id: string;
}

export type RowMenuEntry = RowMenuItem | RowMenuSeparator;

/** One choice of a submenu: a radio item with a muted hint at its end. */
export interface RowMenuOption {
  id: string;
  label: string;
  hint: string;
  /** A line goes under this option. */
  separatorAfter?: boolean;
  /** Drawn in front of the label by the phone's sub-view (the Mac's list has no icons): Effort's gauge or sparkles. */
  icon?: LucideIcon;
}

/**
 * An item of a job's menu that opens a list of choices, one checked: "Effort ▸". The levels are
 * drawn by `RowMenuSubmenuView`. Only a job's menu has them (a client's menu does not), so they are
 * not part of `RowMenuEntry`.
 */
export interface RowMenuSubmenu {
  type: 'submenu';
  id: string;
  label: string;
  /** Drawn muted in front of the label. */
  icon: LucideIcon;
  disabled?: boolean;
  /** Muted text at the end of the item (the choice in use); `null` for none. */
  trailing: string | null;
  options: readonly RowMenuOption[];
  /**
   * The line of help the phone's sub-view says under its title; `null` for none. Left out, Effort
   * has the phone's own line (`EFFORT_SUBMENU_HINT`) and the others none.
   */
  help?: string | null;
  /** The id of the checked option. */
  value: string;
  /** Runs with the id of the option that was chosen. */
  onValueChange: (id: string) => void;
}

/** What a job's menu is made of: the shared items and lines, and the submenus. */
export type JobMenuEntry = RowMenuEntry | RowMenuSubmenu;

/**
 * "Effort ▸" (a gauge whose needle sits at the job's level): the levels the job's edit and revise
 * runs can use, with a check on the one in use and, at the end of the item, its name when it is
 * not Default. It is disabled exactly when `canEditEffort` says the server would refuse: once the
 * edit has started and when the job is ready.
 */
export function effortMenuEntry(
  job: Job,
  setEffort: (effort: Effort | null) => void,
): RowMenuSubmenu {
  return {
    type: 'submenu',
    id: 'effort',
    label: 'Effort',
    icon: gaugeIcon(job.effort),
    disabled: !canEditEffort(job),
    trailing: job.effort === null ? null : effortLabel(job.effort),
    options: EFFORT_OPTIONS,
    value: optionIdOf(job.effort),
    onValueChange: (id) => setEffort(effortOfOption(id)),
  };
}

/** The choices of a review job's "Effort ▸", each with the icon the phone's sub-view draws: sparkles for Auto, a gauge for a level. */
const REVIEW_ROW_OPTIONS: readonly RowMenuOption[] = REVIEW_ROW_EFFORT_OPTIONS.map((option) => ({
  ...option,
  icon: effortIcon(option.id),
}));

/**
 * "Effort ▸" of a job in Review while Quick fixes are on (board "Effort with Auto"): the level of
 * the job's review rounds, not of its edit. It starts with Auto (Default), a line, then the three
 * levels; the icon is sparkles for Auto and the level's gauge otherwise, and the item says the
 * level at its end unless it is Auto. The server takes the change only in Review, which is the only
 * state this entry is for, so it is never disabled.
 */
export function reviewEffortMenuEntry(
  job: Job,
  setReviewEffort: (effort: Effort | null) => void,
): RowMenuSubmenu {
  return {
    type: 'submenu',
    id: 'effort',
    label: 'Effort',
    icon: effortIcon(reviewChoiceOf(job.reviewEffort)),
    disabled: false,
    trailing: job.reviewEffort === null ? null : effortLabel(job.reviewEffort),
    options: REVIEW_ROW_OPTIONS,
    help: REVIEW_EFFORT_WORDS.autoSub,
    value: reviewChoiceOf(job.reviewEffort),
    onValueChange: (id) => setReviewEffort(reviewEffortOf(id)),
  };
}

/**
 * "Rename…": asks the page for the "Rename this video" dialog (`RenameJobDialogHost`). The video's
 * folder and export are renamed with it, so it is disabled, with the reason as its tooltip, exactly
 * when `canRename` says the server would refuse: while the job is arriving, queued or editing.
 */
export function renameMenuEntry(job: Job): RowMenuItem {
  const allowed = canRename(job);
  return {
    type: 'item',
    id: 'rename',
    label: 'Rename…',
    icon: Pencil,
    disabled: !allowed,
    ...(allowed ? {} : { disabledReason: renameBlockedReason(job) }),
    onSelect: () => askToRename(job),
  };
}

/**
 * The entries that go before the row's actions, with their separator: the note ("Add note…", or
 * "Edit note…" once the job has one), then "Rename…", then "Effort ▸" (when the caller can set it), then a line. The item asks the page for the "Note for the
 * editor" dialog (`NoteDialogHost`); it is disabled while the job is editing (the edit has already
 * read the note) and once it is ready, exactly when `canEditNote` says the server would refuse.
 */
export function leadingMenuEntries(
  job: Job,
  setEffort?: (effort: Effort | null) => void,
  setReviewEffort?: (effort: Effort | null) => void,
): JobMenuEntry[] {
  const hasNote = job.note !== null;
  // With Quick fixes on (the caller gives `setReviewEffort`) a job in Review sets its review rounds' level.
  const effort =
    setReviewEffort !== undefined && job.state === 'review'
      ? reviewEffortMenuEntry(job, setReviewEffort)
      : setEffort === undefined
        ? null
        : effortMenuEntry(job, setEffort);
  return [
    {
      type: 'item',
      id: 'note',
      label: hasNote ? 'Edit note…' : 'Add note…',
      icon: hasNote ? MessageSquareText : MessageSquarePlus,
      disabled: !canEditNote(job),
      onSelect: () => askForNote(job),
    },
    renameMenuEntry(job),
    ...(effort === null ? [] : [effort]),
    { type: 'separator', id: 'note-separator' },
  ];
}

/**
 * A job with a preview starts with Review… while in Review, or View preview… elsewhere. Given the
 * row's actions (`approve`: the Mac's right-click menu and the phone's sheet, never the Mac sheet's
 * ⋯), a job in Review has Approve next (`approveAction`). With the job sheet on (`versions`)
 * "Versions…" follows: it opens the sheet at its Versions part, where the cuts the job has been
 * through are. The note item comes after (disabled in Review: `canEditNote` is false).
 */
export function reviewMenuEntries(
  job: Job,
  versions = false,
  approve?: Pick<RowActions, 'run' | 'busy'>,
): RowMenuEntry[] {
  if (job.state !== 'review' && !canViewPreview(job)) return [];
  const approval = approve === undefined ? null : approveAction(job);
  return [
    {
      type: 'item',
      id: job.state === 'review' ? 'review' : 'view-preview',
      label: job.state === 'review' ? REVIEW_LABELS.menu : 'View preview…',
      icon: ROW_ACTION_ICONS.review,
      onSelect: () => (job.state === 'review' ? openReview(job.id) : openPreview(job.id)),
    },
    ...(approval === null || approve === undefined ? [] : [entryFor(job, approval, approve)]),
    ...(versions
      ? [
          {
            type: 'item',
            id: 'versions',
            label: 'Versions…',
            icon: History,
            onSelect: () => askForVersions(job.id),
          } satisfies RowMenuItem,
        ]
      : []),
    { type: 'separator', id: 'review-separator' },
  ];
}

/**
 * "Use this look for <client>…" (a palette), for an approved job: the item asks the page for the
 * "Use this look" dialog (`UseLookDialogHost`). When the client's current look already comes from
 * this job (`currentLookJobId`, read from the client's style when the menu opens) there is nothing
 * to ask, so the item is disabled, with a check, and says so. Every other job has none: a delivered
 * or paid one offers the way back from its stage instead (`stageMenuEntries`).
 */
export function lookMenuEntries(job: Job, currentLookJobId: string | null): RowMenuEntry[] {
  if (jobStage(job) !== 'approved') return [];
  if (currentLookJobId === job.id) {
    return [
      {
        type: 'item',
        id: 'use-look',
        label: `${job.client}’s look comes from this job`,
        bidi: job.client,
        icon: Check,
        disabled: true,
        onSelect: () => {},
      },
    ];
  }
  return [
    {
      type: 'item',
      id: 'use-look',
      label: `Use this look for ${job.client}…`,
      bidi: job.client,
      icon: Palette,
      onSelect: () => askToUseLook(job),
    },
  ];
}

/**
 * No line follows another line, and none ends the menu. A review job has no action between the
 * note's line and the archive group's, and a job with nothing after the note has no last line.
 */
function tidySeparators(entries: JobMenuEntry[]): JobMenuEntry[] {
  const tidy: JobMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'separator' && tidy.at(-1)?.type === 'separator') continue;
    tidy.push(entry);
  }
  return tidy.at(-1)?.type === 'separator' ? tidy.slice(0, -1) : tidy;
}

/** What the menu needs to know about the other jobs when it opens: for "Archive all paid · N". */
export interface ArchiveMenuContext {
  /** The ids of the paid jobs that are not archived (the job's own among them, when it is one). */
  paidIds: readonly string[];
}

/** Nothing known yet: no "Archive all paid". */
export const NO_ARCHIVE_MENU: ArchiveMenuContext = { paidIds: [] };

/** What the archive group needs of a row's actions. The group is left out for a caller without them. */
type ArchiveActions = Pick<RowActions, 'busy'> &
  Partial<Pick<RowActions, 'archive' | 'unarchive' | 'archiveAllPaid'>>;

/**
 * The last group of a job's menu, after a line: Archive wherever `canArchive` says the server would
 * agree (not for a job that is arriving, queued or editing), and on a Paid row also "Archive all
 * paid · N" (N is the paid jobs that are not archived, shown from 2). On an archived job Unarchive
 * takes Archive's place. The items wait for the answer to the row's other request, like the rest.
 */
export function archiveMenuEntries(
  job: Job,
  actions: ArchiveActions,
  context: ArchiveMenuContext = NO_ARCHIVE_MENU,
): RowMenuEntry[] {
  const { archive, unarchive, archiveAllPaid, busy } = actions;
  const separator = { type: 'separator', id: 'archive-separator' } as const;
  if (isArchived(job)) {
    if (unarchive === undefined) return [];
    return [
      separator,
      {
        type: 'item',
        id: 'unarchive',
        label: 'Unarchive',
        icon: ArchiveRestore,
        disabled: busy,
        onSelect: unarchive,
      },
    ];
  }
  if (!canArchive(job) || archive === undefined) return [];
  const entries: RowMenuEntry[] = [
    separator,
    {
      type: 'item',
      id: 'archive',
      label: 'Archive',
      icon: Archive,
      disabled: busy,
      onSelect: archive,
    },
  ];
  if (archiveAllPaid !== undefined && jobStage(job) === 'paid' && context.paidIds.length > 1) {
    entries.push({
      type: 'item',
      id: 'archive-all-paid',
      label: `Archive all paid · ${context.paidIds.length}`,
      icon: Archive,
      disabled: busy,
      onSelect: () => archiveAllPaid(context.paidIds),
    });
  }
  return entries;
}

/**
 * A job's menu with Delete… at the end, after a line, in every state (a video whose folder was
 * deleted too). It asks first (`DeleteJobDialogHost`); the server deletes the folder, the export and
 * every record, the payment included. Applied where the menu is drawn, on top of `rowMenuEntries`.
 */
export function withDeleteEntry(job: Job, entries: JobMenuEntry[]): JobMenuEntry[] {
  return [...entries, ...deleteMenuEntries(job)];
}

function deleteMenuEntries(job: Job): RowMenuEntry[] {
  return [
    { type: 'separator', id: 'delete-separator' },
    {
      type: 'item',
      id: 'delete',
      label: 'Delete…',
      icon: Trash2,
      destructive: true,
      onSelect: () => askToDelete(job),
    },
  ];
}

function entryFor(
  job: Job,
  action: RowAction,
  actions: Pick<RowActions, 'run' | 'busy'>,
): RowMenuItem {
  const base = { type: 'item', id: action.kind, label: action.label } as const;
  switch (action.kind) {
    case 'pay':
      // A dialog, not a request: the page asks for the payment (`askToMarkPaid`).
      return { ...base, icon: ROW_ACTION_ICONS.pay, onSelect: () => askToMarkPaid(job) };
    case 'download':
      return { ...base, icon: ROW_ACTION_ICONS.download, href: action.href, onSelect: () => {} };
    case 'reel':
      // The reel is on another site: a new tab, with no way back to this page for it.
      return {
        ...base,
        icon: ROW_ACTION_ICONS.reel,
        onSelect: () => void window.open(action.href, '_blank', 'noopener,noreferrer'),
      };
    case 'copy':
      return {
        ...base,
        icon: ROW_ACTION_ICONS.copy,
        onSelect: () => void copyError(action.text),
      };
    default:
      return {
        ...base,
        icon: ROW_ACTION_ICONS[action.kind],
        destructive: action.kind === 'cancel',
        // One request at a time per row, as for the button: wait for the answer.
        disabled: actions.busy,
        onSelect: () => actions.run(action),
      };
  }
}

/**
 * What a ready job's menu ends with, after a line: "Use this look for <client>…" for an approved
 * job, then the way back from its stage (Unapprove, Not delivered yet, Not paid yet; an Undo
 * arrow; an Uploaded video has none, its reel goes first). Every other state has none.
 */
export function stageMenuEntries(
  job: Job,
  actions: Pick<RowActions, 'run' | 'busy'>,
  currentLookJobId: string | null,
  admin = true,
): RowMenuEntry[] {
  if (job.state !== 'ready') return [];
  // Not delivered yet and Not paid yet are money too: an editor has neither (and so, for a delivered
  // or paid job, no entry). Unapprove is not money; whoever may approve may take it back.
  const back = stageUndoAction(job);
  const mayGoBack = back !== null && (admin || back.kind === 'unapprove');
  const entries = [
    ...lookMenuEntries(job, currentLookJobId),
    ...(mayGoBack ? [entryFor(job, back, actions)] : []),
  ];
  return [{ type: 'separator', id: 'stage-separator' }, ...entries];
}

/**
 * The menu of a delivered video whose folder was deleted (CVP-204): Mark paid… and, after a line,
 * Not delivered yet. There is no job behind the row, so nothing else applies: no note, effort,
 * download, look, series or archive.
 */
export function folderDeletedMenuEntries(
  job: Job,
  actions: Pick<RowActions, 'run' | 'busy'>,
): RowMenuEntry[] {
  return [
    entryFor(job, { kind: 'pay', label: STAGE_LABELS.pay }, actions),
    { type: 'separator', id: 'stage-separator' },
    entryFor(job, { kind: 'undeliver', label: STAGE_LABELS.undeliver }, actions),
  ];
}

/**
 * Everything in a job's right-click menu, top to bottom: Review… for a review job, then the leading
 * entries (the note and Effort ▸, disabled while the job is in review), then the actions of its state
 * (`menuActions`), then, for a ready job and after a line, "Use this look for <client>…" (approved)
 * and the way back from its stage (approved, delivered, paid), then the series items (`seriesMenuEntries`, none
 * while series are off), then, last and after a line, the archive group (`archiveMenuEntries`). The
 * menu is drawn from this list, so adding an item is adding an entry. A line next to another is
 * dropped, and so is one in last position (a review job has no action after the note).
 *
 * `currentLookJobId` is the job the client's look comes from, once the client's style is read;
 * `null` while it is not known (or the look comes from files), which leaves the item enabled.
 * `series` is whether series are on and the client's series, once they are read. `archive` is what
 * the archive group needs of the other jobs. A video whose folder was deleted has a menu of its own
 * (`folderDeletedMenuEntries`). For an editor (`admin` false) the money entries are left out: Mark
 * delivered, Mark paid…, Not delivered yet, Not paid yet and Archive all paid. `versions` is
 * whether the menu offers "Versions…" (the Mac's job sheet is on); a deleted folder has none.
 * `quickFixes` is whether Quick fixes are on: a job in Review then has Effort ▸ with Auto, for the
 * level of its review rounds. `approve` is whether a job in Review has Approve after Review…: the
 * Mac's right-click menu and the phone's sheet do, the Mac sheet's ⋯ does not (Approve is never
 * inside the job).
 */
export function rowMenuEntries(
  job: Job,
  actions: Pick<RowActions, 'run' | 'busy'> &
    Partial<
      Pick<RowActions, 'setEffort' | 'setReviewEffort' | 'archive' | 'unarchive' | 'archiveAllPaid'>
    >,
  currentLookJobId: string | null = null,
  series: SeriesMenuContext = NO_SERIES_MENU,
  archive: ArchiveMenuContext = NO_ARCHIVE_MENU,
  admin = true,
  versions = false,
  quickFixes = false,
  approve = false,
): JobMenuEntry[] {
  if (isFolderDeleted(job)) return admin ? folderDeletedMenuEntries(job, actions) : [];
  return tidySeparators([
    ...reviewMenuEntries(job, versions, approve ? actions : undefined),
    ...leadingMenuEntries(job, actions.setEffort, quickFixes ? actions.setReviewEffort : undefined),
    ...menuActions(job, admin).map((action) => entryFor(job, action, actions)),
    ...stageMenuEntries(job, actions, currentLookJobId, admin),
    ...seriesMenuEntries(job, series),
    ...archiveMenuEntries(
      job,
      admin ? actions : { ...actions, archiveAllPaid: undefined },
      archive,
    ),
  ]);
}
