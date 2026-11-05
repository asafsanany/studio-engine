import { Type as FontIcon, Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import { FileText } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { StyleUploadMode } from '@/data';
import { cn } from '@/lib/utils';
import { type FileKind, fileCountText, fileKind } from './style-text';

/** The words of the dialog (board "Add style files · add or replace"). */
export const ADD_DIALOG_TEXT = {
  description: 'They’re analysed and written into one style.md.',
  groupLabel: 'What to do with these files',
  cancel: 'Cancel',
} as const;

/** Both choices: what the radio cards say, and what the confirm button is called for each. */
export const ADD_OPTIONS: readonly {
  mode: StyleUploadMode;
  title: string;
  description: string;
  confirm: string;
}[] = [
  {
    mode: 'add',
    title: 'Add to the current style',
    description: 'Merged into style.md. Where the new files disagree with it, they win.',
    confirm: 'Add to style',
  },
  {
    mode: 'replace',
    title: 'Replace the style',
    description: 'A new style.md from these files only. The current one is kept in history.',
    confirm: 'Replace style',
  },
];

/** How many file names the dialog lists before "and 4 more". */
const SHOWN_FILES = 5;

const FILE_ICONS: Record<FileKind, typeof FileText> = {
  image: ImageIcon,
  font: FontIcon,
  video: VideoIcon,
  doc: FileText,
};

/**
 * "Add 3 files to <client>'s style?": asked when the client already has a style.md. The files are
 * listed (five, then "and N more") with an icon for their kind; Add to the current style is chosen
 * to begin with, and Replace the style is the other card. Confirm uploads; Cancel, Escape or a
 * click outside leaves the style as it is.
 */
export function AddStyleDialog({
  open,
  client,
  files,
  mode,
  onModeChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  client: string;
  files: readonly File[];
  mode: StyleUploadMode;
  onModeChange: (mode: StyleUploadMode) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const chosen = ADD_OPTIONS.find((option) => option.mode === mode) ?? ADD_OPTIONS[0];
  const more = files.length - SHOWN_FILES;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        showCloseButton={false}
        // One shrinkable column: a long file name is cut by its ellipsis, not pushed out of the box.
        className="grid-cols-1 gap-5 leading-normal sm:max-w-[480px]"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="leading-[1.4]">
            Add {fileCountText(files.length)} to <bdi>{client}</bdi>’s style?
          </DialogTitle>
          <DialogDescription className="leading-normal">
            {ADD_DIALOG_TEXT.description}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-1.5">
          {files.slice(0, SHOWN_FILES).map((file, i) => {
            const Icon = FILE_ICONS[fileKind(file.name)];
            return (
              // The same name can be picked twice (from two folders): the position tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: a list that is only ever shown, never reordered
              <li key={`${i}:${file.name}`} className="flex min-w-0 items-center gap-2">
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span dir="auto" className="bidi">
                  {file.name}
                </span>
              </li>
            );
          })}
          {more > 0 && <li className="pl-6 text-muted-foreground">and {more} more</li>}
        </ul>

        <RadioGroup
          value={mode}
          onValueChange={(next) => onModeChange(next === 'replace' ? 'replace' : 'add')}
          aria-label={ADD_DIALOG_TEXT.groupLabel}
          className="gap-2"
        >
          {ADD_OPTIONS.map((option) => {
            const radioId = `add-style-${option.mode}`;
            const titleId = `${radioId}-title`;
            const descriptionId = `${radioId}-description`;
            return (
              <label
                key={option.mode}
                htmlFor={radioId}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 transition-colors duration-150 ease-in-out',
                  option.mode === mode
                    ? 'border-foreground/35 bg-foreground/[0.03]'
                    : 'border-border',
                )}
              >
                <RadioGroupItem
                  id={radioId}
                  value={option.mode}
                  aria-labelledby={titleId}
                  aria-describedby={descriptionId}
                  className="mt-[3px]"
                />
                <span className="flex flex-col gap-0.5">
                  <span id={titleId} className="font-medium">
                    {option.title}
                  </span>
                  <span id={descriptionId} className="text-pretty text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {ADD_DIALOG_TEXT.cancel}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {chosen?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
