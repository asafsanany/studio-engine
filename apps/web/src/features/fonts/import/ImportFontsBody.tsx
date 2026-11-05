import type { FontStageItem } from '@studio/shared';
import {
  CaseSensitive,
  Check,
  CircleAlert,
  LoaderCircle,
  type LucideIcon,
  Upload,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { FONT_PICK_ACCEPT, fontFilesOf } from './font-files';
import { type FontImportState, importableCount } from './font-import-session';
import {
  addsTag,
  checkingText,
  copyingText,
  FONT_IMPORT_TEXT,
  failedSubline,
  importLabel,
  pickedSubline,
} from './font-import-text';

/** The line under the dialog's title, which changes with the step (board FOStates 3, 4 and 5). */
export function importSubline(state: Pick<FontImportState, 'step' | 'items' | 'picked'>): string {
  switch (state.step) {
    case 'pick':
      return FONT_IMPORT_TEXT.pick;
    case 'sending':
    case 'importing':
      return FONT_IMPORT_TEXT.working;
    case 'failed':
      return failedSubline(state.picked);
    default:
      return pickedSubline(state.items.length);
  }
}

/** What a row's tag says and how it looks: blue for a font that goes in, grey for one already here, red for one that can't. */
export interface FontRowTag {
  label: string;
  tone: 'good' | 'same' | 'bad';
}

/** The tag at the end of a row: New / Adds N / Already here / Can’t import (a conflict is a "can’t" too). */
export function rowTag(item: Pick<FontStageItem, 'status' | 'weights'>): FontRowTag {
  switch (item.status) {
    case 'new':
      return { label: FONT_IMPORT_TEXT.tagNew, tone: 'good' };
    case 'adds':
      return { label: addsTag(new Set(item.weights).size), tone: 'good' };
    case 'same':
      return { label: FONT_IMPORT_TEXT.tagSame, tone: 'same' };
    default:
      return { label: FONT_IMPORT_TEXT.tagBad, tone: 'bad' };
  }
}

const TAG_STYLES: Record<FontRowTag['tone'], string> = {
  good: 'bg-blue-500/15 text-blue-300',
  same: 'bg-secondary text-muted-foreground',
  bad: 'bg-red-400/15 text-red-300',
};

function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn('animate-spin motion-reduce:animate-none', className)}
    />
  );
}

/**
 * A button that is a `<label>` around a hidden file input, so a click opens the system's picker with
 * no script, and the input takes the keyboard focus (the label shows the quiet ring). `folder`
 * makes it pick a folder, whose files come back flattened and cut down to the font files.
 */
