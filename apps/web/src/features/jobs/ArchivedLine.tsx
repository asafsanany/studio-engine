import { Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ArchivedLine as ArchivedLineState } from './use-jobs-list';

/** What the line says: "2 more archived · Show", "2 archived · Show" or "Hide archived". */
export function archivedLineText(line: ArchivedLineState): string {
  if (line.kind === 'hide') return 'Hide archived';
  return `${line.count} ${line.more ? 'more archived' : 'archived'} · Show`;
}

/**
 * The quiet line under the list that offers the archive: a ghost button with the box icon, in muted
 * 13 px text, at the left. "N archived · Show" turns Show archived on; with it on, a client's page
 * says "Hide archived" and turns it off. It is a button, so the keyboard reaches it.
 */
export function ArchivedLine({
  line,
  onShow,
  onHide,
}: {
  line: ArchivedLineState;
  onShow: () => void;
  onHide: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={line.kind === 'hide' ? onHide : onShow}
      className="gap-2 self-start rounded-lg text-[13px] text-muted-foreground transition-colors duration-150 ease-in-out hover:text-foreground"
    >
      <Archive aria-hidden />
      {archivedLineText(line)}
    </Button>
  );
}
