import { type GraphicDetail, NEW_GRAPHIC_NAME } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, Ellipsis, Folder } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { headStatus, nameAction, renameBlockedReason, type StatusTone } from './studio-logic';
import { HEADER_TEXT } from './studio-text';
import { Tip } from './Tip';

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  muted: 'text-muted-foreground',
  making: 'text-blue-300',
  failed: 'text-red-300',
};

interface StudioHeaderProps {
  /** `undefined`: the new graphic of /graphics/new, which has nothing to rename or open yet. */
  graphic: GraphicDetail | undefined;
  /** The engine cannot be reached: the buttons wait. */
  offline: boolean;
  /** Saves a new name; answers whether the engine took it. */
  onRename: (name: string) => Promise<boolean>;
  onToggleUses: () => void;
  onReveal: () => void;
  onDuplicate: () => void;
  /** Delete…: the page asks first. */
  onDelete: () => void;
  /** Opens with the name already in its field (tests). */
  initialRenaming?: boolean;
}

/**
 * The 56 px bar of a graphic's page (board GRStudio): ‹ Graphics, the name (a click renames it
 * where it stands; Enter or leaving saves, Esc cancels), its status, Show in Finder as a ghost
 * icon and the ⋯ menu. A graphic that is being made cannot be renamed, and says why.
 */
export function StudioHeader({
  graphic,
  offline,
  onRename,
  onToggleUses,
  onReveal,
  onDuplicate,
  onDelete,
  initialRenaming = false,
}: StudioHeaderProps) {
  const [renaming, setRenaming] = useState(initialRenaming && graphic !== undefined);
  const [draft, setDraft] = useState(graphic?.name ?? '');
  const field = useRef<HTMLInputElement>(null);
  /** The field closed (Enter, Esc): the blur that follows must not save a second time. */
  const closed = useRef(false);
  /** Rename was chosen in the ⋯ menu: the menu must not hand the focus back to its button. */
  const fromMenu = useRef(false);

  const name = graphic?.name ?? NEW_GRAPHIC_NAME;
  const status = headStatus(graphic);
  const blockedReason = renameBlockedReason(graphic);
  const canRename = graphic !== undefined && blockedReason === null && !offline;
  const hasVersion = graphic?.version != null;

  useEffect(() => {
    if (!renaming) return;
    closed.current = false;
    field.current?.focus();
    field.current?.select();
  }, [renaming]);

  function startRename() {
    if (!canRename) return;
    setDraft(name);
    setRenaming(true);
  }

  function finish(save: boolean) {
    if (closed.current) return;
    closed.current = true;
    setRenaming(false);
    if (!save) return;
    const action = nameAction(draft, name);
    if (action.kind === 'save') void onRename(action.name);
  }

  return (
    <header
      data-slot="studio-header"
      className="flex h-14 flex-none items-center gap-1.5 border-b pr-4 pl-3"
    >
      <Button asChild variant="ghost" size="sm" className="pl-1.5 text-muted-foreground">
        <Link to="/graphics">
          <ChevronLeft aria-hidden="true" />
          {HEADER_TEXT.back}
        </Link>
      </Button>
      <span aria-hidden="true" className="text-muted-foreground/60">
        /
      </span>
      {renaming ? (
        <Input
          ref={field}
          dir="auto"
          aria-label={HEADER_TEXT.nameLabel}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // keyCode 229 confirms an IME composition in browsers that report it as over already.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              finish(true);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
          className="h-8 w-80 px-2.5 text-sm font-semibold [unicode-bidi:plaintext]"
        />
      ) : (
        <h1 className="m-0 min-w-0 text-sm font-semibold">
          {graphic === undefined ? (
            <span dir="auto" className="block h-8 px-2 leading-8 [unicode-bidi:plaintext]">
              {name}
            </span>
          ) : (
            <Tip tip={blockedReason ?? HEADER_TEXT.renameTip} disabled={!canRename}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                dir="auto"
                disabled={!canRename}
                onClick={startRename}
                className="max-w-[420px] justify-start px-2 font-semibold [unicode-bidi:plaintext] disabled:opacity-100"
              >
                <span className="truncate">{name}</span>
              </Button>
            </Tip>
          )}
        </h1>
      )}
      <span
        data-tone={status.tone}
        className={cn('text-[13px] whitespace-nowrap', TONE_CLASS[status.tone])}
      >
        {status.text}
      </span>
      <span className="flex-1" />
      <Tip
        tip={hasVersion ? HEADER_TEXT.showInFinder : HEADER_TEXT.noFolderYet}
        disabled={!hasVersion || offline}
        side="bottom"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={HEADER_TEXT.showInFinder}
          disabled={!hasVersion || offline}
          onClick={onReveal}
        >
          <Folder aria-hidden="true" />
        </Button>
      </Tip>
      <DropdownMenu>
        <Tip tip={HEADER_TEXT.more} side="bottom" disabled={graphic === undefined || offline}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={HEADER_TEXT.more}
              disabled={graphic === undefined || offline}
              className="data-[state=open]:bg-accent"
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="end"
          aria-label={HEADER_TEXT.menuLabel}
          className="w-52"
          onCloseAutoFocus={(event) => {
            if (!fromMenu.current) return;
            fromMenu.current = false;
            event.preventDefault();
            field.current?.focus();
            field.current?.select();
          }}
        >
          <DropdownMenuItem
            disabled={!canRename}
            onSelect={() => {
              fromMenu.current = true;
              startRename();
            }}
          >
            {HEADER_TEXT.rename}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasVersion} onSelect={onDuplicate}>
            {HEADER_TEXT.duplicate}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleUses}>
            {graphic?.uses === false ? HEADER_TEXT.turnOn : HEADER_TEXT.turnOff}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasVersion} onSelect={onReveal}>
            {HEADER_TEXT.showInFinder}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            {HEADER_TEXT.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
