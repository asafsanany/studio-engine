import { Loader2 } from 'lucide-react';
import { Square } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { noteTime, recordingLine, recordingSpokenLine } from '@/features/review/notes-logic';
import { VOICE_TEXT } from '@/features/review/review-text';
import type { RecorderSnapshot } from '@/features/review/voice-recorder';

interface PhoneRecordingBarProps {
  /** The recorder's state; the bar shows in every phase but idle (starting, recording, saving, failed). */
  snapshot: RecorderSnapshot;
  onCancel: () => void;
  onStop: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}

/**
 * What takes the footer's place while a voice note is recorded on the phone (board MReviewRec): a
 * red 44 px bar, "Recording 0:07" and "pinned at 0:21", and under it Cancel and "Stop and add",
 * 44 px each, above the home indicator. The words are the Mac's recording box's: it also says
 * "Waiting for the microphone…" while iPhone Safari asks for it (Stop waits), "Adding the voice
 * note…" while the note uploads, and when the upload failed the reason, with Discard and Try again
 * (the recording is kept).
 *
 * The red bar is a live region that speaks when the phase changes; its clock is hidden from screen
 * readers, so the ticks are not read out.
 */
export function PhoneRecordingBar({
  snapshot,
  onCancel,
  onStop,
  onRetry,
  onDiscard,
}: PhoneRecordingBarProps) {
  const { phase, pinnedSec } = snapshot;
  const saving = phase === 'saving';
  const line = recordingLine(snapshot);
  const spoken = recordingSpokenLine(snapshot);
  return (
    <div
      data-slot="phone-recording-bar"
      data-phase={phase}
      className="flex min-h-[calc(124px+var(--safe-bottom))] shrink-0 flex-col gap-2.5 border-t border-white/10 px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))]"
    >
      <div
        role="status"
        className="flex min-h-11 items-center gap-2 rounded-md border border-[#F87171]/40 bg-[#F87171]/10 px-3.5 py-2 text-sm tabular-nums text-[#FCA5A5]"
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
      <div className="flex gap-2">
        {phase === 'failed' ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1 px-0 text-[15px] has-[>svg]:px-0"
              onClick={onDiscard}
            >
              {VOICE_TEXT.discard}
            </Button>
            <Button
              type="button"
              className="h-11 flex-1 px-0 text-[15px] has-[>svg]:px-0"
              onClick={onRetry}
            >
              {VOICE_TEXT.retry}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              className="h-11 flex-1 px-0 text-[15px] has-[>svg]:px-0"
              onClick={onCancel}
            >
              {VOICE_TEXT.cancel}
            </Button>
            <Button
              type="button"
              disabled={phase !== 'recording'}
              aria-busy={saving}
              className="h-11 flex-1 px-0 text-[15px] has-[>svg]:px-0"
              onClick={onStop}
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Square className="size-3.5 fill-current stroke-none" />
              )}
              {VOICE_TEXT.stopAndAdd}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
