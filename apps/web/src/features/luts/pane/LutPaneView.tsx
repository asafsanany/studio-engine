import type { LutDetail, LutFrame } from '@studio/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  afterClip,
  beforeLabel,
  clampSplit,
  frameCredit,
  LUT_FRAME_CHIPS,
  LUT_PANE_FRAME,
  LUT_PANE_TEXT,
  type PaneFact,
  paneDescription,
  paneFacts,
  paneImageUrl,
  paneNote,
} from './lut-pane-model';

/** The words on a bare pane: nothing is open, or the open one could not be read. */
export function LutPaneEmpty({ text = LUT_PANE_TEXT.empty }: { text?: string }) {
  return (
    <section
      data-slot="lut-pane"
      aria-label="LUT preview"
      className="flex flex-1 items-center justify-center text-center text-muted-foreground"
    >
      {text}
    </section>
  );
}

/** The pills on the frame: dark, small, over the picture. */
const PILL =
  'absolute top-2 inline-flex h-5 items-center rounded-full bg-black/55 px-[7px] text-[11px] font-medium text-foreground';

export interface PreviewFrameProps {
  detail: LutDetail;
  frame: LutFrame;
  /** 0 to 100: where the divider stands. */
  split: number;
  /** How many times Try again was pressed; part of the still's address. */
  retry: number;
  /** Both stills failed or one did: the frame says "not ready". */
  failed: boolean;
  /** The skeleton, once the wait has gone on long enough. */
  showSkeleton: boolean;
  /** The two stills have arrived. */
  ready: boolean;
  onLoaded: (side: 'before' | 'after') => void;
  onFailed: () => void;
  onRetry: () => void;
}

/**
 * The 252×448 frame: the before still fills it, the after still lies on top clipped from the
 * divider to the right edge, with a 2 px divider and the pills Before (or Log) and After.
 */
export function PreviewFrame(props: PreviewFrameProps) {
  const { detail, frame, retry, failed, showSkeleton, ready, onLoaded, onFailed, onRetry } = props;
  const split = clampSplit(props.split);
  const size = { width: LUT_PANE_FRAME.width, height: LUT_PANE_FRAME.height };
  const image = 'absolute inset-0 object-cover transition-opacity duration-150 ease-in-out';

  return (
    <div
      data-slot="lut-frame"
      className="relative overflow-hidden rounded-lg border bg-black"
      style={size}
    >
      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-muted-foreground">
          <p>{LUT_PANE_TEXT.notReady}</p>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            {LUT_PANE_TEXT.tryAgain}
          </Button>
        </div>
      ) : (
        <>
          <img
            data-side="before"
            src={paneImageUrl(detail, frame, 'before', retry)}
            alt="The frame before"
            {...size}
            className={cn(image, ready ? 'opacity-100' : 'opacity-0')}
            onLoad={() => onLoaded('before')}
            onError={onFailed}
          />
          <img
            data-side="after"
            src={paneImageUrl(detail, frame, 'after', retry)}
            alt={`The frame with ${detail.name}`}
            {...size}
            className={cn(image, ready ? 'opacity-100' : 'opacity-0')}
            style={{ clipPath: afterClip(split) }}
            onLoad={() => onLoaded('after')}
            onError={onFailed}
          />
          {!ready && showSkeleton && (
            <Skeleton data-slot="lut-frame-skeleton" className="absolute inset-0 rounded-none" />
          )}
          {ready && (
            <>
              <span
                aria-hidden="true"
                data-slot="lut-divider"
                className="absolute top-0 bottom-0 -ml-px w-0.5 bg-foreground shadow-[0_0_6px_rgba(0,0,0,0.6)]"
                style={{ left: `${split}%` }}
              />
              <span className={cn(PILL, 'left-2')}>{beforeLabel(detail)}</span>
              <span className={cn(PILL, 'right-2')}>{LUT_PANE_TEXT.after}</span>
            </>
          )}
        </>
      )}
    </div>
  );
}

