import { GRAPHIC_SIZE_PIXELS, type GraphicSize } from '@studio/shared';
import { Loader2, Shapes } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { GRAPHIC_CONTROLS_HEIGHT_CLASS } from './GraphicControls';

// The room the picture has, drawn without a player: the empty states, the chip over the picture,
// and what shows while the player's code loads. The real picture is PreviewPlayer's box, which
// measures the same room; the `m-3` below is the margin its stage gets (`stageClassName` in
// GraphicPlayerStack), so a box here lands exactly where the player's does.

/**
 * The area the picture may take: the column above the bar, minus a 12 px margin all round. It is a
 * size container, so a `SizedBox` inside can be as large as fits it.
 */
export function StageRoom({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="preview-stage-room"
      className="m-3 flex min-h-0 flex-1 items-center justify-center [container-type:size]"
    >
      {children}
    </div>
  );
}

/** A box with the size's shape, as large as fits the `StageRoom` it is in. */
export function SizedBox({
  size,
  className,
  children,
}: {
  size: GraphicSize;
  className?: string;
  children?: ReactNode;
}) {
  const { width, height } = GRAPHIC_SIZE_PIXELS[size];
  return (
    <div
      data-slot="preview-box"
      className={cn('relative shrink-0 rounded-md', className)}
      style={{
        aspectRatio: `${width} / ${height}`,
        width: `min(100cqw, 100cqh * ${width} / ${height})`,
      }}
    >
      {children}
    </div>
  );
}

/** "Making v3…", top right of the picture: a new version is on its way, the one on show still plays. */
export function MakingChip({ version }: { version: number }) {
  return (
    <span
      data-slot="making-chip"
      role="status"
      className="absolute top-2 right-2 z-10 inline-flex h-6 items-center gap-1.5 rounded-full border bg-background/85 px-2 text-xs"
    >
      <Loader2 aria-hidden="true" className="size-3 animate-spin text-blue-500" />
      {`Making v${version}…`}
    </span>
  );
}

/**
 * A layer over the whole preview area (the stage and the bar's height under it) that lines its
 * children up with the picture: a `SizedBox` in the same room, with nothing in it that can be hit.
 */
export function PictureOverlay({ size, children }: { size: GraphicSize; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col">
      <StageRoom>
        <SizedBox size={size}>{children}</SizedBox>
      </StageRoom>
      <div className={cn('shrink-0', GRAPHIC_CONTROLS_HEIGHT_CLASS)} />
    </div>
  );
}

/** No version yet and one is being made: two pulsing lines and "Making v1…". */
export function MakingFirstPlaceholder({ version }: { version: number }) {
  return (
    <div
      data-slot="preview-placeholder"
      data-state="making"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
    >
      <div className="h-3 w-[46%] animate-pulse rounded-full bg-muted" />
      <div className="h-3 w-[64%] animate-pulse rounded-full bg-muted" />
      <span className="mt-2">{`Making v${version}. It plays here when it’s ready.`}</span>
    </div>
  );
}

/** No version and nothing being made: "Your graphic plays here". */
export function WaitingPlaceholder() {
  return (
    <div
      data-slot="preview-placeholder"
      data-state="waiting"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
    >
      <Shapes aria-hidden="true" className="size-6 text-muted-foreground/70" strokeWidth={1.6} />
      <span>Your graphic plays here</span>
    </div>
  );
}
