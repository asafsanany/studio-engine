import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { PlayerFrameHandle, PlayerFrameProps } from './PlayerFrame';

/**
 * The same part as `PlayerFrame` (same props, same handle), but a plain <video> of the small MP4
 * the engine renders of the preview (`previewVideoUrl`), for the phone: a live composition lags
 * there. `src` is the MP4; the composition size only sets the box. Play must come from a tap.
 */
export function VideoFrame({
  src,
  width,
  height,
  muted,
  volume,
  loop = false,
  playbackRate = 1,
  onReady,
  onDurationChange,
  onTimeUpdate,
  onPlayingChange,
  onEnded,
  onError,
  ref,
}: PlayerFrameProps) {
  const elementRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({
    onReady,
    onDurationChange,
    onTimeUpdate,
    onPlayingChange,
    onEnded,
    onError,
  });
  callbacks.current = {
    onReady,
    onDurationChange,
    onTimeUpdate,
    onPlayingChange,
    onEnded,
    onError,
  };

  useEffect(() => {
    const element = elementRef.current;
    if (element === null) return;
    const on = (type: string, handler: () => void) => {
      element.addEventListener(type, handler);
      return () => element.removeEventListener(type, handler);
    };
    const stops = [
      on('loadedmetadata', () =>
        callbacks.current.onReady?.({
          durationSec: element.duration,
          width: element.videoWidth,
          height: element.videoHeight,
        }),
      ),
      on('durationchange', () => callbacks.current.onDurationChange?.(element.duration)),
      on('timeupdate', () => callbacks.current.onTimeUpdate?.(element.currentTime)),
      on('play', () => callbacks.current.onPlayingChange?.(true)),
      on('pause', () => callbacks.current.onPlayingChange?.(false)),
      on('ended', () => {
        callbacks.current.onPlayingChange?.(false);
        callbacks.current.onEnded?.();
      }),
      on('error', () => callbacks.current.onError?.('The preview video failed to load')),
    ];
    // The metadata may have arrived before the listeners were on.
    if (element.readyState >= 1) element.dispatchEvent(new Event('loadedmetadata'));
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (element === null) return;
    element.muted = muted;
    element.volume = volume;
  }, [muted, volume]);

  // The default rate too: a new load of the source goes back to it.
  useEffect(() => {
    const element = elementRef.current;
    if (element === null) return;
    element.defaultPlaybackRate = playbackRate;
    element.playbackRate = playbackRate;
  }, [playbackRate]);

  const handle = useMemo<PlayerFrameHandle>(
    () => ({
      play() {
        void elementRef.current?.play().catch(() => callbacks.current.onPlayingChange?.(false));
      },
      pause() {
        elementRef.current?.pause();
      },
      seek(seconds) {
        if (elementRef.current) elementRef.current.currentTime = seconds;
      },
    }),
    [],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  return (
    // biome-ignore lint/a11y/useMediaCaption: a preview of the edit for its editor; the captions are burned in
    <video
      ref={elementRef}
      src={src}
      playsInline
      preload="auto"
      loop={loop}
      style={{ display: 'block', width, height, objectFit: 'contain' }}
    />
  );
}
