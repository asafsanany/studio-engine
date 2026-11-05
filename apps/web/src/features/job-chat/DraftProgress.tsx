import { DRAFT_STAGES, type DraftStageId } from '@studio/shared';
import { LoaderCircle, Square } from 'lucide-react';
import { StepIcon } from '@/components/chat/ChatRows';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { JOB_CHAT_TEXT } from './job-chat-text';

/**
 * The box over the chat while the Draft runs (DCCards 8): a spinner, what it is doing, Stop, and
 * video-use's six stages with the done ones checked and the one it is on spinning. `stage` is null
 * while it waits in line.
 */
export function DraftProgress({
  title,
  stage,
  stages = true,
  stopping,
  disabled,
  onStop,
}: {
  title: string;
  stage: DraftStageId | null;
  /** The Draft's six stages under the title; a review round or a render has none. */
  stages?: boolean;
  stopping: boolean;
  disabled: boolean;
  onStop: () => void;
}) {
  const at = stage === null ? -1 : DRAFT_STAGES.findIndex((item) => item.id === stage);
  return (
    <div data-slot="draft-progress" className="flex shrink-0 flex-col gap-2.5 border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none"
        />
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={disabled || stopping}
          aria-busy={stopping}
          onClick={onStop}
        >
          {stopping ? (
            <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <Square aria-hidden="true" className="size-2.5 fill-current stroke-none" />
          )}
          {stopping ? JOB_CHAT_TEXT.stopping : JOB_CHAT_TEXT.stop}
        </Button>
      </div>
      {stages && (
        <ol className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs">
          {DRAFT_STAGES.map((item, index) => {
            const state = at === -1 || index > at ? 'waiting' : index < at ? 'done' : 'running';
            return (
              <li
                key={item.id}
                data-stage={item.id}
                data-state={state}
                className={cn(
                  'inline-flex items-center gap-1.5 [&_svg]:size-3',
                  state === 'waiting' ? 'text-zinc-500' : 'text-foreground',
                )}
              >
                <StepIcon state={state} />
                {item.label}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
