// The Music button in Review's header (Soundtrack plan, "Review (Mac)"; canvas page "Soundtrack",
// boards SDReview and SDMusic): before Manual edit, "Music v2" / "from the folder" / "off" /
// "series", and under it a popover with the list (MusicList). Nothing while Soundtrack is off or
// the job has no music.json. Make another and Pick are in the list; their answers go into the
// cache, and ReviewDialog's player follows the new `rev` (see SwapPlayer).

import { ChevronDown, Music } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useJobMusic, useMusicEnabled } from '@/data';
import { MusicList } from './MusicList';
import { MUSIC_TEXT, musicButtonLabel } from './music-text';

export interface MusicButtonProps {
  jobId: string;
}

export function MusicButton({ jobId }: MusicButtonProps) {
  const enabled = useMusicEnabled();
  const { data: music } = useJobMusic(jobId);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  if (!enabled || music === undefined || music === null) return null;

  return (
    // Modal: a click outside only closes the list; it does not also pause the video under it.
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="music-button"
          aria-haspopup="dialog"
          className="shrink-0 gap-1.5 pr-2 pl-2.5 data-[state=open]:bg-accent"
        >
          <Music aria-hidden="true" />
          {MUSIC_TEXT.title}
          <span className="font-normal text-muted-foreground">{musicButtonLabel(music)}</span>
          <ChevronDown aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        aria-label={MUSIC_TEXT.title}
        align="end"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        // Focus starts on the list itself, so no row shows a ring that nobody asked for.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        className="max-h-(--radix-popover-content-available-height) w-[400px] overflow-y-auto rounded-[10px] p-0 shadow-lg"
      >
        <MusicList jobId={jobId} music={music} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
