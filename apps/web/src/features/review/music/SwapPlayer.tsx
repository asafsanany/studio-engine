import {
  type Reducer,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { previewFixRev } from '@/data';
import {
  initialSwap,
  type PlayerSource,
  playersToDraw,
  type SwapAction,
  type SwapState,
  swapReducer,
} from '@/features/graphics/studio/graphic-preview-swap';
import { cn } from '@/lib/utils';
import type { FixLanding } from '../fix/fix-landing';
import { LazyPreviewPlayer } from '../LazyPreviewPlayer';
import type { PlayerReadyInfo, PreviewPlayerHandle, PreviewPlayerProps } from '../PreviewPlayer';

export type SwapPlayerProps = PreviewPlayerProps & {
  /** A quick fix has landed: where the player that first carries its rev goes, paused. Default none. */
  landOn?: FixLanding | null;
};

/**
 * A player's address, whether it plays an MP4 (the phone's small preview) or the live edit, and the
 * size of its composition: a job with two formats swaps one format's player for the other's, and
 * the one on show keeps its own size until the new one replaces it.
 */
type ReviewSource = PlayerSource & { asVideo: boolean; videoWidth: number; videoHeight: number };
type PlayerSwap = SwapState<ReviewSource>;
type PlayerSwapAction = SwapAction<ReviewSource>;

/** Loading behind the one on show: laid out (it needs a size to load), but not seen or reachable. */
const HIDDEN = 'pointer-events-none invisible absolute inset-0';

/**
 * Puts the player that has just loaded where the one on show is: the old one stops, the new one goes
 * to the time the old one was at and plays on if the old one was playing. The old one is stopped
 * first, so two soundtracks never play together.
 */
export function placeNext({
  shown,
  next,
  sec,
  playing,
}: {
  shown: Pick<PreviewPlayerHandle, 'pause'> | undefined;
  next: Pick<PreviewPlayerHandle, 'seek' | 'play'> | undefined;
  sec: number;
  playing: boolean;
}): void {
  if (playing) shown?.pause();
  next?.seek(sec);
  if (playing) next?.play();
}

/**
 * Puts the player that has just loaded with a quick fix in it at the fix's moment, and stops it
 * there (Quick fixes, QF7): the old one stops first (it may be playing), the new one goes to `sec`
 * and stays paused, so the change is seen at once. Unlike `placeNext`, it does not go back to where
 * the old one was, and does not play on.
 */
export function landNext({
  shown,
  next,
  sec,
  playing,
}: {
  shown: Pick<PreviewPlayerHandle, 'pause'> | undefined;
  next: Pick<PreviewPlayerHandle, 'seek' | 'pause'> | undefined;
  sec: number;
  playing: boolean;
}): void {
  if (playing) shown?.pause();
  next?.seek(sec);
  next?.pause();
}

/**
 * Whether the player at `next` is the first to carry the fix rev of `landing`: its address has the
 * rev and the one on show (`shown`) does not. A later swap for another reason (a music pick, the
 * phone's MP4 taking over from the live preview) carries the same rev on both sides, so it keeps the
 * time and the play state as ever.
 */
export function landsOn(landing: FixLanding | null, shown: string, next: string): boolean {
  return (
    landing !== null && previewFixRev(next) === landing.rev && previewFixRev(shown) !== landing.rev
  );
}

/** What a player that loaded behind the one on show answered. */
type Answer = { ok: true; info: PlayerReadyInfo } | { ok: false; message: string };

/**
 * The review's player, which follows its `src` without a blank in between. Review keys the player by
 * its address, and the address now carries the music's `rev`: when Make another finishes or a
 * version is picked, the same cut has to load again with the new soundtrack. A new `src` loads in a
 * second player, hidden, in the same place; the one on show plays on until the new one is ready.
 * Then the new one is put at the time the old one was at, plays if it was playing, and replaces it
 * (`placeNext`); to the page this is one player that never stopped. The reducer is the Graphics
 * preview's (graphic-preview-swap.ts), which does the same for a toggle or a new text.
 *
 * It takes what `PreviewPlayer` takes (`src` is the address that should be on show), and its
 * handle drives the player on show. Only that player's `onReady`, `onTimeUpdate`, `onPlayingChange`
 * and `onError` are heard, and `onReady` (or `onError`) is heard again when a new one takes its
 * place, so the page learns its length and the player is ready for the shortcuts. A new player that
 * fails to load is put in place as it is, so its error shows (with Try again).
 *
 * The speed is one for all of them: the slider moves the player on show and the one loading behind
 * it, so a new soundtrack plays on at the speed it was at.
 *
 * With `landOn` (a quick fix has landed, QF7) the first player that carries the fix's rev in its
 * address is not put back where the old one was: it goes to the fix's moment and stays paused there
 * (`landNext`), and the page is told so (the time, and that nothing plays).
 */
export function SwapPlayer({
  src,
  className,
  poster,
  overlay,
  onReady,
  onTimeUpdate,
  onPlayingChange,
  onError,
  ref,
  asVideo = false,
  landOn = null,
  ...rest
}: SwapPlayerProps) {
  // Each player keeps the kind it was made as: the phone swaps from the live edit to its MP4 (and
  // back) when the music changes, and the one on show must not turn into the other kind.
  const { videoWidth, videoHeight } = rest;
  const source = useMemo<ReviewSource>(
    () => ({ src, asVideo, videoWidth, videoHeight }),
    [src, asVideo, videoWidth, videoHeight],
  );
  const [speed, setSpeed] = useState(1);
  const [swap, dispatch] = useReducer(
    swapReducer as Reducer<PlayerSwap, PlayerSwapAction>,
    source,
    initialSwap<ReviewSource>,
  );
  useEffect(() => {
    dispatch({ type: 'want', source });
  }, [source]);

  /** Every drawn player's handle, by address. */
  const handles = useRef(new Map<string, PreviewPlayerHandle>());
  /** What each player answered when it loaded, by address. */
  const answers = useRef(new Map<string, Answer>());
  /** Players that were replaced: what they say while they are going is not heard. */
  const retired = useRef(new Set<string>());
  /** Where the player on show was last, so the next one can go back there. */
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const shownSrc = swap.shown?.src ?? null;
  const shownRef = useRef(shownSrc);
  shownRef.current = shownSrc;

  // The page's callbacks as of the last render, so a new one never reaches a stale player.
  const callbacks = useRef({ onReady, onTimeUpdate, onPlayingChange, onError });
  callbacks.current = { onReady, onTimeUpdate, onPlayingChange, onError };
  const landingRef = useRef(landOn);
  landingRef.current = landOn;

  // A player answered: put it in place. This runs after React has rendered the player as ready, so
  // its handle acts.
  const { answered } = swap;
  useEffect(() => {
    if (answered === null) return;
    const answer = answers.current.get(answered.src);
    const onShow = shownRef.current;
    if (onShow !== null && answered.src !== onShow) {
      const landing = landingRef.current;
      if (answered.ok && landing !== null && landsOn(landing, onShow, answered.src)) {
        landNext({
          shown: handles.current.get(onShow),
          next: handles.current.get(answered.src),
          sec: landing.sec,
          playing: playingRef.current,
        });
        // What the new player says is not heard until it is on show: the page learns of the move now.
        timeRef.current = landing.sec;
        playingRef.current = false;
        callbacks.current.onTimeUpdate?.(landing.sec);
        callbacks.current.onPlayingChange?.(false);
      } else if (answered.ok) {
        placeNext({
          shown: handles.current.get(onShow),
          next: handles.current.get(answered.src),
          sec: timeRef.current,
          playing: playingRef.current,
        });
      }
      retired.current.add(onShow);
      // The page hears the new player as it heard the first: ready (its length), or failed.
      if (answer?.ok) callbacks.current.onReady?.(answer.info);
      else if (answer) callbacks.current.onError?.(answer.message);
    }
    dispatch({ type: 'placed', src: answered.src });
  }, [answered]);

  // The old players are gone once the swap is done: forget them.
  useEffect(() => {
    const drawn = new Set(playersToDraw(swap).map((player) => player.src));
    for (const address of retired.current) if (!drawn.has(address)) retired.current.delete(address);
    for (const address of answers.current.keys())
      if (!drawn.has(address)) answers.current.delete(address);
  }, [swap]);

  const register = useCallback((address: string, handle: PreviewPlayerHandle | null) => {
    if (handle === null) handles.current.delete(address);
    else handles.current.set(address, handle);
  }, []);

  const heard = useCallback((address: string) => {
    return address === shownRef.current && !retired.current.has(address);
  }, []);

  const handleReady = useCallback(
    (address: string, info: PlayerReadyInfo) => {
      answers.current.set(address, { ok: true, info });
      // The one on show is heard now; a new one is heard when it takes its place.
      if (heard(address)) callbacks.current.onReady?.(info);
      dispatch({ type: 'answered', src: address, ok: true });
    },
    [heard],
  );

  const handleError = useCallback(
    (address: string, message: string) => {
      answers.current.set(address, { ok: false, message });
      if (heard(address)) callbacks.current.onError?.(message);
      dispatch({ type: 'answered', src: address, ok: false });
    },
    [heard],
  );

  const handleTime = useCallback(
    (address: string, seconds: number) => {
      if (!heard(address)) return;
      timeRef.current = seconds;
      callbacks.current.onTimeUpdate?.(seconds);
    },
    [heard],
  );

  const handlePlaying = useCallback(
    (address: string, playing: boolean) => {
      if (!heard(address)) return;
      playingRef.current = playing;
      callbacks.current.onPlayingChange?.(playing);
    },
    [heard],
  );

  // The handle drives whichever player is on show.
  useImperativeHandle(ref, (): PreviewPlayerHandle => {
    const onShow = () => {
      const address = shownRef.current;
      return address === null ? undefined : handles.current.get(address);
    };
    return {
      play: () => onShow()?.play(),
      pause: () => onShow()?.pause(),
      togglePlay: () => onShow()?.togglePlay(),
      seek: (seconds) => onShow()?.seek(seconds),
      seekBy: (deltaSeconds) => onShow()?.seekBy(deltaSeconds),
      toggleMute: () => onShow()?.toggleMute(),
      toggleFullscreen: () => onShow()?.toggleFullscreen(),
      getCurrentTime: () => onShow()?.getCurrentTime() ?? 0,
      getDuration: () => onShow()?.getDuration() ?? 0,
      isPlaying: () => onShow()?.isPlaying() ?? false,
      isFullscreen: () => onShow()?.isFullscreen() ?? false,
    };
  }, []);

  return playersToDraw(swap).map((drawn) => (
    <PlayerSlot
      key={drawn.src}
      {...rest}
      speed={speed}
      onSpeedChange={setSpeed}
      src={drawn.src}
      asVideo={drawn.asVideo}
      // The wanted player is sized as the page says now; one that is leaving keeps the size it had.
      videoWidth={drawn.src === src ? videoWidth : drawn.videoWidth}
      videoHeight={drawn.src === src ? videoHeight : drawn.videoHeight}
      // A still is for the first load; a player that loads behind has none.
      poster={drawn.src === swap.shown?.src ? poster : undefined}
      // The look on the paused frame belongs to the player on show, not to one loading behind it.
      overlay={drawn.src === swap.shown?.src ? overlay : undefined}
      className={cn(className, drawn.src !== shownSrc && HIDDEN)}
      register={register}
      onAnswer={handleReady}
      onFail={handleError}
      onTime={handleTime}
      onPlaying={handlePlaying}
    />
  ));
}

type SlotProps = Omit<
  PreviewPlayerProps,
  'ref' | 'onReady' | 'onError' | 'onTimeUpdate' | 'onPlayingChange'
> & {
  register(address: string, handle: PreviewPlayerHandle | null): void;
  onAnswer(address: string, info: PlayerReadyInfo): void;
  onFail(address: string, message: string): void;
  onTime(address: string, seconds: number): void;
  onPlaying(address: string, playing: boolean): void;
};

/** One player, which tells the stack what it says under its own address. */
function PlayerSlot({ src, register, onAnswer, onFail, onTime, onPlaying, ...rest }: SlotProps) {
  const setHandle = useCallback(
    (handle: PreviewPlayerHandle | null) => register(src, handle),
    [register, src],
  );
  return (
    <LazyPreviewPlayer
      {...rest}
      ref={setHandle}
      src={src}
      onReady={(info) => onAnswer(src, info)}
      onError={(message) => onFail(src, message)}
      onTimeUpdate={(seconds) => onTime(src, seconds)}
      onPlayingChange={(playing) => onPlaying(src, playing)}
    />
  );
}
