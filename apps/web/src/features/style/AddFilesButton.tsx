import { Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The change handler of the file input: hands `onFiles` the files that were picked, then empties
 * the input so that choosing the same file again still counts as a change.
 */
export function filesPicked(onFiles: (files: File[]) => void) {
  return ({ currentTarget }: { currentTarget: Pick<HTMLInputElement, 'files' | 'value'> }) => {
    const files = Array.from(currentTarget.files ?? []);
    currentTarget.value = '';
    onFiles(files);
  };
}

/**
 * "Add style files" and "Browse files": an outline button that is a `<label>` around a hidden file
 * input, so a click opens the system's picker (several files) with no script. The input takes the
 * keyboard focus (Tab, then Space or Enter), and the button shows it with the app's quiet ring.
 */
export function AddFilesButton({
  onFiles,
  disabled = false,
  icon = false,
  className,
  children,
}: {
  /** Files were chosen: the same function a drop calls. */
  onFiles: (files: File[]) => void;
  /** Bytes are on their way: the button waits. */
  disabled?: boolean;
  /** Draws the upload icon in front of the text. */
  icon?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      asChild
      variant="outline"
      className={cn(
        'relative cursor-pointer has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/35',
        // The board's buttons are 12 px each side, with or without the icon (stock is 16 px without).
        'px-3',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <label aria-disabled={disabled || undefined}>
        {icon && <Upload aria-hidden="true" />}
        {children}
        <input
          type="file"
          multiple
          disabled={disabled}
          onChange={filesPicked(onFiles)}
          className="sr-only"
        />
      </label>
    </Button>
  );
}
