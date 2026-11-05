import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SheetFile } from './sheet-now';
import type { SheetVariant } from './sheet-variant';

/**
 * The files of an approved job that has one video for each format (Generated videos, GN9; board
 * GNSheet, Approved): each with its name, what it is ("9:16 · 1080 × 1920 · 0:35 · 27 MB") and a
 * Download button of its own. `waiting` is the engine out of reach: the links wait with the
 * other buttons. On the phone the buttons are 44 px tall.
 */
export function JobSheetFiles({
  files,
  waiting = false,
  variant = 'mac',
}: {
  files: readonly SheetFile[];
  waiting?: boolean;
  variant?: SheetVariant;
}) {
  if (files.length === 0) return null;
  const phone = variant === 'phone';
  return (
    <section aria-label="Files" data-slot="job-sheet-files" className="flex flex-col gap-2">
      {files.map((file) => (
        <div
          key={file.format}
          data-file={file.format}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
        >
          <span className="flex min-w-0 flex-col gap-px">
            <span dir="auto" className="font-medium wrap-anywhere [unicode-bidi:plaintext]">
              {file.name}
            </span>
            <span className="text-[13px] text-muted-foreground tabular-nums">{file.sub}</span>
          </span>
          <Button
            asChild
            variant="outline"
            size="sm"
            className={cn(
              phone ? 'h-11 px-3.5 text-[15px]' : 'h-8',
              waiting && 'pointer-events-none opacity-50',
            )}
          >
            <a
              href={waiting ? undefined : file.href}
              download
              aria-label={file.label}
              data-sheet-download={file.format}
              aria-disabled={waiting ? true : undefined}
              tabIndex={waiting ? -1 : undefined}
            >
              <Download aria-hidden="true" />
              Download
            </a>
          </Button>
        </div>
      ))}
    </section>
  );
}
