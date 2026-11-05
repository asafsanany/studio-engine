import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export const PLAYER_ERROR_TEXT = "The preview didn't load.";

/** What fills the video box while the player loads (PreviewPlayer shows it after a short delay). */
export function PlayerSkeleton({ className }: { className?: string }) {
  return (
    <>
      <Skeleton className={cn('absolute inset-0 rounded-none', className)} />
      <span role="status" className="sr-only">
        Loading the preview…
      </span>
    </>
  );
}

/** What fills the video box when the composition could not be loaded. */
export function PlayerError({ onRetry, className }: { onRetry(): void; className?: string }) {
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#111111] p-4 text-center',
        className,
      )}
    >
      <p className="text-sm text-muted-foreground">{PLAYER_ERROR_TEXT}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RotateCcw />
        Try again
      </Button>
    </div>
  );
}
