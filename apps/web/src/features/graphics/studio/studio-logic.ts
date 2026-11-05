// What a graphic's page decides, as plain functions (Graphics plan, "Studio"): the header's status,
// the chat's rows, when Send is allowed and why not, the attached files, the voice note's text,
// the text fields' values, which version is shown and the About column's rows. No React and no
// browser globals (the clock is a parameter), so node tests cover them.

import {
  cleanGraphicName,
  DEFAULT_EFFORT,
  EFFORT_LABELS,
  EFFORT_LEVELS,
  type Effort,
  GRAPHIC_KIND_LABELS,
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  GRAPHIC_SIZE_LABELS,
  GRAPHIC_SIZES,
  type GraphicDetail,
  type GraphicMessage,
  type GraphicSummary,
  type GraphicVariable,
  type GraphicVars,
  graphicBusyMessage,
  graphicStepLabels,
} from '@studio/shared';
import { addedText } from '@/features/job-sheet/sheet-details';
import type { RecorderSnapshot } from '@/features/review/voice-recorder';
import { ABOUT_TEXT, CHAT_TEXT, COMPOSER_TEXT, HEADER_TEXT, VOICE_LINES } from './studio-text';

// --- the header -----------------------------------------------------------------------------------

export type StatusTone = 'muted' | 'making' | 'failed';

/** The part of a graphic the header's status reads. */
export type StatusInput = Pick<
  GraphicSummary,
  'status' | 'version' | 'makingVersion' | 'failedVersion' | 'uses'
>;

/**
 * The status beside the name: "v2", "v2 · off for edits", "Making v1…" (blue; v1 only: a later
 * version is shown by the chip over the preview), "v2 · couldn’t finish v3" (red) or, before any
 * version, "Couldn’t finish v1". "Not made yet" for a graphic with nothing.
 */
export function headStatus(graphic: StatusInput | undefined): { text: string; tone: StatusTone } {
  if (graphic === undefined) return { text: HEADER_TEXT.notMade, tone: 'muted' };
  const { status, version, makingVersion, failedVersion, uses } = graphic;
  if (status === 'making' && version === null) {
    return { text: `Making v${makingVersion ?? 1}…`, tone: 'making' };
  }
  if (status === 'failed') {
    const failed = `couldn’t finish v${failedVersion ?? (version ?? 0) + 1}`;
    return {
      text: version === null ? capitalise(failed) : `v${version} · ${failed}`,
      tone: 'failed',
    };
  }
  if (version !== null) {
    return { text: `v${version}${uses ? '' : HEADER_TEXT.offForEdits}`, tone: 'muted' };
  }
  return { text: HEADER_TEXT.notMade, tone: 'muted' };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a name field's Enter, Esc or blur does with the draft. */
export type NameAction = { kind: 'save'; name: string } | { kind: 'close' };

/** Enter and blur save the cleaned draft; an empty or unchanged one just closes. */
export function nameAction(draft: string, current: string): NameAction {
  const name = cleanGraphicName(draft);
  return name === '' || name === current ? { kind: 'close' } : { kind: 'save', name };
}

/** Why Rename waits (or `null`): a graphic being made cannot be renamed. */
export function renameBlockedReason(graphic: StatusInput | undefined): string | null {
  if (graphic === undefined) return null;
  return graphic.status === 'making' && graphic.makingVersion !== null
    ? graphicBusyMessage(graphic.makingVersion, 'rename')
    : null;
}

// --- the chat -------------------------------------------------------------------------------------

export type StepState = 'done' | 'running' | 'waiting';

export interface StepView {
  label: string;
  state: StepState;
}

/** The three steps of the run that makes `version`, `step` being the one under way (0 to 2). */
export function stepViews(version: number, step: number | null): StepView[] {
  const current = step ?? 0;
  return graphicStepLabels(version).map((label, index) => ({
    label,
    state: index < current ? 'done' : index === current ? 'running' : 'waiting',
  }));
}

/** How long the making box says it takes: v1 about two minutes, a change about one. */
export function leftText(version: number): string {
  return version <= 1 ? 'About 2 min' : 'About 1 min';
}

/** "58 s" or "1 min 52 s" between two instants; "" when either is missing or it took under a second. */
export function tookText(startedAt: string | null, endedAt: string | null): string {
  if (startedAt === null || endedAt === null) return '';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms)) return '';
  const total = Math.round(ms / 1000);
  if (total < 1) return '';
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export type ChatRow =
  | { kind: 'you'; id: string; text: string; refs: readonly string[] }
  | { kind: 'making'; id: string; version: number; steps: StepView[]; left: string }
  | {
      kind: 'done';
      id: string;
      /** The version this reply made (or brought back); `null` only for a row that names none. */
      version: number | null;
      text: string;
      took: string;
    }
  | {
      kind: 'failed';
      id: string;
      version: number;
      text: string;
      error: string;
      /** What the failure left as it was: "v2 is unchanged, and edits keep using it."; `null` before v1. */
      unchanged: string | null;
    }
  | { kind: 'stopped'; id: string; version: number; note: string };

