import { Check, Copy, Download, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRetryNoSong } from '@/data';
import { cn } from '@/lib/utils';
import { useCopyLine } from './copy-line';
import { type NoSongRow, SONG_SHEET_TEXT, type SongFile } from './sheet-songs';
import type { SheetVariant } from './sheet-variant';

/** A download link while the engine is out of reach: it waits, as `NowButtons`' Download does. */
const WAITING = 'pointer-events-none opacity-50';

/** A file's name and the muted line under it, in their own reading direction. */
function FileName({ name, sub, tone }: { name: string; sub: string; tone?: 'failure' }) {
  return (
    <span className="flex min-w-0 flex-col gap-px">
      <span dir="auto" className="text-left font-medium [unicode-bidi:plaintext] wrap-anywhere">
        {name}
      </span>
      <span
        dir="auto"
        data-slot="song-file-sub"
        className={cn(
          'text-left text-[13px] text-pretty [unicode-bidi:plaintext] wrap-anywhere',
          tone === 'failure' ? 'text-status-failed-foreground' : 'text-muted-foreground',
        )}
      >
        {sub}
      </span>
    </span>
  );
}

/**
 * One file's row (board SGSheet, Files): its name, "With the song · to show the client · 0:39"
 * under it, and Download at the end: the primary button for the file to show, an outline one for
 * the file to post. A link to the engine's download, so it waits while the engine is out of reach.
 */
export function SongFileRow({
  file,
  primary,
  waiting = false,
}: {
  file: SongFile;
  primary: boolean;
  waiting?: boolean;
}) {
  return (
    <div
      data-song-file={file.id}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
    >
      <FileName name={file.name} sub={file.sub} />
      <Button
        asChild
        size="sm"
        variant={primary ? 'default' : 'outline'}
        className={cn(
          'text-[13px]',
          primary && 'bg-zinc-50 text-zinc-900 hover:bg-zinc-200',
          waiting && WAITING,
        )}
      >
        <a
          href={waiting ? undefined : file.href}
          download
          data-sheet-download={file.id}
          aria-disabled={waiting ? true : undefined}
          tabIndex={waiting ? -1 : undefined}
        >
          <Download aria-hidden="true" className="size-3.5" />
          {SONG_SHEET_TEXT.download}
        </a>
      </Button>
    </div>
  );
}

/**
 * The second file's row by where it stands: made (a Download), being made ("Making the file
 * without the song…" and a spinner) or not made (the reason in red and Try again).
 */
export function NoSongFileRow({
  row,
  waiting = false,
  retrying = false,
  onTryAgain,
}: {
  row: NoSongRow;
  waiting?: boolean;
  /** Try again was pressed and the engine has not answered yet. */
  retrying?: boolean;
  onTryAgain: () => void;
}) {
  if (row.state === 'ready')
    return <SongFileRow file={row.file} primary={false} waiting={waiting} />;
  if (row.state === 'making') {
    return (
      <div
        role="status"
        data-song-file="no-song"
        data-song-state="making"
        className="flex items-center gap-2 text-muted-foreground"
      >
        <Loader2
          aria-hidden="true"
          className="size-4 flex-none animate-spin motion-reduce:animate-none"
        />
        <span>{SONG_SHEET_TEXT.making}</span>
      </div>
    );
  }
  return (
    <div
      data-song-file="no-song"
      data-song-state="failed"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
    >
      <FileName name={row.name} sub={row.message} tone="failure" />
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-sheet-action="try-again"
        disabled={waiting || retrying}
        onClick={onTryAgain}
        className="text-[13px]"
      >
        {retrying ? (
          <Loader2
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <RotateCcw aria-hidden="true" className="size-3.5" />
        )}
        {SONG_SHEET_TEXT.tryAgain}
      </Button>
    </div>
  );
}

/** The Files section: the file to show the client, and the file to post. */
export function SongFilesSection({
  withSong,
  noSong,
  waiting = false,
  retrying = false,
  onTryAgain,
}: {
  withSong: SongFile;
  noSong: NoSongRow;
  waiting?: boolean;
  retrying?: boolean;
  onTryAgain: () => void;
}) {
  return (
    <section aria-label="Files" data-slot="song-files" className="flex flex-col gap-2">
      <SongFileRow file={withSong} primary waiting={waiting} />
      <NoSongFileRow row={noSong} waiting={waiting} retrying={retrying} onTryAgain={onTryAgain} />
    </section>
  );
}

/**
 * Copy: an outline button that puts the whole line on the clipboard and says "Copied" for two
 * seconds. 28 px high on the Mac, a 44 px target on the phone (board SGSheet; the phone's rows).
 */
export function CopyLineButton({
  text,
  variant = 'mac',
}: {
  text: string;
  variant?: SheetVariant;
}) {
  const { copied, copy } = useCopyLine(text);
  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant="outline"
      data-sheet-copy-line=""
      onClick={copy}
      className={cn(
        'font-medium',
        variant === 'phone' ? 'h-11 px-3.5 text-[15px]' : 'h-7 gap-1.5 px-2.5 text-[13px]',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          variant === 'phone' ? 'size-4' : 'size-[13px]',
          copied && 'text-status-ready',
        )}
      />
      {copied ? SONG_SHEET_TEXT.copied : SONG_SHEET_TEXT.copy}
    </Button>
  );
}

/**
 * "To post on Instagram" (board SGSheet): the line to send with the file that has no song, in a
 * muted box in its own reading direction (a Hebrew title next to English words), Copy beside the
 * title, and a hint under it.
 */
export function SongPostSection({
  text,
  variant = 'mac',
}: {
  text: string;
  variant?: SheetVariant;
}) {
  return (
    <section
      aria-label={SONG_SHEET_TEXT.postTitle}
      data-slot="song-post"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">
          {SONG_SHEET_TEXT.postTitle}
        </h3>
        <CopyLineButton text={text} variant={variant} />
      </div>
      <p
        dir="auto"
        data-slot="song-post-text"
        className="rounded-lg bg-white/4 px-3 py-2.5 text-left text-pretty text-zinc-200 [unicode-bidi:plaintext]"
      >
        {text}
      </p>
      <span className="text-xs text-zinc-500">{SONG_SHEET_TEXT.postHint}</span>
    </section>
  );
}

/**
 * The song job's two files and the line to post, where Download MP4 was (the Now part). Try again
 * asks the engine to make the second file again; a refusal is a toast with its words (`useRetryNoSong`).
 */
export function JobSheetSongFiles({
  jobId,
  withSong,
  noSong,
  post,
  waiting = false,
}: {
  jobId: string;
  withSong: SongFile;
  noSong: NoSongRow;
  post: string;
  /** The engine is out of reach: the downloads and Try again wait. */
  waiting?: boolean;
}) {
  const retry = useRetryNoSong(jobId);
  return (
    <div data-slot="job-sheet-song-files" className="flex flex-col gap-4">
      <SongFilesSection
        withSong={withSong}
        noSong={noSong}
        waiting={waiting}
        retrying={retry.isPending}
        onTryAgain={() => retry.mutate()}
      />
      <SongPostSection text={post} />
    </div>
  );
}
