import { absoluteTime, DM_KIND_LABELS, type DmItem, fileSize } from '@studio/shared';
import { Download, ExternalLink, FolderOpen, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { dmFileUrl } from '@/data';
import { at, DMS_TEXT, dmTitle, isInstagramLink, playerKind, shortLink } from './dm-text';

/** The sheet's width: the job sheet's. */
const SHEET_CLASSES =
  'w-full max-w-none gap-0 overflow-hidden p-0 outline-none data-[state=closed]:duration-200 data-[state=open]:duration-200 sm:max-w-none md:w-[420px]';

/** The item's file as the browser shows it: the video or sound with controls, or the picture. */
function Player({ item }: { item: DmItem }) {
  if (item.file === null) {
    return (
      <p className="rounded-lg bg-muted/60 px-4 py-6 text-center text-sm text-muted-foreground">
        {item.missing ?? DMS_TEXT.noFileYet}
      </p>
    );
  }
  const src = dmFileUrl(item.file.name);
  switch (playerKind(item.file.contentType)) {
    case 'video':
      return (
        // biome-ignore lint/a11y/useMediaCaption: a reel someone sent has no captions file
        <video
          key={src}
          src={src}
          controls
          playsInline
          preload="metadata"
          className="max-h-[62vh] w-full rounded-lg bg-black object-contain"
        />
      );
    case 'image':
      return (
        <img
          src={src}
          alt={dmTitle(item)}
          className="max-h-[62vh] w-full rounded-lg bg-muted object-contain"
        />
      );
    case 'audio':
      // biome-ignore lint/a11y/useMediaCaption: a sound someone sent has no captions file
      return <audio key={src} src={src} controls className="w-full" />;
    default:
      return null;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** One item: its file to watch or hear, what it says, and what can be done with it. */
export function DmSheet({
  item,
  onClose,
  onReveal,
}: {
  item: DmItem | null;
  onClose: () => void;
  onReveal: (item: DmItem) => void;
}) {
  // While it closes, the sheet keeps showing the item it had.
  const last = useRef<DmItem | null>(null);
  if (item !== null) last.current = item;
  const shown = item ?? last.current;
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className={SHEET_CLASSES}
      >
        {shown !== null && (
          <>
            <div className="flex h-14 flex-none items-center justify-between gap-3 border-b px-6">
              <SheetTitle className="text-base font-semibold">
                {DM_KIND_LABELS[shown.kind]}
              </SheetTitle>
              <SheetClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
                  <X />
                </Button>
              </SheetClose>
            </div>
            <div key={shown.id} className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-col gap-5 px-6 pt-5 pb-8">
                <Player item={shown} />
                <div className="flex flex-wrap gap-2">
                  {shown.file !== null && (
                    <>
                      <Button asChild variant="outline" size="sm">
                        <a href={dmFileUrl(shown.file.name)} download={shown.file.name}>
                          <Download />
                          {DMS_TEXT.download}
                        </a>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onReveal(shown)}
                      >
                        <FolderOpen />
                        {DMS_TEXT.reveal}
                      </Button>
                    </>
                  )}
                  {shown.link !== null && (
                    <Button asChild variant="outline" size="sm">
                      <a href={shown.link} target="_blank" rel="noopener noreferrer">
                        <ExternalLink />
                        {isInstagramLink(shown.link) ? DMS_TEXT.openOnInstagram : DMS_TEXT.openLink}
                      </a>
                    </Button>
                  )}
                </div>
                <dl className="flex flex-col gap-2.5">
                  {shown.title !== null && (
                    <Field label={DMS_TEXT.caption}>
                      <span dir="auto" className="whitespace-pre-line">
                        {shown.title}
                      </span>
                    </Field>
                  )}
                  {shown.text !== null && (
                    <Field label={DMS_TEXT.message}>
                      <span dir="auto" className="whitespace-pre-line">
                        {shown.text}
                      </span>
                    </Field>
                  )}
                  <Field label={DMS_TEXT.from}>{at(shown.from)}</Field>
                  <Field label={DMS_TEXT.sent}>{absoluteTime(shown.at)}</Field>
                  {shown.file !== null && (
                    <Field label={DMS_TEXT.file}>
                      {fileSize(shown.file.bytes)} · {shown.file.contentType}
                    </Field>
                  )}
                  {shown.link !== null && (
                    <Field label={DMS_TEXT.link}>
                      <a
                        href={shown.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-4 hover:underline"
                      >
                        {shortLink(shown.link)}
                      </a>
                    </Field>
                  )}
                </dl>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