function PickButton({
  folder = false,
  disabled,
  onFiles,
  children,
}: {
  folder?: boolean;
  disabled: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className={cn(
        'relative cursor-pointer has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/35',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <label aria-disabled={disabled || undefined}>
        {children}
        <input
          type="file"
          multiple={!folder}
          accept={folder ? undefined : FONT_PICK_ACCEPT}
          disabled={disabled}
          className="sr-only"
          {...(folder ? { webkitdirectory: '' } : {})}
          onChange={({ currentTarget }) => {
            const picked = Array.from(currentTarget.files ?? []);
            currentTarget.value = '';
            onFiles(folder ? fontFilesOf(picked) : picked);
          }}
        />
      </label>
    </Button>
  );
}

/** Step 1: the dashed zone with its two buttons (board FOStates 3). */
function DropZone({
  dragging,
  offline,
  notice,
  onFiles,
}: {
  dragging: boolean;
  offline: boolean;
  notice: string | null;
  onFiles: (files: File[]) => void;
}) {
  return (
    <div
      data-slot="font-import-zone"
      data-dragging={dragging || undefined}
      className={cn(
        'flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition-colors duration-150 ease-in-out',
        dragging && !offline ? 'border-foreground/45 bg-foreground/[0.04]' : 'border-foreground/20',
      )}
    >
      <Upload aria-hidden="true" className="size-6 text-muted-foreground" />
      <span className="font-medium">{FONT_IMPORT_TEXT.dropTitle}</span>
      <span className="text-[13px] text-muted-foreground">{FONT_IMPORT_TEXT.dropHint}</span>
      <div className="mt-2 flex gap-2">
        <PickButton disabled={offline} onFiles={onFiles}>
          {FONT_IMPORT_TEXT.chooseFiles}
        </PickButton>
        <PickButton folder disabled={offline} onFiles={onFiles}>
          {FONT_IMPORT_TEXT.chooseFolder}
        </PickButton>
      </div>
      {offline && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {FONT_IMPORT_TEXT.offline}
        </p>
      )}
      {notice !== null && (
        <p role="alert" className="text-[13px] text-destructive">
          {notice}
        </p>
      )}
    </div>
  );
}

function rowIcon(item: Pick<FontStageItem, 'status'>): { Icon: LucideIcon; className: string } {
  switch (item.status) {
    case 'same':
      return { Icon: Check, className: 'text-muted-foreground' };
    case 'conflict':
    case 'bad':
      return { Icon: CircleAlert, className: 'text-destructive' };
    default:
      return { Icon: CaseSensitive, className: 'text-muted-foreground' };
  }
}

function Row({
  item,
  busy,
  onRemove,
}: {
  item: FontStageItem;
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  const bad = item.status === 'bad' || item.status === 'conflict';
  const tag = rowTag(item);
  const { Icon, className } = rowIcon(item);
  return (
    <li
      data-status={item.status}
      className={cn(
        // 56 px at least, as the board's rows are (44 px of content plus their padding).
        'grid min-h-14 grid-cols-[16px_minmax(0,1fr)_auto_28px] items-center gap-3 rounded-lg py-1.5 pr-1 pl-3',
        item.status === 'same' && 'opacity-60',
        busy && bad && 'opacity-50',
      )}
    >
      <Icon aria-hidden="true" className={cn('size-4', className)} />
      <span className="flex min-w-0 flex-col">
        <span dir="auto" className="truncate font-medium [unicode-bidi:plaintext]">
          {item.name}
        </span>
        <span className={cn('text-[13px]', bad ? 'text-red-300' : 'text-muted-foreground')}>
          {item.info}
        </span>
      </span>
      <span
        data-slot="font-import-tag"
        className={cn(
          'inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap',
          TAG_STYLES[tag.tone],
        )}
      >
        {tag.label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        aria-label={`Remove ${item.name} from the list`}
        title="Remove"
        onClick={() => onRemove(item.id)}
        className="size-7 cursor-pointer text-muted-foreground"
      >
        <X aria-hidden="true" className="size-3.5" />
      </Button>
    </li>
  );
}

export interface ImportFontsBodyProps {
  state: FontImportState;
  /** The engine cannot be reached: nothing can be picked. */
  offline: boolean;
  /** Files are being dragged over the window. */
  dragging: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;
  onImport: () => void;
  onCancel: () => void;
}

/**
 * Everything of the dialog under its title (boards FOStates 3 to 5): step 1's drop zone, or the list
 * of families with their verdicts, and the footer. Plain markup over a session state, so it is
 * tested as markup; `ImportFontsDialog` puts it in the dialog.
 */
export function ImportFontsBody({
  state,
  offline,
  dragging,
  onFiles,
  onRemove,
  onRetry,
  onImport,
  onCancel,
}: ImportFontsBodyProps) {
  const { step, items } = state;
  const importing = step === 'importing';
  const busy = importing || step === 'sending';
  const ready = importableCount(items);

  let primary: { label: string; disabled: boolean; onClick: () => void };
  if (step === 'failed') {
    primary = { label: FONT_IMPORT_TEXT.retry, disabled: false, onClick: onRetry };
  } else if (importing) {
    primary = { label: FONT_IMPORT_TEXT.importing, disabled: true, onClick: onImport };
  } else {
    primary = {
      label: importLabel(ready),
      disabled: step !== 'listed' || ready === 0,
      onClick: onImport,
    };
  }

  return (
    <div data-slot="import-fonts-body" data-step={step}>
      <div className="px-6 pt-4">
        {step === 'pick' && (
          <DropZone dragging={dragging} offline={offline} notice={state.notice} onFiles={onFiles} />
        )}
        {step === 'sending' && (
          <div role="status" className="flex flex-col gap-2 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-2.5">
              <Spinner className="size-4 text-blue-500" />
              {checkingText(state.picked)}
            </span>
            <Progress value={state.percent} aria-label="Upload progress" className="h-1" />
          </div>
        )}
        {step === 'failed' && state.error !== null && (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        )}
        {(step === 'listed' || importing) && (
          <>
            <ul
              aria-label={FONT_IMPORT_TEXT.listLabel}
              className="flex max-h-[min(50vh,360px)] flex-col gap-0.5 overflow-y-auto"
            >
              {items.map((item) => (
                <Row key={item.id} item={item} busy={busy} onRemove={onRemove} />
              ))}
            </ul>
            {importing && (
              <div
                role="status"
                className="mt-3 flex items-center gap-2.5 text-[13px] text-muted-foreground"
              >
                <Spinner className="size-4 text-blue-500" />
                {copyingText(ready)}
              </div>
            )}
            {state.error !== null && (
              <p role="alert" className="mt-3 text-[13px] text-destructive">
                {state.error}
              </p>
            )}
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-6 pt-4 pb-6">
        <span className="max-w-[280px] text-xs text-muted-foreground/70">
          {FONT_IMPORT_TEXT.footer}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={importing}
            onClick={onCancel}
            className="cursor-pointer"
          >
            {FONT_IMPORT_TEXT.cancel}
          </Button>
          <Button
            type="button"
            disabled={primary.disabled}
            onClick={primary.onClick}
            className="cursor-pointer"
          >
            {primary.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
