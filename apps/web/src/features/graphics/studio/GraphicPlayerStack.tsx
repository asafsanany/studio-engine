import { GRAPHIC_SIZE_PIXELS, type GraphicSize } from '@studio/shared';
import { type Reducer, useCallback, useEffect, useReducer, useRef } from 'react';
import { LazyPreviewPlayer } from '@/features/review/LazyPreviewPlayer';
import type { PreviewPlayerHandle } from '@/features/review/PreviewPlayer';
import { cn } from '@/lib/utils';
import { GraphicControls } from './GraphicControls';
import {
  initialSwap,
  playersToDraw,
  type SwapAction,
  type SwapState,
  swapReducer,
} from './graphic-preview-swap';

/** One host address to play, with the size it is for and the length to show before it is ready. */
export interface GraphicPlayerSource {
  src: string;
  size: GraphicSize;
  /** The loop's length before the player reports it (the graphic's length plus the tail). */
  durationSec?: number;
}

type PlayerSwap = SwapState<GraphicPlayerSource>;
type PlayerSwapAction = SwapAction<GraphicPlayerSource>;

export interface GraphicPlayerStackProps {
  /** The host address that should be on show. A new `src` is loaded behind the one on show. */
  source: GraphicPlayerSource;
}

/**
 * The looping picture and its bar. A new `source.src` (a toggle, a version, the text fields after a
 * pause) is a new player: it loads hidden, in the same place, and the old one stays on show until
 * the new one is ready; then the new one is put at the time the old one was at, plays if it was
 * playing, and replaces it. So changing the text never blanks the picture. See graphic-preview-
 * swap.ts. Each player is a PreviewPlayer keyed by its address (it does not support a changed
 * `src`), looping, fitted to the room the parent gives it, with `GraphicControls` as its bar.
 *
 * It fills the nearest positioned ancestor (every player is `absolute inset-0`).
 */
export function GraphicPlayerStack({ source }: GraphicPlayerStackProps) {
  const [swap, dispatch] = useReducer(
    swapReducer as Reducer<PlayerSwap, PlayerSwapAction>,
    source,
    initialSwap<GraphicPlayerSource>,
  );

  useEffect(() => {
    dispatch({ type: 'want', source });
  }, [source]);

  /** Every drawn player's handle, by address. */
  const handles = useRef(new Map<string, PreviewPlayerHandle>());
  /** Where the player on show was last, so the next one can go back there. */
  const timeRef = useRef(0);
  /** Whether the player on show is playing: the loop starts playing. */
  const playingRef = useRef(true);
  const shownSrc = swap.shown?.src ?? null;
  const shownRef = useRef(shownSrc);
  shownRef.current = shownSrc;

  // A player answered: put it in place. This runs after React has rendered the player as ready, so
  // its handle acts. A failed one is put in place as it is, so the error shows.
  const { answered } = swap;
  useEffect(() => {
    if (answered === null) return;
    if (answered.ok) {
      const handle = handles.current.get(answered.src);
      if (handle) {
        handle.seek(timeRef.current);
        if (playingRef.current) handle.play();
      }
    }
    dispatch({ type: 'placed', src: answered.src });
  }, [answered]);

  const register = useCallback((src: string, handle: PreviewPlayerHandle | null) => {
    if (handle === null) handles.current.delete(src);
    else handles.current.set(src, handle);
  }, []);
  const answer = useCallback((src: string, ok: boolean) => {
    dispatch({ type: 'answered', src, ok });
  }, []);
  const timeUpdate = useCallback((src: string, seconds: number) => {
    if (src === shownRef.current) timeRef.current = seconds;
  }, []);
  const playingChange = useCallback((src: string, playing: boolean) => {
    if (src === shownRef.current) playingRef.current = playing;
  }, []);
  const replay = useCallback((src: string) => {
    const handle = handles.current.get(src);
    handle?.seek(0);
    handle?.play();
  }, []);

  return playersToDraw(swap).map((drawn) => (
    <PlayerSlot
      key={drawn.src}
      source={drawn}
      hidden={drawn.src !== shownSrc}
      register={register}
      onAnswer={answer}
      onTimeUpdate={timeUpdate}
      onPlayingChange={playingChange}
      onReplay={replay}
    />
  ));
}

interface PlayerSlotProps {
  source: GraphicPlayerSource;
  /** Loading behind the one on show: laid out, but not seen or reachable. */
  hidden: boolean;
  register(src: string, handle: PreviewPlayerHandle | null): void;
  onAnswer(src: string, ok: boolean): void;
  onTimeUpdate(src: string, seconds: number): void;
  onPlayingChange(src: string, playing: boolean): void;
  onReplay(src: string): void;
}

function PlayerSlot({
  source,
  hidden,
  register,
  onAnswer,
  onTimeUpdate,
  onPlayingChange,
  onReplay,
}: PlayerSlotProps) {
  const { src, size, durationSec } = source;
  const { width, height } = GRAPHIC_SIZE_PIXELS[size];
  const setHandle = useCallback(
    (handle: PreviewPlayerHandle | null) => register(src, handle),
    [register, src],
  );
  return (
    <LazyPreviewPlayer
      ref={setHandle}
      src={src}
      videoWidth={width}
      videoHeight={height}
      // Only the size to start with: `fitToStage` measures the room and takes over.
      maxWidth={320}
      maxHeight={320}
      durationSec={durationSec}
      loop
      fitToStage
      className={cn('absolute inset-0 bg-transparent', hidden && 'pointer-events-none invisible')}
      stageClassName="m-3 min-h-0 flex-1 bg-transparent"
      onReady={() => onAnswer(src, true)}
      onError={() => onAnswer(src, false)}
      onTimeUpdate={(seconds) => onTimeUpdate(src, seconds)}
      onPlayingChange={(playing) => onPlayingChange(src, playing)}
      renderControls={(controls) => (
        <GraphicControls
          currentSec={controls.currentSec}
          durationSec={controls.durationSec}
          playing={controls.playing}
          disabled={controls.disabled}
          onTogglePlay={controls.onTogglePlay}
          onReplay={() => onReplay(src)}
          onSeek={controls.onSeek}
          onSeekCommit={controls.onSeekCommit}
        />
      )}
    />
  );
}
