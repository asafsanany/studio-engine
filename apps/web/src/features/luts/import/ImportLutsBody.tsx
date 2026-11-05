import { LUT_KIND_LABELS, LUT_KINDS, type LutKind, lutSizeLabel } from '@studio/shared';
import { CircleAlert, File as FileIcon, LoaderCircle, Upload, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { lutFilesOf } from './lut-files';
import type { LutImportRow, LutImportState } from './lut-import-session';
import {
  copyingText,
  filesText,
  importLabel,
  LUT_IMPORT_TEXT,
  lutBytesText,
  pickedSubline,
} from './lut-import-text';

/** The line under the dialog's title, which changes with the step (board LUStates 3, 4 and 5). */
export function importSubline(state: Pick<LutImportState, 'step' | 'rows'>): string {
  switch (state.step) {
    case 'pick':
      return LUT_IMPORT_TEXT.pick;
    case 'sending':
    case 'importing':
      return LUT_IMPORT_TEXT.working;
    case 'failed':
      return `${filesText(state.rows.length)} picked. Nothing was added.`;
    default:
      return importableCount(state.rows) === 0
        ? LUT_IMPORT_TEXT.noneGood
        : pickedSubline(state.rows.length);
  }
}

/**
 * The line under the dialog's title. Opened for a job that waits for a camera LUT (LU10), step 1
 * says what it is looking for ("For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT."); every
 * later step says what it always did.
 */
export function dialogSubline(
  state: Pick<LutImportState, 'step' | 'rows'>,
  forJob: { subline: string } | null = null,
): string {
  return forJob !== null && state.step === 'pick' ? forJob.subline : importSubline(state);
}

/** The rows that will be imported: they passed their check and have a kind. */
export function importableCount(rows: readonly LutImportRow[]): number {
  return rows.filter((row) => row.ok && row.kind !== null).length;
}

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
 * makes it pick a folder, whose files come back flattened and cut down to the .cube and .3dl ones.
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
          accept={folder ? undefined : '.cube,.3dl'}
          disabled={disabled}
          className="sr-only"
          {...(folder ? { webkitdirectory: '' } : {})}
          onChange={({ currentTarget }) => {
            const picked = Array.from(currentTarget.files ?? []);
            currentTarget.value = '';
            onFiles(folder ? lutFilesOf(picked) : picked);
          }}
        />
      </label>
    </Button>
  );
}

