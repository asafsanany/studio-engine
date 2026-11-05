// Dev-only section of the /components gallery (CVP-119): the review dialog, opened on the sample
// composition. See ComponentsPage.tsx, which mounts it. The sample is served by
// apps/web/dev-preview-sample.ts.

import type { ReviewNote } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { notesKey } from '@/data/notes-cache';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { ReviewDialog } from '@/features/review/ReviewDialog';
import { createReviewDialogStore } from '@/features/review/review-dialog';
import { cn } from '@/lib/utils';

const SAMPLE_SRC = '/__dev/preview-sample/index.html';
// A path that answers 404: the skeleton shows, then the player gives up after about 8 s.
const MISSING_SRC = '/__dev/preview-sample/missing.html';

const VARIANTS = {
  portrait: {
    label: 'Open · 9:16 sample',
    preview: { durationSec: 6, width: 1080, height: 1920 },
    src: SAMPLE_SRC,
  },
  landscape: {
    label: 'Open · 16:9 (missing composition)',
    preview: { durationSec: 6, width: 1920, height: 1080 },
    src: MISSING_SRC,
  },
} as const;

type VariantKey = keyof typeof VARIANTS;

/**
 * The board's three notes, fitted to the 6 s sample: a typed one with Add to style on, a voice one
 * with its transcript, and a typed one. There is no engine behind the gallery, so adding, changing
 * and deleting them fail; they are there to be looked at.
 */
function galleryNotes(jobId: string): ReviewNote[] {
  const base = {
    jobId,
    round: null,
    sentAt: null,
    createdAt: '2026-10-20T14:00:00.000Z',
    addToSeries: false,
    routeStatus: null,
    route: null,
    fixId: null,
    fixedAt: null,
  } as const;
  return [
    {
      ...base,
      id: 'g1',
      atSec: 1.2,
      kind: 'text',
      text: 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.',
      audioFile: null,
      audioSec: null,
      transcriptStatus: null,
      addToStyle: true,
    },
    {
      ...base,
      id: 'g2',
      atSec: 2.8,
      kind: 'voice',
      text: 'כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר.',
      audioFile: 'edit/review/voice/g2.webm',
      audioSec: 9,
      transcriptStatus: 'done',
      addToStyle: false,
    },
    {
      ...base,
      id: 'g3',
      atSec: 4.6,
      kind: 'text',
      text: 'לחתוך את השתיקה לפני "בסוף השבוע".',
      audioFile: null,
      audioSec: null,
      transcriptStatus: null,
      addToStyle: false,
    },
  ];
}

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

export function ReviewDialogGallery() {
  const queryClient = useQueryClient();
  const [galleryStore] = useState(() => createReviewDialogStore());
  /** Which variant is open, and how many times one was opened (a fresh dialog at every opening). */
  const [opened, setOpened] = useState<{ variant: VariantKey; session: number } | null>(null);
  const [open, setOpen] = useState(false);
  const galleryJob = REVIEW_ROW_JOBS.find((job) => job.id === 'r1');
  if (galleryJob === undefined) return null;

  function openVariant(variant: VariantKey) {
    // The notes query never refetches (staleTime: Infinity), so the dialog shows these as they are.
    if (galleryJob) queryClient.setQueryData(notesKey(galleryJob.id), galleryNotes(galleryJob.id));
    setOpened((previous) => ({ variant, session: (previous?.session ?? 0) + 1 }));
    setOpen(true);
  }

  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.01em]">F5 · Review dialog</h2>
        <p className="mt-1 text-muted-foreground">
          The review dialog on the sample composition. Esc leaves the note box, then full screen,
          then closes.
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Section
          title="Review dialog"
          note="ReviewDialog · player 9:16 or 16:9 · 360 px Notes panel · 60 px header · 64 px footer"
        >
          <div className="flex flex-wrap gap-3">
            {(Object.keys(VARIANTS) as VariantKey[]).map((variant) => (
              <Button
                key={variant}
                type="button"
                variant="outline"
                onClick={() => openVariant(variant)}
              >
                {VARIANTS[variant].label}
              </Button>
            ))}
          </div>
        </Section>
      </div>
      {opened === null ? null : (
        <ReviewDialog
          key={opened.session}
          job={{ ...galleryJob, preview: VARIANTS[opened.variant].preview }}
          src={VARIANTS[opened.variant].src}
          open={open}
          onOpenChange={setOpen}
          store={galleryStore}
        />
      )}
    </>
  );
}
