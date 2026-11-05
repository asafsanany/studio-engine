import type { FeedImage } from '@studio/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { feedPictureUrl } from '@/data';
import { JOB_CHAT_TEXT } from './job-chat-text';

/**
 * A picture of the chat, big (DCCards 12): its label and where Claude found it under it, and the
 * arrows (or ← and →) to the picture before and after it in the chat. `open` is the picture's name.
 */
export function PictureLightbox({
  jobId,
  pictures,
  open,
  onOpenChange,
}: {
  jobId: string;
  pictures: readonly FeedImage[];
  open: string | null;
  onOpenChange: (name: string | null) => void;
}) {
  const at = open === null ? -1 : pictures.findIndex((image) => image.name === open);
  const image = at === -1 ? null : pictures[at];
  const before = at > 0 ? pictures[at - 1] : undefined;
  const after = at !== -1 && at < pictures.length - 1 ? pictures[at + 1] : undefined;

  return (
    <Dialog
      open={image !== null && image !== undefined}
      onOpenChange={(next) => !next && onOpenChange(null)}
    >
      <DialogContent
        data-slot="picture-lightbox"
        className="flex max-h-[92vh] w-auto max-w-[92vw] flex-col gap-3 p-4 sm:max-w-[92vw]"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' && before !== undefined) onOpenChange(before.name);
          if (event.key === 'ArrowRight' && after !== undefined) onOpenChange(after.name);
        }}
      >
        {image !== null && image !== undefined && (
          <>
            <img
              src={feedPictureUrl(jobId, image.name)}
              alt={image.label}
              className="block max-h-[78vh] max-w-full self-center rounded-md object-contain"
            />
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <DialogTitle className="truncate text-sm font-medium">{image.label}</DialogTitle>
                <DialogDescription className="truncate text-xs">
                  {image.path ?? `${at + 1} of ${pictures.length}`}
                </DialogDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={JOB_CHAT_TEXT.previous}
                disabled={before === undefined}
                onClick={() => before !== undefined && onOpenChange(before.name)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={JOB_CHAT_TEXT.next}
                disabled={after === undefined}
                onClick={() => after !== undefined && onOpenChange(after.name)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
