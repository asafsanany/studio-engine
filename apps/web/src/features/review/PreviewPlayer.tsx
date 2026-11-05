import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import { FontPreviewPill } from './FontPreviewPill';
import { CONTROLS_HEIGHT, fitPlayer } from './fit-player';
import { FixPill } from './fix/FixPill';
import { type FixPillPlan, fixPillFit, fixPillOf } from './fix/fix-pill';
import { type FontPreviewPlan, type FontPreviewStatus, fontPillOf } from './font-preview';
import { PlayerControls, type PlayerControlsProps } from './PlayerControls';
import { PlayerFrame, type PlayerFrameHandle, type PlayerReadyInfo } from './PlayerFrame';
import { PlayerError, PlayerSkeleton } from './PlayerStates';
import { choosePill } from './pill-choice';
import { createPlayerKeyHandlers, type PlayerShortcutTarget } from './player-shortcuts';
import {
  acceptTimeUpdate,
  changeVolume,
  clampSpeed,
  clampTime,
  DEFAULT_SPEED,
  DEFAULT_VOLUME,
  PLAYER_SKELETON_DELAY_MS,
  toggleMute,
} from './player-state';
import { VideoFrame } from './VideoFrame';

export type { PlayerReadyInfo } from './PlayerFrame';

/** What a caller (the Review dialog, the notes) can ask of the player. */
export interface PreviewPlayerHandle extends PlayerShortcutTarget {
  play(): void;
  pause(): void;
  togglePlay(): void;
  seek(seconds: number): void;
  seekBy(deltaSeconds: number): void;
  toggleMute(): void;
  toggleFullscreen(): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
  isFullscreen(): boolean;
}

export interface PreviewPlayerProps {
  /** The composition's index.html (W8: previewUrl(job.id, job.round)). */
  src: string;
  /** The composition's size (job.preview.width / height). */
  videoWidth: number;
  videoHeight: number;
  /** The largest video box outside full screen. The controls (CONTROLS_HEIGHT) come below it. */
  maxWidth: number;
  maxHeight: number;
  /** The length shown before the player is ready (job.preview.durationSec). */
  durationSec?: number;
  /**
   * A job with two formats (Generated videos): the column and the stage are as big as the largest
   * format's video box, so the dialog does not change size when the switch changes the format, and
   * the video of the smaller one sits in the middle of the black stage. `columnWidth` is the column's
   * width and `stageHeight` the stage's height, in px, outside full screen. Default: the column is
   * exactly as wide as the video and the stage as tall (no bars).
   */
  columnWidth?: number;
  stageHeight?: number;
  /** Play again from the start at the end, with no `ended`. Default off: Review plays once. */
  loop?: boolean;
  /**
   * The playback speed, set by the speed slider in the controls. Pass it with `onSpeedChange` to keep
   * one speed for several players (SwapPlayer's two); without it the player keeps its own, from 1×.
   */
  speed?: number;
  onSpeedChange?(speed: number): void;
  /** W10's note dots, drawn between the timeline's track and its thumb. */
  timelineOverlay?: ReactNode;
  /** Drawn at the right of the controls' buttons row, before full screen: what the video plays ("Music v2"). */
  controlsTrailing?: ReactNode;
  /**
   * The phone's layout (board MReview): the column is as wide as its parent, the video box is the
   * largest that fits the stage (the black area above the controls, measured; `maxWidth` and
   * `maxHeight` are only the size to start with), and the stage's own classes come from
   * `stageClassName` (it fills what the parent leaves, or has a height of its own).
   */
  fitToStage?: boolean;
  /** The stage's classes under `fitToStage`; default `shrink-0`. */
  stageClassName?: string;
  /**
   * Draws the controls in place of the bar under the video: it gets what the bar gets (the
   * playhead, the scrub handlers, play/pause), so the phone lays them out its own way. The player
   * keeps the state and the rules (pause while dragging, resume after).
   */
  renderControls?(controls: PlayerControlsProps): ReactNode;
  /**
   * The video can't start while this is true: a tap on it, the play button, the shortcuts and the
   * handle's `play` do nothing (pausing still works). The phone's Write and Record keep the frame
   * the note is about. Default false.
   */
  playLocked?: boolean;
  /**
   * A still drawn over the video until it first plays or is moved (`previewPosterUrl`). An iPhone
   * loads no video before a tap, so without it the phone's Review is black until Play. One that
   * fails to load is left out.
   */
  poster?: string;
  /** Play `src` as a plain MP4 (the phone's small preview video) instead of a live composition. */
  asVideo?: boolean;
  /**
   * Drawn inside the video box, over the picture and its click catcher (the look on the paused
   * frame, LU11). It should let clicks through (`pointer-events-none`) except on its own controls.
   */
  overlay?: ReactNode;
  /**
   * The fonts the note box names for the captions and the titles (FN19): the composition's page is
   * restyled with them while this is set, and the pill "Previewing @Heebo Bold" with Compare sits at
   * the bottom left of the video, over the picture. It is the pill that wins (`choosePill`): while it
   * shows, the look on the paused frame (`overlay`) is not drawn, so the live page is what is seen.
   * Only the live composition has a page to restyle; the phone's MP4 shows nothing. Default none:
   * nothing in the player changes.
   */
  fontPreview?: FontPreviewPlan | null;
  /**
   * The quick fixes of the job (QF7): the pill "Fixing at 0:12…" while one runs, and after one
   * landed, "Changed at 0:12" with Compare while the video is paused at its moment; holding Compare
   * lays the moment as it was over the video. Drawn at the bottom left like the font pill, and one
   * pill at a time (`choosePill`: the font pill, then this, then the look on the paused frame).
   * Default none: nothing in the player changes.
   */
  fixPill?: FixPillPlan | null;
  onReady?(info: PlayerReadyInfo): void;
  onTimeUpdate?(seconds: number): void;
  onPlayingChange?(playing: boolean): void;
  onError?(message: string): void;
  className?: string;
  ref?: Ref<PreviewPlayerHandle>;
}

