import { ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { SKELETON_DELAY_MS, useDelayedFlag } from '../delayed-flag';

/** The frame of a still, and of the placeholder next to it: 112 × 199, the board's 9:16 thumbnail. */
export const STILL_FRAME_CLASS = 'relative h-[199px] w-28 shrink-0 overflow-hidden rounded-lg';

interface LookStillFrameProps {
  /** Where the picture loads from; `null`: nothing to ask for (yet). */
  src: string | null;
  /** The frame's accessible name: "Now look, from Studio tour". */
  label: string;
  /** The picture is in. It fades in over the frame. */
  loaded: boolean;
  /** The picture could not be had (the job has no export, or the engine could not make the still). */
  failed: boolean;
  /** Draw the skeleton over the frame: the wait has been noticeable. */
  skeleton: boolean;
  /** The ring around the look that is going to be the client's. */
  highlighted: boolean;
  onLoad: () => void;
  onError: () => void;
}

/**
 * One still: a picture of a finished video, cropped to fill its frame. The frame is always there
 * with a faint image icon in it, so a picture that is slow, or missing, leaves a quiet empty
 * frame, not a hole. The picture loads lazily and fades in; a skeleton covers the frame while it
 * is on its way, once the wait is long enough to notice. Presentational: `LookStill` owns the state.
 */
export function LookStillFrame({
  src,
  label,
  loaded,
  failed,
  skeleton,
  highlighted,
  onLoad,
  onError,
}: LookStillFrameProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(STILL_FRAME_CLASS, 'bg-muted', highlighted && 'ring-2 ring-white/60')}
    >
      <ImageIcon
        aria-hidden="true"
        strokeWidth={1.5}
        className="absolute top-[45%] left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 opacity-[0.18]"
      />
      {src !== null && !failed && (
        // The frame carries the name; the picture is decoration.
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={onLoad}
          onError={onError}
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-200 ease-in-out motion-reduce:transition-none',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      {skeleton && (
        <Skeleton className="absolute inset-0 rounded-none bg-foreground/10 motion-reduce:animate-none" />
      )}
    </div>
  );
}

interface LookStillProps {
  src: string | null;
  label: string;
  /** Something other than the picture is being waited for (which job the look comes from). */
  waiting?: boolean;
  highlighted?: boolean;
  /** How long a wait must last before the skeleton shows. Tests pass 0. */
  skeletonDelayMs?: number;
}

/**
 * A still that tracks its own loading. Give it a new `key` when `src` changes: it starts again
 * from "not loaded".
 */
export function LookStill({
  src,
  label,
  waiting = false,
  highlighted = false,
  skeletonDelayMs = SKELETON_DELAY_MS,
}: LookStillProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  // The picture is being waited for, or what says where the picture is.
  const pending = src === null ? waiting : status === 'loading';
  const skeleton = useDelayedFlag(pending, skeletonDelayMs);
  return (
    <LookStillFrame
      src={src}
      label={label}
      loaded={status === 'loaded'}
      failed={status === 'failed'}
      skeleton={skeleton}
      highlighted={highlighted}
      onLoad={() => setStatus('loaded')}
      onError={() => setStatus('failed')}
    />
  );
}