/** Step 1: the dashed zone with its two buttons (board LUStates 3). */
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
      data-slot="lut-import-zone"
      data-dragging={dragging || undefined}
      className={cn(
        'flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition-colors duration-150 ease-in-out',
        dragging && !offline ? 'border-foreground/45 bg-foreground/[0.04]' : 'border-foreground/20',
      )}
    >
      <Upload aria-hidden="true" className="size-6 text-muted-foreground" />
      <span className="font-medium">{LUT_IMPORT_TEXT.dropTitle}</span>
      <span className="text-[13px] text-muted-foreground">{LUT_IMPORT_TEXT.dropHint}</span>
      <div className="mt-2 flex gap-2">
        <PickButton disabled={offline} onFiles={onFiles}>
          {LUT_IMPORT_TEXT.chooseFiles}
        </PickButton>
        <PickButton folder disabled={offline} onFiles={onFiles}>
          {LUT_IMPORT_TEXT.chooseFolder}
        </PickButton>
      </div>
      {offline && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {LUT_IMPORT_TEXT.offline}
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

/** Look / Camera / Fix for one file (board LUStates 4). Enter on it picks the kind and nothing else. */
function KindControl({
  value,
  disabled,
  onChange,
}: {
  value: LutKind;
  disabled: boolean;
  onChange: (kind: LutKind) => void;
}) {
  return (
    <fieldset
      aria-label={LUT_IMPORT_TEXT.kindLabel}
      className="inline-flex min-w-0 gap-0.5 rounded-lg bg-card p-0.5"
    >
      {LUT_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={kind === value}
          disabled={disabled}
          onClick={() => onChange(kind)}
          className={cn(
            'h-6 cursor-pointer rounded-md px-2 text-xs font-medium transition-colors duration-150 ease-in-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-default',
            kind === value
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {LUT_KIND_LABELS[kind]}
        </button>
      ))}
    </fieldset>
  );
}

/** What a row says under its name: the grid and the size, or why the file is not a LUT. */
export function rowInfo(row: LutImportRow): string {
  if (!row.ok) return row.error ?? '';
  const size = lutBytesText(row.bytes);
  return row.size === null ? size : `${lutSizeLabel(row.size)} · ${size}`;
}

function Row({
  row,
  busy,
  onKind,
  onRemove,
}: {
  row: LutImportRow;
  busy: boolean;
  onKind: (id: string, kind: LutKind) => void;
  onRemove: (id: string) => void;
}) {
  const bad = !row.ok;
  return (
    <li
      data-ok={row.ok}
      className={cn(
        'grid min-h-11 grid-cols-[16px_minmax(0,1fr)_auto_28px] items-center gap-3 rounded-lg py-1.5 pr-1 pl-3',
        busy && bad && 'opacity-50',
      )}
    >
      {bad ? (
        <CircleAlert aria-hidden="true" className="size-4 text-destructive" />
      ) : (
        <FileIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-col">
        <span dir="auto" className="truncate font-medium [unicode-bidi:plaintext]">
          {row.name}
        </span>
        <span className={cn('text-[13px]', bad ? 'text-red-300' : 'text-muted-foreground')}>
          {rowInfo(row)}
        </span>
      </span>
      {row.ok && row.kind !== null ? (
        <KindControl value={row.kind} disabled={busy} onChange={(kind) => onKind(row.id, kind)} />
      ) : (
        <span />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        aria-label={`Remove ${row.name} from the list`}
        title="Remove"
        onClick={() => onRemove(row.id)}
        className="size-7 cursor-pointer text-muted-foreground"
      >
        <X aria-hidden="true" className="size-3.5" />
      </Button>
    </li>
  );
}

export interface ImportLutsBodyProps {
  state: LutImportState;
  /** The engine cannot be reached: nothing can be picked. */
  offline: boolean;
  /** Files are being dragged over the window. */
  dragging: boolean;
  onFiles: (files: File[]) => void;
  onKind: (id: string, kind: LutKind) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;
  onImport: () => void;
  onCancel: () => void;
}

/**
 * Everything of the dialog under its title (boards LUStates 3 to 5): step 1's drop zone, or the list
 * of files with their verdicts, and the footer. Plain markup over a session state, so it is tested
 * as markup; `ImportLutsDialog` puts it in the dialog.
 */
export function ImportLutsBody({
  state,
  offline,
  dragging,
  onFiles,
  onKind,
  onRemove,
  onRetry,
  onImport,
  onCancel,
}: ImportLutsBodyProps) {
  const { step, rows } = state;
  const importing = step === 'importing';
  const busy = importing || step === 'sending';
  const ready = importableCount(rows);

  let primary: { label: string; disabled: boolean; onClick: () => void };
  if (step === 'failed') {
    primary = { label: LUT_IMPORT_TEXT.retry, disabled: rows.length === 0, onClick: onRetry };
  } else if (importing) {
    primary = { label: 'Importing…', disabled: true, onClick: onImport };
  } else {
    primary = {
      label: importLabel(ready),
      disabled: step !== 'listed' || ready === 0,
      onClick: onImport,
    };
  }

  return (
    <div data-slot="import-luts-body" data-step={step}>
      <div className="px-6 pt-4">
        {step === 'pick' ? (
          <DropZone dragging={dragging} offline={offline} notice={state.notice} onFiles={onFiles} />
        ) : (
          <>
            <ul
              aria-label={LUT_IMPORT_TEXT.filesLabel}
              className="flex max-h-[min(50vh,360px)] flex-col gap-0.5 overflow-y-auto"
            >
              {rows.map((row) => (
                <Row key={row.id} row={row} busy={busy} onKind={onKind} onRemove={onRemove} />
              ))}
            </ul>
            {step === 'sending' && (
              <div
                role="status"
                className="mt-3 flex flex-col gap-2 text-[13px] text-muted-foreground"
              >
                <span className="flex items-center gap-2.5">
                  <Spinner className="size-4 text-blue-500" />
                  Checking {filesText(rows.length)}…
                </span>
                <Progress value={state.percent} aria-label="Upload progress" className="h-1" />
              </div>
            )}
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
        <span className="max-w-[260px] text-xs text-muted-foreground/70">
          {LUT_IMPORT_TEXT.footer}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={importing}
            onClick={onCancel}
            className="cursor-pointer"
          >
            {LUT_IMPORT_TEXT.cancel}
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
