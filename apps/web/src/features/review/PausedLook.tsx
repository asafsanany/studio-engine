import { type Ref, useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import { CompareButton } from './CompareButton';
import {
  PAUSED_LOOK_SKELETON_MS,
  PAUSED_LOOK_TEXT,
  type PausedLookTarget,
  pausedLookPill,
} from './paused-look';

interface PausedLookProps {
  target: PausedLookTarget;
  /** The frame with the LUT, and the frame as it is (what Compare shows). */
  lutSrc: string;
  plainSrc: string;
  /** "0:12": the frame's time, for the picture's name. */
  timeLabel: string;
}

export type PausedLookPhase = 'loading' | 'shown' | 'failed';

/**
 * The look on the paused frame (board LUReview, states chip and sent), drawn inside the player's
 * box: the frame with the LUT over the plain frame, the pill "Previewing luts/cinematic" at the
 * bottom left with a ghost Compare button that shows the plain frame while it is held (mouse, or
 * Space/Enter) by fading the look out. It is the player's picture, not a control: clicks on it go
 * through to the player (play/pause); only the pill takes them.
 *
 * - Nothing shows until the frame with the LUT has loaded, so the live video is never covered by a
 *   half-loaded picture. After 250 ms without it a skeleton takes the pill's place; a frame that
 *   fails to load shows nothing at all (the note works as ever).
 * - A new address is a new component (`key`): the previous frame's state never carries over.
 * - The Compare button keeps the note box's focus when it is pressed with the mouse (a mouse down
 *   on a button would move it), and holds its own keys (`data-own-keys`: Space is not play/pause).
 */
export function PausedLook(props: PausedLookProps) {
  return <PausedLookFrame key={props.lutSrc} {...props} />;
}

function PausedLookFrame({ target, lutSrc, plainSrc, timeLabel }: PausedLookProps) {
  const [phase, setPhase] = useState<PausedLookPhase>('loading');
  const [plainFailed, setPlainFailed] = useState(false);
  const [comparing, setComparing] = useState(false);
  const skeleton = useDelayedFlag(phase === 'loading', PAUSED_LOOK_SKELETON_MS);

  // A frame that came from the cache can be complete before React's load listener is on it.
  const lutRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = lutRef.current;
    if (image?.complete && image.naturalWidth > 0) setPhase('shown');
  }, []);

  return (
    <PausedLookView
      target={target}
      lutSrc={lutSrc}
      plainSrc={plainSrc}
      timeLabel={timeLabel}
      phase={phase}
      plainFailed={plainFailed}
      comparing={comparing}
      skeleton={skeleton}
      lutRef={lutRef}
      onLutLoad={() => setPhase('shown')}
      onLutError={() => setPhase('failed')}
      onPlainError={() => setPlainFailed(true)}
      onCompare={setComparing}
    />
  );
}

interface PausedLookViewProps extends PausedLookProps {
  phase: PausedLookPhase;
  plainFailed: boolean;
  comparing: boolean;
  /** The skeleton shows where the pill will be (loading for 250 ms). */
  skeleton: boolean;
  lutRef?: Ref<HTMLImageElement>;
  onLutLoad?(): void;
  onLutError?(): void;
  onPlainError?(): void;
  /** Compare is held (`true`) or let go (`false`). */
  onCompare?(on: boolean): void;
}

/** The markup of {@link PausedLook} for a phase: no state of its own, so a test can draw each one. */
export function PausedLookView({
  target,
  lutSrc,
  plainSrc,
  timeLabel,
  phase,
  plainFailed,
  comparing,
  skeleton,
  lutRef,
  onLutLoad,
  onLutError,
  onPlainError,
  onCompare,
}: PausedLookViewProps) {
  return (
    <div
      data-slot="paused-look"
      data-phase={phase}
      className="pointer-events-none absolute inset-0"
    >
      {phase === 'failed' ? null : (
        <div
          className={cn('absolute inset-0', phase === 'loading' && 'invisible')}
          data-slot="paused-look-frame"
        >
          {plainFailed ? null : (
            <img
              src={plainSrc}
              alt={PAUSED_LOOK_TEXT.frameAlt(timeLabel)}
              draggable={false}
              onError={onPlainError}
              className="absolute inset-0 block size-full object-cover"
            />
          )}
          <img
            ref={lutRef}
            src={lutSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            onLoad={onLutLoad}
            onError={onLutError}
            className={cn(
              'absolute inset-0 block size-full object-cover transition-opacity duration-150 ease-in-out',
              comparing ? 'opacity-0' : 'opacity-100',
            )}
          />
        </div>
      )}
      {phase === 'shown' ? (
        <div
          data-slot="paused-look-pill"
          data-own-keys=""
          className="pointer-events-auto absolute bottom-2.5 left-2.5 flex h-[34px] items-center gap-1.5 rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)] pr-1 pl-3 text-xs whitespace-nowrap text-[#FAFAFA]"
        >
          <span>{pausedLookPill(target)}</span>
          <CompareButton comparing={comparing} onCompare={onCompare} />
        </div>
      ) : null}
      {phase === 'loading' && skeleton ? (
        <Skeleton
          data-slot="paused-look-skeleton"
          aria-hidden="true"
          className="absolute bottom-2.5 left-2.5 h-[34px] w-[190px] rounded-lg bg-white/15"
        />
      ) : null}
    </div>
  );
}
