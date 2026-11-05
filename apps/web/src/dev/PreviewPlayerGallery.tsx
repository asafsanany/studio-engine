// Dev-only section of the /components gallery (CVP-121): the review player, live on the sample
// composition, its controls in their static states, and the loading/error states. See
// ComponentsPage.tsx, which mounts it. The sample is served by apps/web/dev-preview-sample.ts.

import { type ReactNode, useState } from 'react';
import { PlayerControls } from '@/features/review/PlayerControls';
import { PreviewPlayer } from '@/features/review/PreviewPlayer';
import { formatPlayhead, timelineLeft } from '@/features/review/player-state';
import { cn } from '@/lib/utils';

// The sample composition (apps/server/src/pipeline/testdata/preview/), served by the dev server.
const SAMPLE_SRC = '/__dev/preview-sample/index.html';
// A path that answers 404: the skeleton shows, then the player gives up after about 8 s.
const MISSING_SRC = '/__dev/preview-sample/missing.html';
const SAMPLE_DURATION_SEC = 6;

function Section({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-3.5 rounded-[10px] border p-6', className)}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="font-mono text-xs text-muted-foreground">{note}</div>
      </div>
      {children}
    </section>
  );
}

function LivePreview() {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  return (
    <Section
      title="Live preview · 9:16"
      note="PreviewPlayer · <hyperframes-player> 0.8.181 · /__dev/preview-sample/"
    >
      <PreviewPlayer
        src={SAMPLE_SRC}
        videoWidth={1080}
        videoHeight={1920}
        durationSec={SAMPLE_DURATION_SEC}
        maxWidth={480}
        maxHeight={560}
        onTimeUpdate={setTime}
        onPlayingChange={setPlaying}
      />
      <div className="font-mono text-xs text-muted-foreground">
        onTimeUpdate {formatPlayhead(time, SAMPLE_DURATION_SEC)} · {playing ? 'playing' : 'paused'}
      </div>
    </Section>
  );
}

const noop = () => {};

function StaticControls() {
  const handlers = {
    onTogglePlay: noop,
    onSeek: noop,
    onToggleMute: noop,
    onVolumeChange: noop,
    onToggleFullscreen: noop,
  };
  return (
    <Section
      title="Controls"
      note="PlayerControls · 76 px · ghost icon-sm (32) · 12 px tabular time · 4 px track · 12 px thumb · 56 px volume"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">loading</span>
          <div className="w-[315px] overflow-hidden rounded-md border">
            <PlayerControls
              disabled
              currentSec={0}
              durationSec={SAMPLE_DURATION_SEC}
              playing={false}
              muted={false}
              volume={0.8}
              fullscreen={false}
              {...handlers}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            paused · a note dot in timelineOverlay (W10)
          </span>
          <div className="w-[315px] overflow-hidden rounded-md border">
            <PlayerControls
              currentSec={2}
              durationSec={SAMPLE_DURATION_SEC}
              playing={false}
              muted={false}
              volume={0.8}
              fullscreen={false}
              timelineOverlay={
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3B82F6] shadow-[0_0_0_2px_#09090B]"
                  style={{ left: timelineLeft(2.4, SAMPLE_DURATION_SEC) }}
                />
              }
              {...handlers}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            playing · muted · full screen
          </span>
          <div className="w-[315px] overflow-hidden rounded-md border">
            <PlayerControls
              currentSec={3.4}
              durationSec={SAMPLE_DURATION_SEC}
              playing
              muted
              volume={0.8}
              fullscreen
              {...handlers}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function LoadingAndError() {
  return (
    <Section
      title="Loading and error · 16:9"
      note="skeleton after 300 ms · a missing composition fails after about 8 s · Try again reloads"
    >
      <PreviewPlayer
        src={MISSING_SRC}
        videoWidth={1920}
        videoHeight={1080}
        maxWidth={448}
        maxHeight={252}
      />
    </Section>
  );
}

export function PreviewPlayerGallery() {
  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.01em]">F4 · Preview player</h2>
        <p className="mt-1 text-muted-foreground">
          The review player on the sample composition (1080×1920, 6 s). Click the video, then: Space
          or K play/pause · ← → or J L 5 s · Shift+← → or , . 1 s · Home start · M mute · F full
          screen.
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <LivePreview />
        <StaticControls />
        <LoadingAndError />
      </div>
    </>
  );
}
