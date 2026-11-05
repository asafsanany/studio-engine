import {
  can,
  GENERATE_STEP_NAME,
  generateFailureOf,
  isArchived,
  type Job,
  type JobAction,
  type JobState,
  jobStage,
  STEP_LABELS,
} from '@studio/shared';
import { downloadUrl } from '@/data';

/**
 * Send notes belongs to the review dialog's footer (W8, W10), never to a row. Approve is the other
 * way round: the row's right-click menu only, never inside the job (the owner, 31 Oct: an editor approved
 * to see the video sooner, then unapproved), so it is a row action (`approveAction`).
 */
export const REVIEW_DIALOG_ACTIONS = ['send_notes'] as const satisfies readonly JobAction[];

/** A server action a row can offer. */
export type RowJobAction = Exclude<JobAction, (typeof REVIEW_DIALOG_ACTIONS)[number]>;

/** An action that goes through the server: choosing it calls `useJobAction(kind).mutate(job.id)`. */
export interface MutationRowAction {
  kind: RowJobAction;
  /** The tooltip text of the icon button, or the text of the menu item, and its accessible name. */
  label: string;
}

/** Download MP4: a plain link to the finished export. */
export interface DownloadRowAction {
  kind: 'download';
  label: string;
  href: string;
}

/** Open reel: opens the Instagram reel linked to the job (`delivery.reelUrl`) in a new tab. */
export interface ReelRowAction {
  kind: 'reel';
  label: string;
  href: string;
}

/** Review: opens the review dialog (`openReview`); no request goes to the server. */
export interface ReviewRowAction {
  kind: 'review';
  label: string;
}

/** Copy error: puts the full error text on the clipboard. */
export interface CopyRowAction {
  kind: 'copy';
  label: string;
  text: string;
}

/**
 * Mark delivered, Not delivered yet, Not paid yet: a change of a ready job's stage. It goes to the
 * delivery routes (not through the job state machine), and a message with Undo follows it.
 */
export interface StageRowAction {
  kind: 'deliver' | 'undeliver' | 'unpay';
  label: string;
}

/** Mark paid…: asks the page for the Mark paid dialog (`askToMarkPaid`); no request goes out yet. */
export interface PayRowAction {
  kind: 'pay';
  label: string;
}

export type RowAction =
  | MutationRowAction
  | DownloadRowAction
  | ReelRowAction
  | CopyRowAction
  | StageRowAction
  | PayRowAction;

/** The server actions that can be a button: Approve and Unapprove are in the right-click menu only. */
type ButtonJobAction = Exclude<RowJobAction, 'approve' | 'unapprove'>;

/** What the right column can hold: the one step that moves the job forward. */
export type NextStepAction =
  | (MutationRowAction & { kind: ButtonJobAction })
  | ReviewRowAction
  | (StageRowAction & { kind: 'deliver' })
  | PayRowAction;

/** The labels of the stage actions: the button's tooltip (and name) or the menu item's text. */
export const STAGE_LABELS = {
  deliver: 'Mark delivered',
  // It opens a dialog, hence the ellipsis.
  pay: 'Mark paid…',
  undeliver: 'Not delivered yet',
  unpay: 'Not paid yet',
} as const satisfies Record<StageRowAction['kind'] | PayRowAction['kind'], string>;

/** Open reel's label: the menu item that opens the Instagram reel linked to the job. */
export const REEL_LABEL = 'Open reel';

/** The review row action's labels: the button's tooltip, and the menu item (it opens a dialog, hence the ellipsis). */
export const REVIEW_LABELS = { button: 'Review', menu: 'Review…' } as const;

const LABELS = {
  start: 'Start now',
  hold: 'Hold',
  release: 'Release',
  // Cancel asks "Stop this edit?" first, so the menu item ends in an ellipsis.
  cancel: 'Cancel…',
  resume: 'Resume',
  approve: 'Approve',
  unapprove: 'Unapprove',
} as const satisfies Partial<Record<RowJobAction, string>>;

/**
 * "Retry from Render": the step the job failed at, by name (not the step with its sub-count). A
 * generated job that stopped in Generate (it is still at step 1) says "Retry from Generate": the
 * Brief is kept, and what the stage already made with it.
 */
function retryLabel(job: Pick<Job, 'state' | 'failedAt' | 'error'>): string {
  if (generateFailureOf(job) !== null) return `Retry from ${GENERATE_STEP_NAME}`;
  return job.failedAt === null ? 'Retry' : `Retry from ${STEP_LABELS[job.failedAt]}`;
}

function labelFor(job: Job, action: RowJobAction): string {
  return action === 'retry' ? retryLabel(job) : LABELS[action];
}

function download(job: Job): DownloadRowAction {
  return { kind: 'download', label: 'Download MP4', href: downloadUrl(job.id) };
}

/** Open reel, for a job whose reel has an address (a linked reel does); `null` otherwise. */
function openReel(job: Job): ReelRowAction | null {
  const href = job.delivery?.reelUrl;
  return href === undefined ? null : { kind: 'reel', label: REEL_LABEL, href };
}

/** The server action that moves a job forward, for the states that have one. */
const NEXT_STEP: Partial<Record<JobState, ButtonJobAction>> = {
  arriving: 'start',
  held: 'release',
  failed: 'retry',
  cancelled: 'resume',
};

/**
 * The right-click menu's server actions for each state, top to bottom. Download MP4 (ready) and
 * Copy error (failed, after Retry) are not server actions and are added by `menuActions`. A review
 * job has none: its Review… item opens a dialog and is added by the menu itself (`row-menu.ts`).
 */
