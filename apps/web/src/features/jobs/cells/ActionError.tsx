import { type ReactNode, useEffect, useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** How long a refused action's explanation stays on screen if nobody dismisses it. */
export const ACTION_ERROR_MS = 8000;

interface ActionErrorProps {
  /** What the server said ("Only an editing job can be cancelled."), or `null` for no error. */
  message: string | null;
  /** Called when the notice should go: Escape, a click anywhere, or the timeout. */
  onDismiss: () => void;
  /** The action buttons the notice belongs to. */
  children: ReactNode;
}

/**
 * Shows why an action was refused (a 409 from the server, or the server not being reachable) in a
 * small tooltip under the row's action buttons. The design canvas has no error state for row
 * actions, so this reuses its error tooltip: the popover surface, in the failure colour, wide
 * enough to wrap. It opens by itself when there is a `message` and goes away on its own after a
 * few seconds, on Escape, or on the next click anywhere (the buttons included).
 */
export function ActionError({ message, onDismiss, children }: ActionErrorProps) {
  // The latest callback without restarting the timer whenever the parent re-renders.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  // Keep the words on screen while the tooltip fades out.
  const lastMessage = useRef(message);
  if (message !== null) lastMessage.current = message;

  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => dismiss.current(), ACTION_ERROR_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    // Controlled and never closed by hover or focus changes: moving the pointer away must not
    // swallow an explanation nobody has read yet. Only the dismissals below close it.
    <Tooltip open={message !== null}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        wide
        role="alert"
        onEscapeKeyDown={onDismiss}
        onPointerDownOutside={onDismiss}
        side="bottom"
        align="end"
        sideOffset={6}
        className="border-status-failed/40 text-status-failed-foreground"
      >
        {message ?? lastMessage.current}
      </TooltipContent>
    </Tooltip>
  );
}