/**
 * The chat as rows, oldest first. The owner's messages keep their text and files. Claude's become the
 * making box (with its three steps), the reply with its version, the failure with its reason, or
 * the stopped line, which says which version is unchanged: the newest one made before it.
 */
export function chatRows(messages: readonly GraphicMessage[]): ChatRow[] {
  const rows: ChatRow[] = [];
  /** The newest version made so far in this walk. */
  let made = 0;
  for (const message of messages) {
    if (message.role === 'you') {
      rows.push({ kind: 'you', id: message.id, text: message.text, refs: message.refs });
      continue;
    }
    const version = message.version ?? made + 1;
    switch (message.status) {
      case 'making':
        rows.push({
          kind: 'making',
          id: message.id,
          version,
          steps: stepViews(version, message.step),
          left: leftText(version),
        });
        break;
      case 'failed': {
        const text = message.text.trim() === '' ? (message.error ?? '') : message.text;
        rows.push({
          kind: 'failed',
          id: message.id,
          version,
          text,
          error: message.error ?? message.text,
          unchanged: made > 0 && !/is unchanged/i.test(text) ? unchangedLine(made) : null,
        });
        break;
      }
      case 'stopped':
        rows.push({
          kind: 'stopped',
          id: message.id,
          version,
          note: made > 0 ? `v${made} is unchanged.` : CHAT_TEXT.nothingMade,
        });
        break;
      default:
        rows.push({
          kind: 'done',
          id: message.id,
          version: message.version,
          text: message.text,
          took: tookText(message.startedAt, message.endedAt),
        });
        if (message.version !== null) made = Math.max(made, message.version);
    }
  }
  return rows;
}

/** What a failed run says it left as it was (board GRStates 7): "v2 is unchanged, and edits keep using it." */
export function unchangedLine(version: number): string {
  return `v${version} is unchanged, and edits keep using it.`;
}

/** The text that follows a "Stopped." line. */
export function stoppedLine(note: string): string {
  return `Stopped. ${note}`;
}

/** A signature of the chat that changes when a row is added or one changes status: scrolls to the end. */
export function chatSignature(messages: readonly GraphicMessage[]): string {
  return `${messages.length}:${messages.map((m) => `${m.status ?? ''}${m.step ?? ''}`).join(',')}`;
}

// --- the version shown ----------------------------------------------------------------------------

/** An older version picked in the chat, and the newest one at the time. */
export interface VersionPin {
  version: number;
  newest: number;
}

/**
 * The version the player shows: the newest, unless an older one is pinned. A pin goes stale when
 * a newer version arrives (a run finished, or "Use vN again"), so the player follows the newest.
 */
export function shownVersion(pin: VersionPin | null, newest: number | null): number | null {
  if (newest === null) return null;
  return pin !== null && pin.newest === newest && pin.version < newest ? pin.version : newest;
}

