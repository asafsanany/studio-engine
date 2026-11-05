import type { Job } from '@studio/shared';
import { Undo2, X } from 'lucide-react';
import { Suspense, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { previewPosterUrl, previewUrl, useJobVersions } from '@/data';
import { GoBackDialog } from '@/features/job-sheet/GoBackDialog';
import { cutName, goBackBlock, SHEET_VERSIONS_TEXT } from '@/features/job-sheet/sheet-versions';
import { useGoBack } from '@/features/job-sheet/use-go-back';
import { phonePreviewSrc, usePreviewVideo } from '../phone/review/use-preview-video';
import { CONTROLS_HEIGHT, fitPlayer } from './fit-player';
import { useReviewFix } from './fix/use-review-fix';
import { SwapPlayer } from './music/SwapPlayer';
import { useReviewMusic } from './music/use-review-music';
import {
  canViewPreview,
  type PreviewViewerState,
  previewViewerStore,
  usePreviewViewer,
} from './preview-viewer';
import { useViewportSize } from './use-viewport-size';

interface PreviewViewerHostProps {
  jobs: readonly Job[] | undefined;
  phone?: boolean;
  store?: StoreApi<PreviewViewerState>;
}

/** A playback-only viewer for a preview outside Review. The job may change stages while open. */
export function PreviewViewerHost({
  jobs,
  phone = false,
  store = previewViewerStore,
}: PreviewViewerHostProps) {
  const { jobId, version, session } = usePreviewViewer(store);
  const job = jobs?.find((candidate) => candidate.id === jobId);

  useEffect(() => {
    if (jobId !== null && jobs !== undefined && (job === undefined || !canViewPreview(job))) {
      store.getState().close();
    }
  }, [jobId, jobs, job, store]);
  useEffect(() => () => store.getState().reset(), [store]);

  const last = useRef<Job | null>(null);
  useEffect(() => {
    if (job !== undefined) last.current = job;
  }, [job]);
  const shown = job ?? last.current;
  if (shown === null || shown.preview === null) return null;

  return (
    <PreviewViewer
      key={session}
      job={shown}
      preview={shown.preview}
      version={version}
      open={jobId !== null && job !== undefined && canViewPreview(job)}
      onOpenChange={(open) => {
        if (!open) store.getState().close();
      }}
      phone={phone}
    />
  );
}

/** The footer's height: the same 56 px as the header. */
const FOOTER_HEIGHT = 56;

function PreviewViewer({
  job,
  preview,
  version,
  open,
  onOpenChange,
  phone,
}: {
  job: Job;
  preview: NonNullable<Job['preview']>;
  /** The cut to show ("Cut n"); `null` is the job's live preview. The current cut counts as the live preview. */
  version: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: boolean;
}) {
  const viewport = useViewportSize();
  const music = useReviewMusic(job.id, !open);
  // A job in Review may have quick fixes: their rev is in the address too, so what is played is what
  // Review plays. (No notes: the viewer only plays, it draws no pill and goes to no moment.)
  const fix = useReviewFix({ job, notes: undefined, hold: !open });
  // The list is in the cache when the sheet's Versions part opened it; the viewer asks for itself otherwise.
  const versions = useJobVersions(job.id, { enabled: version !== null });
  const row = version === null ? undefined : versions.data?.versions.find((v) => v.n === version);
  const old = row !== undefined && !row.current ? row : null;
  // A cut that is gone (pruned) has nothing to show. Until the list is in, the player waits, so the
  // live preview is not loaded first and then the old cut.
  const missing = version !== null && versions.data !== undefined && row === undefined;
  const waiting = version !== null && row === undefined && !missing;
  useEffect(() => {
    if (open && missing && version !== null) {
      toast.error(`${cutName(version)} is no longer in Versions`);
      onOpenChange(false);
    }
  }, [open, missing, version, onOpenChange]);
  const current = versions.data?.versions.find((v) => v.current)?.n ?? null;
  const goBack = useGoBack(job.id, () => onOpenChange(false));
  // Only a job in Review can go back, and not to the cut it is on (the sheet's rule).
  const canGoBack = old !== null && goBackBlock(job, old) === null;

  const video = usePreviewVideo(job.id, phone && open && old === null, music.rev, fix.rev);
  const asVideo = phone && old === null && video.state === 'ready';
  const src = old
    ? previewUrl(job.id, old.round, undefined, '', old.n)
    : phone
      ? phonePreviewSrc({
          jobId: job.id,
          round: job.round,
          musicRev: music.rev,
          fixRev: fix.rev,
          src: undefined,
          video,
        })
      : previewUrl(job.id, job.round, music.rev, '', null, fix.rev);
  const shown = old ?? preview;
  const chrome = (phone ? 48 : 92) + (canGoBack ? FOOTER_HEIGHT : 0);
  const box = fitPlayer({
    videoW: shown.width,
    videoH: shown.height,
    maxW: Math.max(160, viewport.width - 34),
    maxH: Math.max(160, viewport.height - chrome - CONTROLS_HEIGHT - 34),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-preview-viewer=""
        showCloseButton={false}
        className="flex max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        style={
          phone
            ? { width: '100vw', height: '100dvh' }
            : {
                width: box.width + 2,
                height: box.height + CONTROLS_HEIGHT + 62 + (canGoBack ? FOOTER_HEIGHT : 0),
              }
        }
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
          <DialogTitle className="min-w-0 truncate text-sm font-medium" dir="auto">
            {job.name}
            {version !== null && (
              <span className="font-normal text-muted-foreground">{` · ${cutName(version)}`}</span>
            )}
          </DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close preview"
            onClick={() => onOpenChange(false)}
            className={phone ? 'size-11' : undefined}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <DialogDescription className="sr-only">
          {old === null
            ? 'Watch the current preview of this job.'
            : `Watch ${cutName(old.n)} of this job, an earlier preview.`}
        </DialogDescription>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
          {(old === null && music.settling) || waiting || missing ? null : (
            <Suspense fallback={null}>
              <SwapPlayer
                src={src}
                asVideo={asVideo}
                poster={phone && old === null ? previewPosterUrl(job.id, job.round) : undefined}
                videoWidth={shown.width}
                videoHeight={shown.height}
                durationSec={shown.durationSec}
                maxWidth={box.width}
                maxHeight={box.height}
              />
            </Suspense>
          )}
        </div>
        {canGoBack && (
          <footer
            data-preview-viewer-footer=""
            className="flex shrink-0 items-center justify-end border-t px-4"
            // On the phone the button is the footer's width and clears the home indicator.
            style={
              phone
                ? {
                    height: `calc(${FOOTER_HEIGHT}px + var(--safe-bottom, 0px))`,
                    paddingBottom: 'var(--safe-bottom, 0px)',
                  }
                : { height: FOOTER_HEIGHT }
            }
          >
            <Button
              type="button"
              onClick={() => goBack.ask(old.n)}
              className={phone ? 'h-11 w-full' : undefined}
            >
              <Undo2 aria-hidden="true" />
              {SHEET_VERSIONS_TEXT.goBackHere}
            </Button>
          </footer>
        )}
        <GoBackDialog
          target={goBack.asking}
          current={current}
          pending={goBack.pending}
          variant={phone ? 'phone' : 'mac'}
          onOpenChange={(next) => {
            if (!next) goBack.ask(null);
          }}
          onConfirm={goBack.confirm}
        />
      </DialogContent>
    </Dialog>
  );
}
