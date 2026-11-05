import { Loader2 } from 'lucide-react';
import { Square } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { noteTime, recordingLine, recordingSpokenLine } from './notes-logic';
import { VOICE_TEXT } from './review-text';
import type { RecorderSnapshot } from './voice-recorder';

interface RecordingBoxProps {
  /** The recorder's state; the box is shown in every phase but idle (starting, recording, saving, failed). */
  snapshot: RecorderSnapshot;
  onCancel: () => void;
  onStop: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}

/**
 * What takes the composer's place while a voice note is recorded (board P3Review): a red 76 px box
 * with "Recording m:ss" and "pinned at m:ss", and under it Cancel and "Stop and add". The same
 * outer box as the composer, so the panel doesn't move. It also says "Waiting for the
 * microphone…" while the browser asks, "Adding the voice note…" while the note uploads, and, when
 * the upload failed, the reason with Discard and Try again (the recording is kept).
 *
 * The red box is a live region (`role="status"`), so a screen reader speaks when the phase changes:
 * recording started, saving, failed. The clock is `aria-hidden` and a visually hidden "Recording"
 * stands in for it, so the clock's one-second ticks are not announced.
 */
export function RecordingBox({
  snapshot,
  onCancel,
  onStop,
  onRetry,
  onDiscard,
}: RecordingBoxProps) {
  const { phase, pinnedSec } = snapshot;
  const saving = phase === 'saving';
  const line = recordingLine(snapshot);
  const spoken = recordingSpokenLine(snapshot);
  return (
    <div
      data-slot="recording-box"
      data-phase={phase}
      className="flex shrink-0 flex-col gap-2 border-t p-3"
    >
      <div
        role="status"
        className="flex h-[76px] items-center gap-2 rounded-md border border-[#F87171]/40 bg-[#F87171]/10 px-3.5 text-[13px] tabular-nums text-[#FCA5A5]"
      >
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[#F87171]" />
        <span className="min-w-0 flex-1 break-words">
          {spoken === line ? (
            line
          ) : (
            <>
              <span aria-hidden="true">{line}</span>
              <span className="sr-only">{spoken}</span>
            </>
          )}
        </span>
        {phase === 'failed' || pinnedSec === null ? null : (
          <span className="shrink-0 text-muted-foreground">
            {VOICE_TEXT.pinnedAt} {noteTime(pinnedSec)}
          </span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        {phase === 'failed' ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
              {VOICE_TEXT.discard}
            </Button>
            <Button type="button" size="sm" onClick={onRetry}>
              {VOICE_TEXT.retry}
            </Button>
          </>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={onCancel}
                >
                  {VOICE_TEXT.cancel}
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{VOICE_TEXT.cancelTip}</TooltipContent>
            </Tooltip>
            {phase === 'starting' ? null : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving}
                    aria-busy={saving}
                    className="gap-2 has-[>svg]:px-3"
                    onClick={onStop}
                  >
                    {saving ? (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    ) : (
                      <Square className="size-3.5 fill-current stroke-none" />
                    )}
                    {VOICE_TEXT.stopAndAdd}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{VOICE_TEXT.stopAndAddTip}</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}