export interface FrameControlsProps {
  frame: LutFrame;
  split: number;
  onSplit: (split: number) => void;
  onFrame: (frame: LutFrame) => void;
  /** The slider and chips stay put while the frame says "not ready"; the chips may still work. */
  sliderDisabled: boolean;
}

/** The slider, the frame chips and the photo credit under the frame. */
export function FrameControls({
  frame,
  split,
  onSplit,
  onFrame,
  sliderDisabled,
}: FrameControlsProps) {
  return (
    <>
      <input
        type="range"
        min={0}
        max={100}
        value={clampSplit(split)}
        disabled={sliderDisabled}
        aria-label={LUT_PANE_TEXT.slider}
        onChange={(event) => onSplit(clampSplit(Number(event.currentTarget.value)))}
        className="m-0 cursor-pointer rounded accent-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-default disabled:opacity-50"
        style={{ width: LUT_PANE_FRAME.width }}
      />
      <div
        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
        style={{ width: LUT_PANE_FRAME.width }}
      >
        <fieldset className="m-0 inline-flex shrink-0 items-center gap-0.5 border-0 p-0">
          <legend className="sr-only">{LUT_PANE_TEXT.frames}</legend>
          {LUT_FRAME_CHIPS.map((chip) => (
            <button
              key={chip.frame}
              type="button"
              aria-pressed={chip.frame === frame}
              onClick={() => onFrame(chip.frame)}
              className={cn(
                'h-6 rounded-md px-2 text-xs font-medium outline-none transition-colors duration-150 ease-in-out focus-visible:ring-[3px] focus-visible:ring-ring/35',
                chip.frame === frame
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {chip.label}
            </button>
          ))}
        </fieldset>
        <span className="ml-auto text-right text-[11px] leading-tight text-muted-foreground/70">
          {frameCredit(frame)}
        </span>
      </div>
    </>
  );
}

/** The plain label / value list: 80 px labels, values that cut off with an ellipsis. */
export function PaneFacts({ facts }: { facts: readonly PaneFact[] }) {
  return (
    <dl
      data-slot="lut-facts"
      className="m-0 grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]"
    >
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="m-0 min-w-0 truncate" title={fact.value}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "To use it, write @luts/name in a note on a job." with the token in a small mono chip. */
export function UseLine({ slug }: { slug: string }) {
  return (
    <p data-slot="lut-use" className="m-0 text-[13px] text-muted-foreground">
      {LUT_PANE_TEXT.useLead}{' '}
      <span className="inline-block rounded-md border bg-card px-1.5 font-mono text-xs text-foreground">
        @luts/{slug}
      </span>{' '}
      {LUT_PANE_TEXT.useTail}
    </p>
  );
}

export interface LutPaneViewProps extends PreviewFrameProps {
  onSplit: (split: number) => void;
  onFrame: (frame: LutFrame) => void;
  /** Epoch ms, for "Added 2 days ago". */
  now: number;
  /** Notes can name a LUT (the lutsInEdits switch is on): the last line shows. */
  inEdits: boolean;
}

/** The whole pane for one LUT: header, frame, controls, note, facts and the last line. */
export function LutPaneView(props: LutPaneViewProps) {
  const { detail, now, inEdits } = props;
  const note = paneNote(detail);

  return (
    <section data-slot="lut-pane" aria-label="LUT preview" className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-lg leading-[1.35] font-semibold tracking-[-0.01em]">
          {detail.name}
        </h2>
        <span className="text-[13px] text-muted-foreground">{paneDescription(detail)}</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <PreviewFrame {...props} />
        <FrameControls
          frame={props.frame}
          split={props.split}
          onSplit={props.onSplit}
          onFrame={props.onFrame}
          sliderDisabled={props.failed}
        />
      </div>
      {note !== null && (
        <p data-slot="lut-note" className="m-0 text-[13px] text-pretty text-muted-foreground">
          {note}
        </p>
      )}
      <PaneFacts facts={paneFacts(detail, now)} />
      {inEdits && <UseLine slug={detail.slug} />}
    </section>
  );
}
