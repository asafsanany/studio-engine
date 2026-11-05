// The Music button of the phone's Review (Soundtrack plan, "Review (phone)"; canvas page
// "Soundtrack", board SDPhone): in PhoneReview's top bar, before Close; it opens the list
// (MusicList) as a bottom sheet with a SheetGrabber (drag it down to close). Nothing while
// Soundtrack is off or the job has no music.json. PhoneReview's player follows the music's `rev`
// (see SwapPlayer).

import { Music } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { useJobMusic, useMusicEnabled } from '@/data';
import { MusicList } from './MusicList';
import { MUSIC_TEXT, musicButtonLabel } from './music-text';

export interface PhoneMusicSheetProps {
  jobId: string;
}

export function PhoneMusicSheet({ jobId }: PhoneMusicSheetProps) {
  const enabled = useMusicEnabled();
  const { data: music } = useJobMusic(jobId);
  const [open, setOpen] = useState(false);

  if (!enabled || music === undefined || music === null) return null;
  const label = musicButtonLabel(music);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        data-slot="phone-music-button"
        aria-label={`${MUSIC_TEXT.buttonName}, ${label}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        // 36 px of button inside a 44 px touch target: the ::before reaches 5 px past the padding
        // box, which is 4 px past the border box, on each side.
        className="relative h-9 max-w-36 flex-none gap-1.5 border-white/15 px-2.5 text-[13px] before:absolute before:-inset-[5px] before:content-[''] dark:border-white/15 dark:bg-transparent dark:hover:bg-accent has-[>svg]:px-2.5"
      >
        <Music aria-hidden="true" className="size-[15px]" />
        <span className="truncate">{label}</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          // The review is dimmed to 55 % (board SDPhone), the sheet sits over it.
          overlayClassName="bg-black/55"
          data-slot="phone-music-sheet"
          className="z-[60] max-h-[calc(100dvh-48px)] gap-0 overflow-y-auto rounded-t-2xl border-t border-white/10 bg-card p-0 pb-[max(34px,var(--safe-bottom))] data-[state=closed]:duration-200 data-[state=open]:duration-200"
        >
          <SheetGrabber onClose={() => setOpen(false)} className="pt-2 pb-2" />
          <SheetTitle className="sr-only">{MUSIC_TEXT.title}</SheetTitle>
          <SheetDescription className="sr-only">{MUSIC_TEXT.pickLegend}</SheetDescription>
          <MusicList jobId={jobId} music={music} variant="phone" />
        </SheetContent>
      </Sheet>
    </>
  );
}
