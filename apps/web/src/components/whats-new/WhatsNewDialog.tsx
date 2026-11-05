import { formatReleaseDate, type Release } from '@studio/shared';
import { Maximize2 } from 'lucide-react';
import { Fragment, type Ref, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { cn } from '@/lib/utils';

// Release screenshots: every image in assets/whats-new, keyed by its file name.
const SCREENSHOTS = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('@/assets/whats-new/*.{png,jpg,jpeg,webp}', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  ).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]),
);

/**
 * How the notes are laid out: `dialog` is the Mac's centred box; `sheet` is the phone's bottom
 * sheet (boards MWhatsNew and MWhatsNewShot). Only the look differs, the notes and the way they
 * open and close are the same.
 */
export type WhatsNewVariant = 'dialog' | 'sheet';

/**
 * A release's screenshot; a click grows it to fill the window, and a click or Esc closes it. On
 * the phone it carries an expand mark, and tapping it fills the whole screen on black (tap again
 * to close).
 */
function ReleaseScreenshot({
  src,
  version,
  variant,
}: {
  src: string;
  version: string;
  variant: WhatsNewVariant;
}) {
  const [zoomed, setZoomed] = useState(false);
  const alt = `What changed in version ${version}`;
  const phone = variant === 'sheet';

  return (
    <>
      <button
        type="button"
        aria-label={`${alt}: enlarge`}
        onClick={() => setZoomed(true)}
        className={cn(
          'cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
          phone && 'relative mt-1 block w-full',
        )}
      >
        <img src={src} alt={alt} loading="lazy" className="w-full rounded-md border" />
        {phone && (
          <span
            aria-hidden="true"
            data-slot="whats-new-expand"
            className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-md bg-background/80"
          >
            <Maximize2 className="size-3.5" />
          </span>
        )}
      </button>
      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent
          showCloseButton={false}
          onClick={() => setZoomed(false)}
          className={cn(
            'flex cursor-pointer items-center justify-center border-0 bg-transparent p-0 shadow-none ease-in-out sm:max-w-none',
            phone
              ? 'top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none bg-black'
              : 'h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none',
          )}
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <DialogDescription className="sr-only">
            {phone ? 'Tap anywhere to close.' : 'Click anywhere to close.'}
          </DialogDescription>
          <img
            src={src}
            alt={alt}
            className={cn('w-full object-contain', phone ? 'max-h-full' : 'h-full rounded-md')}
          />
          {phone && (
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.125rem)] text-center text-[13px] text-muted-foreground"
            >
              Tap to close
            </span>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One release: version badge and date, then the bullets. */
function WhatsNewSection({ release, variant }: { release: Release; variant: WhatsNewVariant }) {
  const headingId = `whats-new-${release.version}`;
  const screenshot = release.screenshot ? SCREENSHOTS[release.screenshot] : undefined;

  return (
    <section
      data-slot="whats-new-release"
      aria-labelledby={headingId}
      // On the phone a hairline above each release but the first stands in for the separator.
      className={cn('flex flex-col gap-2', variant === 'sheet' && 'border-t py-3 first:border-t-0')}
    >
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-normal">
        {/* Blue tint. 24 px tall: the canvas gives the badge height 22 px plus a 1 px border on
            each side without border-box, so that is how it is drawn there. */}
        <Badge
          variant="outline"
          className="h-6 border-status-editing/40 bg-primary/15 text-[#93c5fd]"
        >
          v{release.version}
        </Badge>
        <time dateTime={release.date} className="text-xs text-muted-foreground">
          {formatReleaseDate(release.date)}
        </time>
      </h3>
      <ul
        className={cn(
          'flex list-disc flex-col pl-[18px] text-zinc-300',
          variant === 'sheet' ? 'gap-1.5 text-[15px]' : 'gap-2',
        )}
      >
        {release.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {screenshot && (
        <ReleaseScreenshot src={screenshot} version={release.version} variant={variant} />
      )}
    </section>
  );
}

/** Every release as a section, in the order given (newest first), with a separator between. */
export function WhatsNewList({
  releases,
  variant = 'dialog',
}: {
  releases: readonly Release[];
  variant?: WhatsNewVariant;
}) {
  return (
    <div className={cn('flex flex-col', variant === 'dialog' && 'gap-4')}>
      {releases.map((release, index) => (
        <Fragment key={release.version}>
          {index > 0 && variant === 'dialog' && <Separator />}
          <WhatsNewSection release={release} variant={variant} />
        </Fragment>
      ))}
    </div>
  );
}

/** What a screen reader hears after the title: how many versions follow, and which. */
export function describeReleases(releases: readonly Release[]): string {
  const newest = releases[0];
  const oldest = releases[releases.length - 1];
  if (!newest || !oldest) return '';
  if (newest === oldest) return `Release notes for version ${newest.version}.`;
  return `Release notes for ${releases.length} versions, newest first: ${newest.version} down to ${oldest.version}.`;
}

/**
 * The inside of the dialog: the "What's new" title, the releases and "Got it". The three are
 * direct children of the dialog's content box (a flex column), so the list can scroll between a
 * header and a footer that stay put. Must sit inside a `<Dialog>` (it holds the title and the
 * description).
 */
export function WhatsNewPanel({
  releases,
  onClose,
  gotItRef,
  variant = 'dialog',
}: {
  releases: readonly Release[];
  onClose: () => void;
  gotItRef?: Ref<HTMLButtonElement>;
  variant?: WhatsNewVariant;
}) {
  const sheet = variant === 'sheet';
  return (
    <>
      <DialogHeader className={cn(sheet && 'px-4 pt-3.5 pb-2 text-left')}>
        {/* The phone's sheet has the board's curly apostrophe; the Mac's dialog keeps its own. */}
        <DialogTitle>{sheet ? 'What’s new' : "What's new"}</DialogTitle>
        <DialogDescription className="sr-only">{describeReleases(releases)}</DialogDescription>
      </DialogHeader>
      {/* Scrolls once it is taller than 70% of the window. Focusable so the keyboard can scroll it
          (the ring shows for keyboard focus only, and is the neutral one the buttons use). */}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area has to be focusable for the keyboard to scroll it; it is labelled as a region.
        tabIndex={0}
        aria-label="Release notes"
        data-slot="whats-new-scroll"
        className={cn(
          'min-h-0 flex-1 overflow-y-auto rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
          // The sheet is already capped at 700 px; the dialog's list stops at 70% of the window.
          sheet ? 'px-4' : 'max-h-[70vh]',
        )}
      >
        <WhatsNewList releases={releases} variant={variant} />
      </section>
      <DialogFooter className={cn(sheet && 'border-t px-4 pt-3 sm:flex-col')}>
        <Button
          ref={gotItRef}
          type="button"
          onClick={onClose}
          className={cn(sheet && 'h-12 w-full text-[15px]')}
        >
          Got it
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * One dialog with the notes of every release the user has not seen, newest first. "Got it", Esc
 * and a click outside all call `onClose`. With `variant="sheet"` (the phone layout) the same
 * notes slide up as a bottom sheet instead of opening in a centred box.
 */
export function WhatsNewDialog({
  releases,
  open,
  onClose,
  variant = 'dialog',
}: {
  releases: readonly Release[];
  open: boolean;
  onClose: () => void;
  variant?: WhatsNewVariant;
}) {
  const gotItRef = useRef<HTMLButtonElement>(null);

  // Radix returns focus to the dialog's trigger when it closes, and this dialog has none (the
  // sidebar button only flips the store), so remember what had focus when it opened. The dialog's
  // content mounts one commit after this effect runs, so focus is still on whatever opened it.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }, [open]);

  const isOpen = open && releases.length > 0;
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };
  // "Got it" is the primary action: it has focus whenever the dialog opens.
  const onOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    gotItRef.current?.focus();
  };
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (openerRef.current?.isConnected) openerRef.current.focus();
  };

  if (variant === 'sheet') {
    // A phone has no keyboard to press Enter on "Got it" with, and a focus ring on it that nobody
    // asked for is not in the board. Focus goes to the sheet itself (a screen reader reads its
    // title), and returns to what had it when the sheet closes.
    const onSheetOpenAutoFocus = (event: Event) => {
      event.preventDefault();
      (event.target as HTMLElement | null)?.focus();
    };
    return (
      <Sheet open={isOpen} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          onOpenAutoFocus={onSheetOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          // Board MWhatsNew: a 700 px sheet at most (less on a short phone), rounded on top, with
          // the grab handle above the title. The bottom padding clears the home indicator.
          className="max-h-[min(700px,calc(100dvh-1rem))] gap-0 rounded-t-2xl bg-popover pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
        >
          <SheetGrabber onClose={onClose} />
          <WhatsNewPanel releases={releases} onClose={onClose} variant="sheet" />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        // Stock shadcn box (title, list and footer are its flex children), kept inside the window
        // however short it is; the 480 px width is the canvas's. Opens and closes ease in and out.
        className="flex max-h-[calc(100dvh-2rem)] flex-col ease-in-out sm:max-w-120"
      >
        <WhatsNewPanel releases={releases} onClose={onClose} gotItRef={gotItRef} />
      </DialogContent>
    </Dialog>
  );
}
