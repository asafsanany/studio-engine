// The studio's preview column (Graphics plan, "Preview"; board GRStudio). OWNER: GR3.
//
// Size (9:16 · 16:9 · 1:1) and Behind it (Sample frame · See-through · Black) above the picture; the
// picture is the looping <hyperframes-player> on the host page the engine makes for the version
// (routes/graphic-files.ts), through PreviewPlayer / LazyPreviewPlayer with `loop`; under it
// play/pause, play from the start, the timeline and the time.
//
// What changes the address changes the player: the size, the background, the version shown, and the
// text values (300 ms after the last keystroke). The new player loads behind the old one and takes
// its place at the same time, so a pause in typing never blanks the picture (GraphicPlayerStack).

import type { GraphicBackground, GraphicSize, GraphicSummary, GraphicVars } from '@studio/shared';
import { Suspense, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { GraphicControls } from './GraphicControls';
import { GraphicPlayerStack } from './GraphicPlayerStack';
import {
  DEFAULT_PREVIEW_BACKGROUND,
  DEFAULT_PREVIEW_SIZE,
  graphicHostUrl,
  isShowingOlder,
  playDurationSec,
  VALUES_DEBOUNCE_MS,
  varsParam,
} from './graphic-preview-logic';
import {
  MakingChip,
  MakingFirstPlaceholder,
  PictureOverlay,
  SizedBox,
  StageRoom,
  WaitingPlaceholder,
} from './PreviewStage';
import { PreviewToggles } from './PreviewToggles';
import { ShowingOldBar } from './ShowingOldBar';
import { useDebouncedValue } from './use-debounced-value';

/** What the preview needs to know of the graphic. A GraphicDetail or a GraphicSummary fits. */
export type PreviewGraphic = Pick<GraphicSummary, 'id' | 'lengthSec' | 'version' | 'makingVersion'>;

export interface GraphicPreviewProps {
  /** The graphic, or `undefined` while it loads (then the empty "Your graphic plays here"). */
  graphic: PreviewGraphic | undefined;
  /** The version on show. Left out: the one edits use (`graphic.version`). `null`: none yet. */
  shownVersion?: number | null;
  /** The version edits use, the newest one made. Left out: `graphic.version`. */
  newestVersion?: number | null;
  /** The text fields' values (variable id → text); left out, each field keeps its default. */
  values?: GraphicVars;
  /** The version being made, while one is. Left out: `graphic.makingVersion`. `null`: none. */
  making?: number | null;
  /** "Back to v2": show the newest version again. */
  onBackToNewest?(): void;
  /** "Use v1 again": make the version on show the one edits use. */
  onUseOld?(): void;
  /** Where the graphics API is. Only the dev gallery, which has no engine, changes it. */
  apiBase?: string;
  /** The toggles start here. */
  initialSize?: GraphicSize;
  initialBackground?: GraphicBackground;
  className?: string;
}

/** A tall room for the picture to fill, so the column never collapses where the parent has no height. */
const ROOM_MIN_HEIGHT = 'min-h-80';

/** What the Suspense shows while the player's code loads: the box and the dimmed bar. */
function LoadingStage({ size }: { size: GraphicSize }) {
  return (
    <div className="absolute inset-0 flex flex-col">
      <StageRoom>
        <SizedBox size={size} className="bg-[#111111]" />
      </StageRoom>
      <GraphicControls
        currentSec={0}
        durationSec={0}
        playing={false}
        disabled
        onTogglePlay={() => {}}
        onReplay={() => {}}
        onSeek={() => {}}
      />
    </div>
  );
}

/** No version to play: the dashed box ("Your graphic plays here" or "Making v1") and a dimmed bar. */
function EmptyStage({ size, making }: { size: GraphicSize; making: number | null }) {
  return (
    <div className="absolute inset-0 flex flex-col">
      <StageRoom>
        <SizedBox size={size}>
          {making === null ? <WaitingPlaceholder /> : <MakingFirstPlaceholder version={making} />}
        </SizedBox>
      </StageRoom>
      <GraphicControls
        currentSec={0}
        durationSec={0}
        playing={false}
        disabled
        onTogglePlay={() => {}}
        onReplay={() => {}}
        onSeek={() => {}}
      />
    </div>
  );
}

/**
 * The preview of a graphic. Give it a height (it fills the column it is in). GR5 mounts it in the
 * middle column with everything the About panel and the chat know; with only `graphic` it shows the
 * graphic's newest version at its default text.
 */
export function GraphicPreview({
  graphic,
  shownVersion,
  newestVersion,
  values,
  making,
  onBackToNewest,
  onUseOld,
  apiBase,
  initialSize = DEFAULT_PREVIEW_SIZE,
  initialBackground = DEFAULT_PREVIEW_BACKGROUND,
  className,
}: GraphicPreviewProps) {
  const [size, setSize] = useState<GraphicSize>(initialSize);
  const [background, setBackground] = useState<GraphicBackground>(initialBackground);

  const newest = newestVersion === undefined ? (graphic?.version ?? null) : newestVersion;
  const shown = shownVersion === undefined ? newest : shownVersion;
  const makingVersion = making === undefined ? (graphic?.makingVersion ?? null) : making;
  const showingOlder = isShowingOlder(shown, newest);

  // Typing changes `values` on every keystroke; the address follows 300 ms after the last one.
  const vars = useDebouncedValue(varsParam(values ?? {}), VALUES_DEBOUNCE_MS);
  const lengthSec = graphic?.lengthSec ?? null;

  const source = useMemo(
    () =>
      graphic === undefined || shown === null
        ? null
        : {
            src: graphicHostUrl({
              id: graphic.id,
              version: shown,
              size,
              background,
              vars,
              apiBase,
            }),
            size,
            durationSec: playDurationSec(lengthSec),
          },
    [graphic, shown, size, background, vars, apiBase, lengthSec],
  );

  return (
    <section
      data-slot="graphic-preview"
      aria-label="Preview"
      data-version={shown ?? undefined}
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-3 bg-[#0C0C0E] py-3',
        ROOM_MIN_HEIGHT,
        // The picture is video: square-cornered by the player, rounded and ringed here.
        '[&_[data-slot=preview-stage]>div]:rounded-md [&_[data-slot=preview-stage]>div]:ring-1 [&_[data-slot=preview-stage]>div]:ring-white/10',
        className,
      )}
    >
      <div className="px-4">
        <PreviewToggles
          size={size}
          background={background}
          onSizeChange={setSize}
          onBackgroundChange={setBackground}
        />
      </div>

      {showingOlder && shown !== null && newest !== null ? (
        <div className="px-4">
          <ShowingOldBar
            shown={shown}
            newest={newest}
            useDisabled={makingVersion !== null}
            onBackToNewest={() => onBackToNewest?.()}
            onUseOld={() => onUseOld?.()}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {source === null ? (
          <EmptyStage size={size} making={makingVersion} />
        ) : (
          <Suspense fallback={<LoadingStage size={size} />}>
            <GraphicPlayerStack source={source} />
          </Suspense>
        )}
        {source !== null && makingVersion !== null ? (
          <PictureOverlay size={size}>
            <MakingChip version={makingVersion} />
          </PictureOverlay>
        ) : null}
      </div>
    </section>
  );
}