/** The pin after the version `version` was picked: none for the newest. */
export function pinAfterPick(version: number, newest: number | null): VersionPin | null {
  return newest === null || version >= newest ? null : { version, newest };
}

// --- the text fields ------------------------------------------------------------------------------

/** What the owner typed in "Text in it": field id → text. Never saved. */
export type TypedValues = Readonly<Record<string, string>>;

/** The value of every field: what was typed, else the graphic's own default. */
export function resolveValues(
  variables: readonly GraphicVariable[],
  typed: TypedValues,
): GraphicVars {
  const values: Record<string, string> = {};
  for (const variable of variables) values[variable.id] = typed[variable.id] ?? variable.default;
  return values;
}

// --- the composer ---------------------------------------------------------------------------------

/** One level of the Effort menu. */
export interface EffortChoice {
  level: Effort;
  label: string;
}

/** Medium, High, Extra high (the default is Extra high). */
export const EFFORT_CHOICES: readonly EffortChoice[] = EFFORT_LEVELS.map((level) => ({
  level,
  label: EFFORT_LABELS[level],
}));

/** The effort a message carries: none for the default, so the engine's own default applies. */
export function effortToSend(level: Effort): Effort | null {
  return level === DEFAULT_EFFORT ? null : level;
}

/** The version being made while a run of the graphic is making, else `null` (a failed run is not making). */
export function makingVersionOf(
  graphic: Pick<GraphicSummary, 'status' | 'makingVersion' | 'version'> | undefined,
): number | null {
  if (graphic?.status !== 'making') return null;
  return graphic.makingVersion ?? (graphic.version ?? 0) + 1;
}

export interface SendInput {
  draft: string;
  files: readonly unknown[];
  /** A run of this graphic is making. */
  makingVersion: number | null;
  offline: boolean;
  sending: boolean;
  /** A voice note is starting, recording, being typed out, or waiting for Try again. */
  recorderBusy: boolean;
}

export interface SendState {
  enabled: boolean;
  /** Said in a tooltip when Send is off for a reason the owner can fix by waiting or finishing. */
  reason: string | null;
}

/**
 * Whether Send works: there is text or at least one file, and nothing is in the way. While a
 * version is being made Send waits (the text can still be written); so does it while offline or
 * while a voice note is not yet text.
 */
export function sendState(input: SendInput): SendState {
  if (input.sending) return { enabled: false, reason: null };
  if (input.offline) return { enabled: false, reason: COMPOSER_TEXT.offline };
  if (input.makingVersion !== null) {
    return { enabled: false, reason: graphicBusyMessage(input.makingVersion, 'send') };
  }
  if (input.recorderBusy) return { enabled: false, reason: COMPOSER_TEXT.finishRecordingFirst };
  const empty = input.draft.trim() === '' && input.files.length === 0;
  return { enabled: !empty, reason: null };
}

/** Whether the file picker's files are things a graphic can use: images, videos, fonts and PDFs. */
export function isAttachable(file: Pick<File, 'name' | 'type'>): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('font/')) {
    return true;
  }
  if (type === 'application/pdf') return true;
  return /\.(pdf|ttf|otf|ttc|woff2?)$/i.test(file.name);
}

/** The file picker's `accept` hint. */
export const ATTACH_ACCEPT = 'image/*,video/*,application/pdf,.pdf,.ttf,.otf,.ttc,.woff,.woff2';

export interface AttachResult {
  files: File[];
  /** The server's sentence for what was left out, or `null` when everything was taken. */
  error: string | null;
}

const sameFile = (a: File, b: File): boolean =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/**
 * The files after adding `incoming` to `current`, within the limits of one message (at most 5
 * files, 500 MB together; images, videos, fonts and PDFs only). A file already there is not added
 * twice. What does not fit is left out, and `error` says why in the server's words.
 */
