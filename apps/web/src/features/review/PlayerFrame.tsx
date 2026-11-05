import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { type FontPreviewPlan, type FontPreviewStatus, NOTHING_SHOWN } from './font-preview';
import { FontPreviewApplier } from './font-preview-dom';
import { type HyperframesPlayer, loadPlayerElement, PLAYER_RUNTIME_SRC } from './player-element';
import { unlockMedia } from './unlock-media';

export interface PlayerReadyInfo {
  durationSec: number;
  /** The composition's own size, as the player reports it. */
  width: number;
  height: number;
}

export interface PlayerFrameHandle {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
}

export interface PlayerFrameProps {
  /** The composition's index.html. */
  src: string;
  /** The display box, in CSS px (the player scales the composition to fit it). */
  width: number;
  height: number;
  /** The composition's size: the player uses it only for the aspect ratio before it is ready. */
  compositionWidth: number;
  compositionHeight: number;
  muted: boolean;
  /** 0 to 1. */
  volume: number;
  /** Play again from the start at the end, with no `ended`. Default off: Review plays once. */
  loop?: boolean;
  /** The playback speed (1 is normal). Default 1. */
  playbackRate?: number;
  /**
   * The fonts to show on the captions and the titles, as the note box names them (the live font
   * preview, FN19). The composition's page is restyled in memory, at every `ready` and whenever
   * this changes; a job's files are never written. Default none: the frame touches nothing.
   */
  fonts?: FontPreviewPlan | null;
  /** Compare is held: the page shows the composition as it is, without the fonts. */
  fontsCompare?: boolean;
  /** What the page is showing of `fonts` once it is set (a scope whose text is not found shows nothing). */
  onFontPreview?(status: FontPreviewStatus): void;
  onReady?(info: PlayerReadyInfo): void;
  onDurationChange?(durationSec: number): void;
  onTimeUpdate?(seconds: number): void;
  onPlayingChange?(playing: boolean): void;
  onEnded?(): void;
  onError?(message: string): void;
  ref?: Ref<PlayerFrameHandle>;
}

/**
 * The <hyperframes-player> element in React: the composition plays inside it, with none of its own
 * controls (the `controls` attribute is never set; ours are PlayerControls). Everything it tells
 * us comes through events, and everything we ask of it goes through the handle, which does nothing
 * until the player has said it is ready.
 *
 * - The runtime script is served from our own origin (`runtime-src`), not from jsDelivr.
 * - `assets-loading-ui="none"` hides the player's own "Loading assets" card; ours is the skeleton.
 * - `disable-click-to-play`: a click on the picture is ours too (PreviewPlayer's click catcher).
 * - `loop` is the player's own boolean attribute, set only when asked (never as `loop=""`/`false`);
 *   without it the attribute is not there and the player ends as before.
 * - The speed is the player's `playback-rate` attribute, there only when it is not 1×. An attribute,
 *   not the property, so it is safe before the element is upgraded; the player sends it on to the
 *   composition again at every load.
 * - The element is defined by `loadPlayerElement()`, in an effect, so this renders on the server.
 * - `muted` and `volume` are written only once ready: a property written on an element that is not
 *   upgraded yet becomes an own property that hides the class's setter for good.
 * - `play()` unlocks the composition's media first (`unlockMedia`), so it plays on an iPhone. It
 *   must be called from a tap or a key press, as every caller does.
 */
