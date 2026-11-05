import type { LutDetail, LutFrame } from '@studio/shared';
import { useReducer, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Skeleton } from '@/components/ui/skeleton';
import { useLut, useLutsInEditsEnabled } from '@/data';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { LutPaneEmpty, LutPaneView } from './LutPaneView';
import {
  DEFAULT_LUT_SPLIT,
  LUT_PANE_FRAME,
  LUT_PANE_TEXT,
  PREVIEW_LOADING,
  previewLoading,
  previewLoadReducer,
  readStoredFrame,
  storeFrame,
} from './lut-pane-model';

/** What the LUTs page hands the pane (LUTs plan, "The page (web)"). */
export interface LutPaneProps {
  /** The LUT to show (a slug), or `null` when the list has none. */
  slug: string | null;
}

/**
 * The 440 px side pane (boards LUPage and LUStates): name and description, the 252×448 frame with
 * the Before / After slider, the frame chips Person · Street · Interior, the photo credit, the
 * note of a Camera or Fix LUT, the facts (Kind, Size, File, Used in, Added) and, once notes can
 * name a LUT, "To use it, write @luts/name in a note on a job.". OWNER: LU4.
 *
 * The slider position and the chosen frame belong to the pane, not to one LUT: moving to the next
 * row keeps both, so two LUTs compare on the same frame. The frame is also remembered between
 * visits (`studio.luts.frame`).
 */
export function LutPane({ slug }: LutPaneProps) {
  if (slug === null) return <LutPaneEmpty />;
  return <OpenLutPane slug={slug} />;
}

/** The pane while the LUT's facts are on their way: the frame's outline, a skeleton after 250 ms. */
function PaneLoading({ show }: { show: boolean }) {
  return (
    <section data-slot="lut-pane" aria-label="LUT preview" aria-busy="true">
      {show && (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton
            className="self-center rounded-lg"
            style={{ width: LUT_PANE_FRAME.width, height: LUT_PANE_FRAME.height }}
          />
        </div>
      )}
    </section>
  );
}

function OpenLutPane({ slug }: { slug: string }) {
  const lut = useLut(slug);
  const detail = lut.data;
  const [frame, setFrame] = useState<LutFrame>(() => readStoredFrame());
  const [split, setSplit] = useState(DEFAULT_LUT_SPLIT);
  const showLoading = useDelayedFlag(detail === undefined && lut.isPending, SKELETON_DELAY_MS);

  if (detail === undefined) {
    if (lut.isError) return <LutPaneEmpty text={LUT_PANE_TEXT.gone} />;
    return <PaneLoading show={showLoading} />;
  }

  return (
    <LoadedLutPane
      // Another LUT, a changed file or another frame starts its stills over.
      key={`${detail.slug}|${detail.file}|${detail.bytes}|${frame}`}
      detail={detail}
      frame={frame}
      split={split}
      onSplit={setSplit}
      onFrame={(next) => {
        setFrame(next);
        storeFrame(next);
      }}
    />
  );
}

interface LoadedLutPaneProps {
  detail: LutDetail;
  frame: LutFrame;
  split: number;
  onSplit: (split: number) => void;
  onFrame: (frame: LutFrame) => void;
}

/** One LUT on one frame: owns what its two stills are doing. */
function LoadedLutPane({ detail, frame, split, onSplit, onFrame }: LoadedLutPaneProps) {
  const inEdits = useLutsInEditsEnabled();
  const now = useNow();
  const [retry, setRetry] = useState(0);
  const [load, dispatch] = useReducer(previewLoadReducer, PREVIEW_LOADING);
  // The skeleton waits 250 ms, so a still that comes straight away never flashes one.
  const showSkeleton = useDelayedFlag(previewLoading(load), SKELETON_DELAY_MS);

  return (
    <LutPaneView
      detail={detail}
      frame={frame}
      split={split}
      retry={retry}
      failed={load.failed}
      ready={load.before && load.after}
      showSkeleton={showSkeleton}
      onLoaded={(side) => dispatch({ type: 'loaded', side })}
      onFailed={() => dispatch({ type: 'failed' })}
      onRetry={() => {
        dispatch({ type: 'reset' });
        setRetry((count) => count + 1);
      }}
      onSplit={onSplit}
      onFrame={onFrame}
      now={now}
      inEdits={inEdits}
    />
  );
}
