import { toast } from 'sonner';
import { ACTION_ERROR_MS } from '../cells/ActionError';
import type { UseLookTarget } from './use-look-dialog';

/**
 * How long "<client> now uses the look from <job>." stays if nobody answers it. Longer than
 * sonner's four seconds: there is a button on it, and it is the only way back from the look.
 */
export const USE_LOOK_TOAST_MS = 10_000;

/**
 * The toast id of one kind of message about a client's look: the newest replaces the one before
 * (so Undo is always the newest look's). Each kind has its own id: Undo closes its message when it
 * is pressed, and a message that reuses the id of one that is closing is swallowed by it.
 */
export const lookToastId = (
  kind: 'used' | 'refused' | 'undone' | 'undo-refused',
  clientId: string,
) => `use-look:${kind}:${clientId}`;

/**
 * Undo is drawn like the board's: a quiet outlined button, not sonner's inverted one. Sonner's own
 * stylesheet is unlayered and beats Tailwind's layered utilities, hence the important modifiers.
 * Its hover fill fades in 150 ms, ease-in-out, like every other button (sonner's own transition on
 * the button only covers opacity and shadow, with `ease`).
 */
export const UNDO_BUTTON_CLASS =
  'h-7! rounded-md! border! border-white/15! bg-white/5! px-2.5! text-[13px]! font-medium! text-foreground! transition-colors! duration-150! ease-in-out! hover:bg-white/10! cursor-pointer';

/** "<Client> now uses the look from <Job>." with Undo, which runs `onUndo`. The names keep their own direction. */
export function announceLookUsed(target: UseLookTarget, onUndo: () => void): void {
  toast(
    <>
      <bdi>{target.client}</bdi> now uses the look from <bdi>{target.jobName}</bdi>.
    </>,
    {
      id: lookToastId('used', target.clientId),
      duration: USE_LOOK_TOAST_MS,
      action: { label: 'Undo', onClick: onUndo },
      classNames: { actionButton: UNDO_BUTTON_CLASS },
    },
  );
}

/** The server said no (409: the job is not ready, the style is being analysed), or could not be reached. */
export function announceLookRefused(target: UseLookTarget, message: string): void {
  toast.error("Couldn't use this look", {
    id: lookToastId('refused', target.clientId),
    description: message,
    duration: ACTION_ERROR_MS,
  });
}

/** Undo worked: the client has the look it had before. */
export function announceLookUndone(target: UseLookTarget): void {
  toast(
    <>
      <bdi>{target.client}</bdi> is back to its earlier look.
    </>,
    { id: lookToastId('undone', target.clientId) },
  );
}

/** Undo was refused (409: nothing to go back to, the style is being analysed) or could not be reached. */
export function announceUndoRefused(target: UseLookTarget, message: string): void {
  toast.error("Couldn't undo this look", {
    id: lookToastId('undo-refused', target.clientId),
    description: message,
    duration: ACTION_ERROR_MS,
  });
}
