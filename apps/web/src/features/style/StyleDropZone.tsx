import { Upload } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { AddFilesButton } from './AddFilesButton';
import { Spinner, StatusText } from './StyleStatusLine';
import type { StyleStatus } from './style-status';
import { namesText } from './style-text';

/** The words of the empty Style page (board "Style · none yet"). */
export const DROP_ZONE_TEXT = {
  title: 'No style yet',
  description:
    'Add a logo, fonts, a brand guide, notes or reference clips. They’re analysed into one style.md for this client. If you don’t, the first finished job writes it.',
  browse: 'Browse files',
  or: 'or drop files here',
  later: 'style.md appears here when it’s done.',
} as const;

/**
 * A client with no style.md: a centred dashed box that takes files (Browse files, or a drop on the
 * page). Files go up at once. While they go up, and while they are analysed, the box says so in
 * place of its invitation (`busy`: the upload or the style run; `names` are the files, when this
 * page sent them); style.md replaces the box when it is written.
 */
export function StyleDropZone({
  busy,
  names,
  dragging,
  onFiles,
}: {
  busy: Extract<StyleStatus, { kind: 'uploading' | 'busy' }> | null;
  names: readonly string[];
  /** Files are being dragged over the page. */
  dragging: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <div
      data-slot="style-drop-zone"
      className={cn(
        'flex min-h-[440px] flex-col items-center justify-center gap-3 rounded-[12px] border border-dashed px-6 py-12 text-center transition-colors duration-150 ease-in-out',
        dragging ? 'border-foreground/45 bg-foreground/[0.04]' : 'border-input',
      )}
    >
      {busy === null ? (
        <>
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-[10px] bg-muted"
          >
            <Upload className="size-5" />
          </span>
          <h2 className="text-base leading-[1.4] font-semibold">{DROP_ZONE_TEXT.title}</h2>
          <p className="max-w-[460px] text-pretty text-muted-foreground">
            {DROP_ZONE_TEXT.description}
          </p>
          <AddFilesButton onFiles={onFiles} className="mt-1">
            {DROP_ZONE_TEXT.browse}
          </AddFilesButton>
          <span className="text-[13px] text-muted-foreground">{DROP_ZONE_TEXT.or}</span>
        </>
      ) : (
        <>
          <Spinner className="size-5" />
          {/* A live region around the heading: it is announced, and stays a heading. */}
          <div role="status">
            <h2 className="text-base leading-[1.4] font-semibold">
              <StatusText status={busy} />
            </h2>
          </div>
          {busy.kind === 'uploading' && (
            <Progress value={busy.percent} aria-label="Upload progress" className="h-1.5 w-60" />
          )}
          {names.length > 0 && (
            <p dir="auto" className="max-w-[460px] text-muted-foreground [unicode-bidi:plaintext]">
              {namesText(names)}
            </p>
          )}
          <span className="text-[13px] text-muted-foreground">{DROP_ZONE_TEXT.later}</span>
        </>
      )}
    </div>
  );
}