export function addAttachments(current: readonly File[], incoming: readonly File[]): AttachResult {
  const files = [...current];
  let error: string | null = null;
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of incoming) {
    if (files.some((known) => sameFile(known, file))) continue;
    if (!isAttachable(file)) {
      error = GRAPHIC_MESSAGES.badUploadType;
    } else if (files.length >= GRAPHIC_LIMITS.refsMaxFiles) {
      error = GRAPHIC_MESSAGES.tooManyFiles;
    } else if (bytes + file.size > GRAPHIC_LIMITS.refsMaxBytes) {
      error = GRAPHIC_MESSAGES.tooLarge;
    } else {
      files.push(file);
      bytes += file.size;
    }
  }
  return { files, error };
}

/** The draft with what a voice note said added: after a space, or in its place when the draft is blank. */
export function appendVoiceText(draft: string, said: string): string {
  const text = said.trim();
  if (text === '') return draft;
  if (draft.trim() === '') return text;
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`;
}

/** The mic button's name: it records, or stops the recording. */
export function micLabel(snapshot: Pick<RecorderSnapshot, 'phase'>): string {
  return snapshot.phase === 'recording' ? COMPOSER_TEXT.recordStop : COMPOSER_TEXT.recordStart;
}

/** What the strip above the textarea says about the voice note, or `null` when it says nothing. */
export function voiceLine(
  snapshot: Pick<RecorderSnapshot, 'phase' | 'error'>,
): { text: string; tone: 'recording' | 'info' | 'error' } | null {
  switch (snapshot.phase) {
    case 'starting':
      return { text: VOICE_LINES.waiting, tone: 'info' };
    case 'recording':
      return { text: VOICE_LINES.recording, tone: 'recording' };
    case 'saving':
      return { text: VOICE_LINES.saving, tone: 'info' };
    case 'failed':
      return { text: snapshot.error ?? '', tone: 'error' };
    default:
      return snapshot.error === null ? null : { text: snapshot.error, tone: 'error' };
  }
}

/** The composer's label and placeholder: the first request, or a change. */
export function composerWords(hasMessages: boolean): { label: string; placeholder: string } {
  return hasMessages
    ? { label: COMPOSER_TEXT.labelNext, placeholder: COMPOSER_TEXT.placeholderNext }
    : { label: COMPOSER_TEXT.labelFirst, placeholder: COMPOSER_TEXT.placeholderFirst };
}

// --- the About column -----------------------------------------------------------------------------

export interface DetailRow {
  label: string;
  value: string;
}

/** "3 s", "2.5 s". */
export function lengthText(lengthSec: number | null): string {
  return lengthSec === null ? '' : `${Number(lengthSec.toFixed(1))} s`;
}

/** "N videos" / "1 video" / "No videos yet". */
export function usedInText(count: number): string {
  if (count === 0) return ABOUT_TEXT.noVideos;
  return count === 1 ? '1 video' : `${count} videos`;
}

/**
 * Details: Kind, Sizes, Length, Versions, Made, Used in (only when the edits switch is on, which
 * is when the engine counts) and the folder in the inbox.
 */
export function detailRows(graphic: GraphicDetail, now: Date): DetailRow[] {
  const rows: DetailRow[] = [
    {
      label: 'Kind',
      value: graphic.kind === null ? '' : GRAPHIC_KIND_LABELS[graphic.kind],
    },
    { label: 'Sizes', value: GRAPHIC_SIZES.map((size) => GRAPHIC_SIZE_LABELS[size]).join(', ') },
    { label: 'Length', value: lengthText(graphic.lengthSec) },
    { label: 'Versions', value: String(graphic.version ?? 0) },
    { label: 'Made', value: addedText(graphic.createdAt, now) },
  ];
  if (graphic.usedIn !== null) rows.push({ label: 'Used in', value: usedInText(graphic.usedIn) });
  rows.push({ label: 'Folder', value: `_Graphics/${graphic.folder}` });
  return rows;
}