const MENU_ACTIONS = {
  arriving: ['start', 'hold'],
  queued: ['hold'],
  held: ['release'],
  editing: ['cancel'],
  review: [],
  ready: [],
  failed: ['retry'],
  cancelled: ['resume'],
} as const satisfies Record<JobState, readonly RowJobAction[]>;

/**
 * The step that moves a ready job on from its stage: Mark delivered, Mark paid… (a delivered or
 * uploaded video), or none (paid). An archived delivered video has no Mark paid…: archived means paid already or not needed, so the
 * Mark paid dialog does not list it either (CVP-202). Unarchive brings the step back.
 *
 * Mark delivered and Mark paid… are money, which is the admin's: an editor (`admin` false) has no
 * step here (Team plan, TM4).
 */
function stageStep(
  job: Job,
  admin: boolean,
): (StageRowAction & { kind: 'deliver' }) | PayRowAction | null {
  if (!admin) return null;
  const stage = jobStage(job);
  if (stage === 'approved') return { kind: 'deliver', label: STAGE_LABELS.deliver };
  if ((stage === 'delivered' || stage === 'uploaded') && !isArchived(job)) {
    return { kind: 'pay', label: STAGE_LABELS.pay };
  }
  return null;
}

/**
 * The one button of a job's Action cell: the step that moves it forward, and nothing else.
 *
 * - arriving: Start now · held: Release · cancelled: Resume · failed: Retry from <step>
 * - ready, by its stage: approved: Mark delivered · delivered or uploaded: Mark paid… (asks for the
 *   dialog) · paid: none. Download MP4 and Open reel are in the row's menu.
 * - queued and editing: none (the job moves by itself; Hold and Cancel are in the row's menu)
 * - review: Review (opens the review dialog; no request)
 *
 * A server action is offered only while the shared state machine allows it (`can`), so the cell can
 * never offer something the server would answer with a 409. For an editor (`admin` false; the
 * default is the admin) a ready job has no next step: Mark delivered and Mark paid… are the admin's.
 */
export function nextStepAction(job: Job, admin = true): NextStepAction | null {
  if (job.state === 'ready') return stageStep(job, admin);
  if (job.state === 'review') return { kind: 'review', label: REVIEW_LABELS.button };
  const kind = NEXT_STEP[job.state];
  return kind !== undefined && can(job, kind) ? { kind, label: labelFor(job, kind) } : null;
}

/**
 * The actions of a job's right-click menu, top to bottom (the note item comes before these).
 *
 * - arriving: Start now, Hold · queued: Hold · held: Release · editing: Cancel…
 * - ready, by its stage: approved: Mark delivered, Download MP4 · delivered: Mark paid…, Download
 *   MP4 · uploaded: Mark paid…, Open reel, Download MP4 · paid: Download MP4 (with Open reel first
 *   when a reel is linked to it). The way back (`stageUndoAction`) is not here: the menu puts it
 *   after a line of its own.
 * - failed: Retry from <step>, Copy error
 * - cancelled: Resume
 *
 * Like the button, a server action is offered only while the state machine allows it. Copy error is
 * left out when the job failed without an error text (nothing to copy). An editor (`admin` false)
 * has no Mark delivered or Mark paid….
 */
export function menuActions(job: Job, admin = true): RowAction[] {
  const actions: RowAction[] = [];
  for (const kind of MENU_ACTIONS[job.state]) {
    if (can(job, kind)) actions.push({ kind, label: labelFor(job, kind) });
  }
  if (job.state === 'ready') {
    const step = stageStep(job, admin);
    if (step !== null) actions.push(step);
    // Open reel is not money: an editor has it too.
    const reel = openReel(job);
    if (reel !== null) actions.push(reel);
    actions.push(download(job));
  }
  if (job.state === 'failed' && job.error !== null && job.error !== '') {
    actions.push({ kind: 'copy', label: 'Copy error', text: job.error });
  }
  return actions;
}

/**
 * Approve, for a job in Review while the state machine allows it; `null` otherwise. Only the row's
 * right-click menu offers it (and the phone's sheet, which is that menu there): it renders the final
 * video, so it is never one click away inside the job. The server still refuses it while unsent
 * notes wait or a quick fix or the music is changing the preview, and the row says why.
 */
export function approveAction(job: Job): (MutationRowAction & { kind: 'approve' }) | null {
  return can(job, 'approve') ? { kind: 'approve', label: LABELS.approve } : null;
}

/**
 * The way back from a job's stage, which the right-click menu keeps at the bottom: Unapprove
 * (approved: the video is in Review again), Not delivered yet (delivered) or Not paid yet (paid).
 * Unapprove is offered only while `can` says the server would agree (the job was approved and has
 * no delivery). An uploaded video has none: Not delivered yet comes back once the reel is unlinked
 * on the client page (the server refuses it until then), and a paid one goes back to Uploaded.
 */
export function stageUndoAction(
  job: Job,
): StageRowAction | (MutationRowAction & { kind: 'unapprove' }) | null {
  const stage = jobStage(job);
  if (stage === 'approved' && can(job, 'unapprove')) {
    return { kind: 'unapprove', label: LABELS.unapprove };
  }
  if (stage === 'delivered') return { kind: 'undeliver', label: STAGE_LABELS.undeliver };
  if (stage === 'paid') return { kind: 'unpay', label: STAGE_LABELS.unpay };
  return null;
}