export function PlayerFrame({
  src,
  width,
  height,
  compositionWidth,
  compositionHeight,
  muted,
  volume,
  loop = false,
  playbackRate = 1,
  fonts = null,
  fontsCompare = false,
  onFontPreview,
  onReady,
  onDurationChange,
  onTimeUpdate,
  onPlayingChange,
  onEnded,
  onError,
  ref,
}: PlayerFrameProps) {
  const elementRef = useRef<HyperframesPlayer>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  /** The font preview of the loaded composition's document; made when a font is first asked for. */
  const previewRef = useRef<{ doc: Document; applier: FontPreviewApplier } | null>(null);
  const compareRef = useRef(fontsCompare);
  compareRef.current = fontsCompare;

  // The callbacks as of the last render, so new ones never re-subscribe the listeners.
  const callbacks = useRef({
    onReady,
    onDurationChange,
    onTimeUpdate,
    onPlayingChange,
    onEnded,
    onError,
    onFontPreview,
  });
  callbacks.current = {
    onReady,
    onDurationChange,
    onTimeUpdate,
    onPlayingChange,
    onEnded,
    onError,
    onFontPreview,
  };

  useEffect(() => {
    const found = elementRef.current;
    if (found === null) return;
    const element: HyperframesPlayer = found;
    let gone = false;

    function listen<T>(type: string, handler: (detail: T | undefined) => void): () => void {
      const listener = (event: Event) => handler((event as CustomEvent<T | undefined>).detail);
      element.addEventListener(type, listener);
      return () => element.removeEventListener(type, listener);
    }

    const stops = [
      listen<{ duration: number; compositionWidth: number; compositionHeight: number }>(
        'ready',
        (detail) => {
          readyRef.current = true;
          setReady(true);
          // Keyboard focus must never land inside the composition's iframe: key presses there
          // do not reach our handlers.
          const iframe = element.iframeElement;
          if (iframe) iframe.tabIndex = -1;
          callbacks.current.onReady?.({
            durationSec: detail?.duration ?? element.duration,
            width: detail?.compositionWidth ?? element.compositionWidth,
            height: detail?.compositionHeight ?? element.compositionHeight,
          });
        },
      ),
      listen<{ duration: number }>('durationchange', (detail) => {
        if (detail) callbacks.current.onDurationChange?.(detail.duration);
      }),
      listen<{ currentTime: number }>('timeupdate', (detail) => {
        if (detail) callbacks.current.onTimeUpdate?.(detail.currentTime);
      }),
      listen('play', () => callbacks.current.onPlayingChange?.(true)),
      listen('pause', () => callbacks.current.onPlayingChange?.(false)),
      // The browser blocked play(): nothing is playing.
      listen('playbackerror', () => callbacks.current.onPlayingChange?.(false)),
      listen('ended', () => {
        callbacks.current.onPlayingChange?.(false);
        callbacks.current.onEnded?.();
      }),
      listen<{ message?: string }>('error', (detail) =>
        callbacks.current.onError?.(detail?.message ?? 'The preview failed to load'),
      ),
    ];

    loadPlayerElement().catch((error: unknown) => {
      if (!gone) callbacks.current.onError?.(String(error));
    });

    return () => {
      gone = true;
      for (const stop of stops) stop();
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!ready || element === null) return;
    element.muted = muted;
    element.volume = volume;
  }, [ready, muted, volume]);

  // The live font preview: a document of its own at every load (a new round or "Try again" mounts a
  // new frame), so the rules go in when the player says `ready` and again whenever the plan changes.
  // With no plan, and none ever shown, the document is not touched at all.
  useEffect(() => {
    const element = elementRef.current;
    if (!ready || element === null) return;
    let current = previewRef.current;
    if (fonts === null) {
      if (current !== null) {
        void current.applier.show(null);
        callbacks.current.onFontPreview?.(NOTHING_SHOWN);
      }
      return;
    }
    const doc = element.iframeElement?.contentDocument ?? null;
    if (doc === null) return;
    if (current === null || current.doc !== doc) {
      current?.applier.dispose();
      current = { doc, applier: new FontPreviewApplier(doc) };
      current.applier.setCompare(compareRef.current);
      previewRef.current = current;
    }
    let stale = false;
    void current.applier.show(fonts).then((status) => {
      if (!stale && status !== null) callbacks.current.onFontPreview?.(status);
    });
    return () => {
      stale = true;
    };
  }, [ready, fonts]);

  useEffect(() => {
    previewRef.current?.applier.setCompare(fontsCompare);
  }, [fontsCompare]);

  useEffect(
    () => () => {
      previewRef.current?.applier.dispose();
      previewRef.current = null;
    },
    [],
  );

  const handle = useMemo<PlayerFrameHandle>(
    () => ({
      play() {
        const element = elementRef.current;
        if (!readyRef.current || element === null) return;
        // Still inside the tap: iPhone Safari plays the composition's media only after this.
        unlockMedia(element.iframeElement?.contentDocument);
        element.play();
      },
      pause() {
        if (readyRef.current) elementRef.current?.pause();
      },
      seek(seconds) {
        if (readyRef.current) elementRef.current?.seek(seconds);
      },
    }),
    [],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  return (
    <hyperframes-player
      ref={elementRef}
      src={src}
      width={compositionWidth}
      height={compositionHeight}
      runtime-src={PLAYER_RUNTIME_SRC}
      disable-click-to-play=""
      assets-loading-ui="none"
      loop={loop || undefined}
      playback-rate={playbackRate === 1 ? undefined : String(playbackRate)}
      style={{ display: 'block', width, height }}
    />
  );
}
