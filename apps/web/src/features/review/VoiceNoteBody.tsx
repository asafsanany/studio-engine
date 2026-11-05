import type { ReviewNote } from '@studio/shared';
import { useEffect, useRef } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { Pause, Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { noteAudioUrl } from '@/data';
import { cn } from '@/lib/utils';
import { noteTime, transcriptLine } from './notes-logic';
import { VOICE_TEXT } from './review-text';
import { peakBarHeights, useVoicePeaks } from './voice-peaks';
import { type VoicePlaybackState, voicePlaybackStore } from './voice-playback';

interface VoiceNoteBodyProps {
  note: ReviewNote;
  jobId: string;
  /** Playing starts: the dialog pauses the video. */
  onPlay: () => void;
  /** Which note is playing. Default: the app's; tests pass their own. */
  playback?: StoreApi<VoicePlaybackState>;
  /** On the phone (board MReview) the play button is 36 px and the transcript 14 px. */
  variant?: 'mac' | 'phone';
}

/**
 * What a voice note's card shows under its time (board P3Review): a round play/pause button, 28
 * waveform bars, the length, and the transcript line ("Transcribing…", the text, or that it
 * couldn't be transcribed).
 *
 * - Only one note plays at a time: starting one tells the playback store, and the others pause
 *   themselves when they see it. Playing a note pauses the video (`onPlay`); the dialog stops the
 *   notes when the video plays.
 * - The length is the note's `audioSec`, never the element's `duration`: Chrome's webm has no
 *   duration in its header, so the element reports Infinity.
 * - The bars come from the decoded audio (`useVoicePeaks`); they stay flat until then, and for
 *   good where the browser can't decode the recording.
 */
export function VoiceNoteBody({
  note,
  jobId,
  onPlay,
  playback = voicePlaybackStore,
  variant = 'mac',
}: VoiceNoteBodyProps) {
  const phone = variant === 'phone';
  const src = noteAudioUrl(jobId, note.id);
  const playing = useStore(playback, (state) => state.playingNoteId === note.id);
  const heights = peakBarHeights(useVoicePeaks(src, note.id));
  const audioRef = useRef<HTMLAudioElement>(null);
  const line = transcriptLine(note);

  // Another note started (or the video, or the dialog closed): this one pauses.
  useEffect(() => {
    const audio = audioRef.current;
    if (!playing && audio && !audio.paused) audio.pause();
  }, [playing]);

  // A note that goes away while it plays (deleted) must not leave the store saying it plays.
  useEffect(() => {
    const id = note.id;
    return () => playback.getState().stop(id);
  }, [playback, note.id]);

  function toggle() {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      playback.getState().stop(note.id);
      return;
    }
    onPlay();
    playback.getState().play(note.id);
    audio.play().catch(() => playback.getState().stop(note.id));
  }

  return (
    <div data-slot="voice-note" className="flex flex-col gap-1.5 pr-1">
      <div className="flex items-center gap-2.5">
        <Button
          type="button"
          size="icon"
          aria-label={playing ? VOICE_TEXT.pause : VOICE_TEXT.play}
          className={cn(
            'rounded-full bg-foreground text-background hover:bg-foreground/90',
            phone ? 'size-9' : 'size-7',
          )}
          onClick={toggle}
        >
          {playing ? (
            <Pause className={cn('fill-current stroke-none', phone ? 'size-3.5' : 'size-3')} />
          ) : (
            <Play className={cn('fill-current stroke-none', phone ? 'size-3.5' : 'size-3')} />
          )}
        </Button>
        <div aria-hidden="true" className="flex h-6 flex-1 items-center gap-0.5 overflow-hidden">
          {heights.map((height, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 28 fixed bars, in order
              key={index}
              className={cn(
                'w-[3px] shrink-0 rounded-[2px] transition-colors duration-150 ease-in-out',
                playing ? 'bg-foreground' : 'bg-zinc-500',
              )}
              style={{ height }}
            />
          ))}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {noteTime(note.audioSec ?? 0)}
        </span>
      </div>
      {line === '' ? null : (
        <p
          dir="auto"
          className={cn(
            'break-words text-muted-foreground [unicode-bidi:plaintext]',
            phone ? 'text-sm' : 'text-[13px]',
          )}
        >
          {line}
        </p>
      )}
      {/* biome-ignore lint/a11y/useMediaCaption: a voice note; its transcript is the line above */}
      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onEnded={() => {
          playback.getState().stop(note.id);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
        onPause={() => playback.getState().stop(note.id)}
      />
    </div>
  );
}