type Status = 'loading' | 'ready' | 'error';

/** What the handle reads: the latest state and actions, as of the last render. */
interface Live extends PlayerShortcutTarget {
  ready: boolean;
  currentSec: number;
  durationSec: number;
  playing: boolean;
  fullscreen: boolean;
  play(): void;
  pause(): void;
}

/** Within this of the end the video counts as finished (the clock reads the same as the length). */
const END_EPSILON_SEC = 0.05;

/**
 * A live HyperFrames composition with our own controls and keyboard shortcuts. The column is
 * exactly as wide as the video (see `fitPlayer`): no bars, for 9:16 and for 16:9. Full screen
 * (the button or F) fits the video above a full-width controls bar.
 *
 * - A skeleton shows after 300 ms of loading; "The preview didn't load." with "Try again" on an
 *   error. Try again reloads the player.
 * - Load another composition by keying the player by `src` (`key={src}`). Changing `src` in place is
 *   not supported.
 * - Keyboard focus stays on our side: a click on the video lands on a click catcher, which moves
 *   focus to the column (`tabIndex={-1}`), because a click on the iframe would focus its document
 *   and from then on no key would reach our page. Inside the Review dialog the same click lands in
 *   its DialogContent, which carries the same handlers.
 */
export function PreviewPlayer({
  src,
  videoWidth,
  videoHeight,
  maxWidth,
  maxHeight,
  durationSec: durationProp,
  columnWidth,
  stageHeight,
  loop = false,
  speed: speedProp,
  onSpeedChange,
  timelineOverlay,
  controlsTrailing,
  fitToStage = false,
  stageClassName,
  renderControls,
  playLocked = false,
  poster,
  asVideo = false,
  overlay,
  fontPreview = null,
  fixPill = null,
  onReady,
  onTimeUpdate,
  onPlayingChange,
  onError,
  className,
  ref,
}: PreviewPlayerProps) {
  const columnRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PlayerFrameHandle>(null);
  const liveRef = useRef<Live | null>(null);
  /** Set while the timeline is being dragged: whether the video was playing when the drag began. */
  const scrubRef = useRef<{ wasPlaying: boolean } | null>(null);
  /** The last seek we made, until the player's reports have caught up with it (acceptTimeUpdate). */
  const seekRef = useRef<{ target: number; at: number } | null>(null);

  const [status, setStatus] = useState<Status>('loading');
  const [attempt, setAttempt] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [playerDurationSec, setPlayerDurationSec] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  /** The poster is over the video: until the first play or seek, or until it fails to load. */
  const [posterShown, setPosterShown] = useState(poster !== undefined);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [ownSpeed, setOwnSpeed] = useState(DEFAULT_SPEED);
  const speed = clampSpeed(speedProp ?? ownSpeed);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  /** The stage's size under `fitToStage`, once measured. */
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  /** What the page is showing of the font preview, and whether Compare is held (FN19). */
  const [fontStatus, setFontStatus] = useState<FontPreviewStatus | null>(null);
  const [comparingFonts, setComparingFonts] = useState(false);
  /** Compare is held on the fix pill: the moment as it was before the fix lies over the video (QF7). */
  const [comparingFix, setComparingFix] = useState(false);

  const Frame = asVideo ? VideoFrame : PlayerFrame;
  const ready = status === 'ready';
  const durationSec = playerDurationSec ?? durationProp ?? 0;
  const showSkeleton = useDelayedFlag(status === 'loading', PLAYER_SKELETON_DELAY_MS);
  // One pill at a time (pill-choice.ts): the font preview's, the quick fix's, the look on the paused
  // frame's. The pill that loses is not drawn, and neither is what comes with it (the look's still).
  // The font pill says what the page really shows, and only while the live page is the picture.
  const fontPill = fontPillOf({ asVideo, ready, plan: fontPreview, status: fontStatus });
  const fixView = fixPillOf({ plan: fixPill, ready, playing, currentSec });
  const pill = choosePill({
    font: fontPill !== null,
    fix: fixView !== null,
    look: Boolean(overlay),
  });
  const pillShown = pill === 'font';
  const fontsCompare = comparingFonts && pillShown;
  const fixShown = pill === 'fix' ? fixView : null;
  const fixCompare = comparingFix && fixShown?.kind === 'changed';

  const box = fullscreen
    ? fitPlayer({
        videoW: videoWidth,
        videoH: videoHeight,
        maxW: viewport.width,
        maxH: viewport.height - CONTROLS_HEIGHT,
      })
    : fitToStage
      ? fitPlayer({
          videoW: videoWidth,
          videoH: videoHeight,
          maxW: stage?.width ?? maxWidth,
          maxH: stage?.height ?? maxHeight,
        })
      : fitPlayer({ videoW: videoWidth, videoH: videoHeight, maxW: maxWidth, maxH: maxHeight });

  // A pill that goes away lets go of Compare: it is not held when the pill comes back.
  useEffect(() => {
    if (!pillShown) setComparingFonts(false);
  }, [pillShown]);
  const fixCanCompare = fixShown?.kind === 'changed';
  useEffect(() => {
    if (!fixCanCompare) setComparingFix(false);
  }, [fixCanCompare]);

  // ---- Actions. Each one does nothing unless the player is ready. ----

  function seek(seconds: number) {
    if (!ready) return;
    const t = clampTime(seconds, durationSec);
    frameRef.current?.seek(t);
    setPosterShown(false);
    // Don't wait for the player's next timeupdate: the clock and the timeline move now. A report
    // already on its way still carries the time before this seek: handleTimeUpdate ignores it.
    seekRef.current = { target: t, at: performance.now() };
    setCurrentSec(t);
    onTimeUpdate?.(t);
  }

  function play() {
    if (ready && !playLocked) frameRef.current?.play();
  }

  function pause() {
    if (ready) frameRef.current?.pause();
  }

  function togglePlay() {
    if (!ready) return;
    if (playing) {
      pause();
      return;
    }
    if (playLocked) return;
    if (durationSec > 0 && currentSec >= durationSec - END_EPSILON_SEC) seek(0);
    play();
  }

  function seekBy(deltaSeconds: number) {
    seek(currentSec + deltaSeconds);
  }

  function toggleMuted() {
    if (!ready) return;
    const next = toggleMute({ muted, volume });
    setMuted(next.muted);
    setVolume(next.volume);
  }

  function changeVolumeTo(value: number) {
    const next = changeVolume(value);
    setMuted(next.muted);
    setVolume(next.volume);
  }

  function changeSpeedTo(value: number) {
    const next = clampSpeed(value);
    setOwnSpeed(next);
    onSpeedChange?.(next);
  }

  function toggleFullscreen() {
    if (!ready) return;
    const done = (request: Promise<void> | undefined) => request?.catch(() => {});
    if (document.fullscreenElement) done(document.exitFullscreen());
    // Safari on iPhone has no element full screen: there is no `requestFullscreen` to call.
    else if (columnRef.current?.requestFullscreen) done(columnRef.current.requestFullscreen());
  }

  // ---- Scrubbing: pause while the timeline is dragged, play again after it, if it was playing. ----

  function scrub(seconds: number) {
    if (!ready) return;
    if (scrubRef.current === null) {
      scrubRef.current = { wasPlaying: playing };
      if (playing) pause();
    }
    setScrubSec(seconds);
    seek(seconds);
  }

  function commitScrub(seconds: number) {
    if (!ready) return;
    seek(seconds);
    const resume = scrubRef.current?.wasPlaying === true;
    scrubRef.current = null;
    setScrubSec(null);
    if (resume) play();
  }

  function retry() {
    scrubRef.current = null;
    setScrubSec(null);
    seekRef.current = null;
    setFontStatus(null);
    setStatus('loading');
    setCurrentSec(0);
    setPlaying(false);
    setAttempt((n) => n + 1);
  }

  // The handle reads the latest state through a ref that every render updates, so it can be made
  // once and never goes stale.
  useLayoutEffect(() => {
    liveRef.current = {
      ready,
      currentSec,
      durationSec,
      playing,
      fullscreen,
      play,
      pause,
      togglePlay,
      seek,
      seekBy,
      toggleMute: toggleMuted,
      toggleFullscreen,
    };
  });

  const handle = useMemo<PreviewPlayerHandle>(
    () => ({
      play: () => liveRef.current?.play(),
      pause: () => liveRef.current?.pause(),
      togglePlay: () => liveRef.current?.togglePlay(),
      seek: (seconds) => liveRef.current?.seek(seconds),
      seekBy: (deltaSeconds) => liveRef.current?.seekBy(deltaSeconds),
      toggleMute: () => liveRef.current?.toggleMute(),
      toggleFullscreen: () => liveRef.current?.toggleFullscreen(),
      getCurrentTime: () => liveRef.current?.currentSec ?? 0,
      getDuration: () => liveRef.current?.durationSec ?? 0,
      isPlaying: () => liveRef.current?.playing ?? false,
      isFullscreen: () => liveRef.current?.fullscreen ?? false,
    }),
    [],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  // The column's own shortcuts work as soon as anything inside the player has focus. Until the
  // player is ready there is nothing to drive, so they let the keys through (Space must still
  // press "Try again"). W8 puts the same handlers on its dialog; a key one of them took is
  // default-prevented, so the other skips it.
  const ownShortcuts = useMemo(
    () => createPlayerKeyHandlers(() => (liveRef.current?.ready ? handle : null)),
    [handle],
  );

  // ---- Full screen: the column is the full screen element, controls included. ----

  useEffect(() => {
    function sync() {
      const column = columnRef.current;
      const on = column !== null && document.fullscreenElement === column;
      setFullscreen(on);
      if (!on) return;
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      // Shortcuts need focus inside the column, also when full screen was started from elsewhere.
      if (!column.contains(document.activeElement)) column.focus({ preventScroll: true });
    }
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    function measure() {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fullscreen]);

  // ---- Under `fitToStage` the stage's size is the video's room: follow it. ----

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!fitToStage || element === null) return;
    function measure() {
      const { clientWidth, clientHeight } = element as HTMLDivElement;
      setStage((previous) =>
        previous?.width === clientWidth && previous.height === clientHeight
          ? previous
          : { width: clientWidth, height: clientHeight },
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitToStage]);

  // ---- What the player tells us. ----

  function handleReady(info: PlayerReadyInfo) {
    if (info.width !== videoWidth || info.height !== videoHeight) {
      console.warn(
        `The preview is ${info.width}×${info.height}, not the ${videoWidth}×${videoHeight} it was sized for; keeping the latter.`,
      );
    }
    setPlayerDurationSec(info.durationSec);
    setStatus('ready');
    onReady?.(info);
  }

  function handleTimeUpdate(seconds: number) {
    const seeked = seekRef.current;
    const accepted = acceptTimeUpdate({
      seekTarget: seeked?.target ?? null,
      seekAt: seeked?.at ?? null,
      now: performance.now(),
      reported: seconds,
    });
    if (!accepted) return;
    seekRef.current = null;
    setCurrentSec(seconds);
    onTimeUpdate?.(seconds);
  }

  function handlePlayingChange(isPlaying: boolean) {
    setPlaying(isPlaying);
    if (isPlaying) setPosterShown(false);
    onPlayingChange?.(isPlaying);
  }

  function handleError(message: string) {
    setStatus('error');
    setPlaying(false);
    onError?.(message);
  }

  const controls: PlayerControlsProps = {
    disabled: !ready,
    currentSec: scrubSec ?? currentSec,
    durationSec,
    playing,
    muted,
    volume,
    fullscreen,
    speed,
    timelineOverlay,
    trailing: controlsTrailing,
    onTogglePlay: togglePlay,
    onSeek: scrub,
    onSeekCommit: commitScrub,
    onToggleMute: toggleMuted,
    onVolumeChange: changeVolumeTo,
    onSpeedChange: changeSpeedTo,
    onToggleFullscreen: toggleFullscreen,
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group around the player and its controls
    <div
      ref={columnRef}
      data-slot="preview-player"
      data-status={status}
      role="group"
      aria-label="Preview"
      tabIndex={-1}
      {...ownShortcuts}
      className={cn(
        'flex flex-col bg-black outline-none',
        (fullscreen || fitToStage) && 'w-full',
        fullscreen && 'h-full',
        className,
      )}
      style={fullscreen || fitToStage ? undefined : { width: columnWidth ?? box.width }}
    >
      <div
        ref={stageRef}
        data-slot="preview-stage"
        className={cn(
          'flex items-center justify-center bg-black',
          fullscreen ? 'min-h-0 flex-1' : fitToStage ? (stageClassName ?? 'shrink-0') : 'shrink-0',
        )}
        style={
          stageHeight === undefined || fullscreen || fitToStage
            ? undefined
            : { height: stageHeight }
        }
      >
        {/* The box that clips the picture sits inside one of its own size, so a pill that is wider than
            a narrow video (the phone's quick fix pill) can reach past its edge onto the stage. */}
        <div className="relative" style={{ width: box.width, height: box.height }}>
          <div
            className="relative overflow-hidden bg-[#111111]"
            style={{ width: box.width, height: box.height }}
          >
            {status === 'error' ? null : (
              <Frame
                key={attempt}
                ref={frameRef}
                src={src}
                width={box.width}
                height={box.height}
                compositionWidth={videoWidth}
                compositionHeight={videoHeight}
                muted={muted}
                volume={volume}
                loop={loop}
                playbackRate={speed}
                fonts={asVideo ? null : fontPreview}
                fontsCompare={fontsCompare}
                onFontPreview={setFontStatus}
                onReady={handleReady}
                onDurationChange={setPlayerDurationSec}
                onTimeUpdate={handleTimeUpdate}
                onPlayingChange={handlePlayingChange}
                onEnded={() => setCurrentSec(durationSec)}
                onError={handleError}
              />
            )}
            {poster !== undefined && posterShown && status !== 'error' ? (
              <img
                src={poster}
                alt=""
                aria-hidden="true"
                draggable={false}
                data-slot="preview-poster"
                className="pointer-events-none absolute inset-0 size-full object-contain"
                onError={() => setPosterShown(false)}
              />
            ) : null}
            {ready ? (
              <div
                aria-hidden="true"
                className="absolute inset-0 cursor-pointer"
                onClick={togglePlay}
              />
            ) : null}
            {ready && pill === 'look' ? overlay : null}
            {fixShown?.kind === 'changed' && fixShown.beforeSrc !== null ? (
              // The moment as it was, over the video and fitted like it. It is there (invisible) from
              // the first look at the pill, so holding Compare shows it at once and nothing moves.
              <img
                src={fixShown.beforeSrc}
                alt=""
                aria-hidden="true"
                draggable={false}
                data-slot="fix-compare-still"
                data-shown={fixCompare ? '' : undefined}
                className={cn(
                  'pointer-events-none absolute inset-0 block size-full object-cover transition-opacity duration-150 ease-in-out',
                  fixCompare ? 'opacity-100' : 'opacity-0',
                )}
              />
            ) : null}
            {pill === 'font' && fontPill ? (
              <FontPreviewPill
                shown={fontPill.shown}
                comparing={fontsCompare}
                onCompare={setComparingFonts}
              />
            ) : null}
            {/* The poster is the loading picture while it shows. */}
            {status === 'loading' && showSkeleton && !(poster !== undefined && posterShown) ? (
              <PlayerSkeleton />
            ) : null}
            {status === 'error' ? <PlayerError onRetry={retry} /> : null}
          </div>
          {fixShown ? (
            <FixPill
              view={fixShown}
              comparing={fixCompare}
              onCompare={setComparingFix}
              fit={fixPillFit({ phone: fitToStage, videoWidth: box.width })}
            />
          ) : null}
        </div>
      </div>
      {renderControls ? renderControls(controls) : <PlayerControls {...controls} />}
    </div>
  );
}
