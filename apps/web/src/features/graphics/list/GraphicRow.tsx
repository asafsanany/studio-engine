import type { GraphicKind, GraphicSummary } from '@studio/shared';
import { Flag, Hash, LoaderCircle, PanelBottom, Shapes, Type } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { IconAction } from '@/components/jobs/IconAction';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { StatusGlyph } from '@/features/jobs/JobStatusIcon';
import { isContextMenuKey, openMenuFromKeyboard } from '@/features/jobs/row-menu-key';
import { bidiProps } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import type { GraphicActions } from './graphic-actions';
import { renameOutcome } from './graphic-actions';
import {
  type DetailTone,
  GRAPHICS_TEXT,
  type GraphicMenuId,
  graphicDetailText,
  graphicMenuEntries,
  kindLabel,
  kindOf,
  retryLabel,
} from './graphic-list';

/**
 * A row of the list: 44 px high, on a grid of the kind icon (16 px), the name (the rest of the
 * width), the detail (as wide as its text), the time (96 px) and the next-step button (32 px), 12 px
 * apart, with 12 px of room on the left and 6 px on the right (board GRLibrary). The skeleton rows
 * share it, so a placeholder sits where the content will.
 */
export const GRAPHIC_ROW_LAYOUT =
  'grid h-11 grid-cols-[16px_minmax(0,1fr)_auto_96px_32px] items-center gap-3 rounded-lg pr-1.5 pl-3';

const KIND_ICONS = {
  title: Type,
  'lower-third': PanelBottom,
  callout: Hash,
  'end-card': Flag,
  other: Shapes,
} as const satisfies Record<GraphicKind, typeof Type>;

const DETAIL_TONES: Record<DetailTone, string> = {
  quiet: 'text-muted-foreground',
  making: 'text-blue-300',
  failed: 'text-red-300',
  off: 'text-zinc-500',
};

/**
 * The icon in front of the name: a blue spinner while a version is being made, the red failed mark
 * when the newest run failed, otherwise the kind (Title, Lower third, Callout, End card, or the
 * plain shapes for any other). Each is an image with a name.
 */
export function GraphicMark({ graphic }: { graphic: GraphicSummary }) {
  if (graphic.status === 'making') {
    return (
      <LoaderCircle
        role="img"
        aria-label={GRAPHICS_TEXT.being}
        strokeWidth={2.5}
        className="size-4 animate-spin text-status-editing motion-reduce:animate-none"
      />
    );
  }
  if (graphic.status === 'failed') {
    return <StatusGlyph kind="failed" role="img" aria-label={GRAPHICS_TEXT.failedMark} />;
  }
  const Icon = KIND_ICONS[kindOf(graphic)];
  return (
    <Icon role="img" aria-label={kindLabel(graphic)} className="size-4 text-muted-foreground" />
  );
}

/** The name as an input, for Rename: Enter saves, Escape and leaving the field with nothing new put the old name back. */
function RenameField({
  graphic,
  actions,
  onDone,
}: {
  graphic: GraphicSummary;
  actions: GraphicActions;
  /** The field has ended; `viaKeyboard` is whether Enter or Escape ended it (focus goes back to the name). */
  onDone: (viaKeyboard: boolean) => void;
}) {
  const [value, setValue] = useState(graphic.name);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Enter and then the blur it causes must not save twice.
  const settled = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function commit(viaKeyboard: boolean) {
    if (settled.current) return;
    settled.current = true;
    const outcome = renameOutcome(graphic.name, value);
    if (outcome.kind === 'cancel') {
      onDone(viaKeyboard);
      return;
    }
    setSaving(true);
    if (await actions.rename(graphic.id, outcome.name)) {
      onDone(viaKeyboard);
      return;
    }
    // The engine said no (and the page said why). Enter keeps the field so the name can be fixed;
    // leaving the field puts the old name back.
    if (!viaKeyboard) {
      onDone(false);
      return;
    }
    settled.current = false;
    setSaving(false);
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Hebrew and other IME input confirms a word with Enter; that must not save the name.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      settled.current = true;
      onDone(true);
    }
  }

  return (
    <Input
      ref={input}
      dir="auto"
      aria-label={`Name of ${graphic.name}`}
      autoComplete="off"
      spellCheck={false}
      value={value}
      readOnly={saving}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void commit(false)}
      className="h-8 font-medium"
    />
  );
}

export interface GraphicRowProps {
  graphic: GraphicSummary;
  actions: GraphicActions;
  /** Delete… was chosen: the list asks "Delete “Name”?". */
  onAskDelete: (graphic: GraphicSummary) => void;
  /** The row's Retry was pressed and has not finished: the button waits. */
  retrying?: boolean;
  onRetry: (graphic: GraphicSummary) => void;
}

/**
 * One graphic of the library. A quiet row with no lines: the mark, the name (a button, and a click
 * anywhere on the row is a click on it), the detail, when it last changed and, only when its newest
 * run failed, the ghost Retry button. Everything else is in the right-click menu (Open, Rename,
 * Duplicate, Show in Finder, Turn off / on for edits, Delete…), which Shift+F10 and the menu key
 * open too. The row takes a quiet background while the pointer is over it, while its menu is open
 * and while its name has keyboard focus.
 */
export function GraphicRow({
  graphic,
  actions,
  onAskDelete,
  retrying = false,
  onRetry,
}: GraphicRowProps) {
  const [renaming, setRenaming] = useState(false);
  const name = useRef<HTMLButtonElement>(null);
  // Rename is chosen while the menu is still open; the field comes once the menu has let go of the focus.
  const renameAsked = useRef(false);
  const detail = graphicDetailText(graphic);
  const retry = retryLabel(graphic);

  function choose(id: GraphicMenuId) {
    if (id === 'open') actions.open(graphic.id);
    else if (id === 'rename') renameAsked.current = true;
    else if (id === 'duplicate') void actions.duplicate(graphic.id);
    else if (id === 'reveal') void actions.reveal(graphic.id);
    else if (id === 'uses') void actions.setUses(graphic.id, !graphic.uses);
    else onAskDelete(graphic);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-graphic-id={graphic.id}
          data-status={graphic.status}
          data-uses={graphic.uses ? 'on' : 'off'}
          className={cn(
            GRAPHIC_ROW_LAYOUT,
            'relative transition-colors duration-150 ease-in-out hover:bg-muted/60 has-[[data-slot=graphic-name]:focus-visible]:bg-muted/60 data-[state=open]:bg-muted/60',
          )}
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            openMenuFromKeyboard(event.currentTarget, event.target as Element);
          }}
        >
          <span className="flex">
            <GraphicMark graphic={graphic} />
          </span>
          {renaming ? (
            <RenameField
              graphic={graphic}
              actions={actions}
              onDone={(viaKeyboard) => {
                setRenaming(false);
                if (viaKeyboard) requestAnimationFrame(() => name.current?.focus());
              }}
            />
          ) : (
            <button
              ref={name}
              type="button"
              dir="auto"
              data-slot="graphic-name"
              onClick={() => actions.open(graphic.id)}
              // The button's own box is the name; its ::after covers the whole row, so the row is the target.
              className={cn(
                bidiProps.className,
                "font-medium outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']",
              )}
            >
              {graphic.name}
            </button>
          )}
          <span className={cn('text-[13px] whitespace-nowrap', DETAIL_TONES[detail.tone])}>
            {detail.text}
          </span>
          <div className="text-right text-[13px] whitespace-nowrap">
            <RelativeTime iso={graphic.updatedAt} />
          </div>
          {/* Above the name's overlay, so the button gets its own clicks. */}
          <div className="relative z-10 flex justify-end">
            {retry !== null && (
              <IconAction
                action="retry"
                label={retry}
                disabled={retrying}
                onClick={() => onRetry(graphic)}
              />
            )}
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-55"
        aria-label={`Actions for ${graphic.name}`}
        onCloseAutoFocus={(event) => {
          if (!renameAsked.current) return;
          renameAsked.current = false;
          event.preventDefault();
          setRenaming(true);
        }}
      >
        {graphicMenuEntries(graphic).map((entry) =>
          entry.type === 'separator' ? (
            <ContextMenuSeparator key={entry.id} />
          ) : (
            <ContextMenuItem
              key={entry.id}
              variant={entry.destructive ? 'destructive' : 'default'}
              disabled={entry.disabled}
              onSelect={() => choose(entry.id)}
              // A disabled item that says why takes the pointer (a disabled one takes none), with the default cursor.
              title={entry.disabled ? entry.disabledReason : undefined}
              className={
                entry.disabled && entry.disabledReason !== undefined
                  ? 'data-[disabled]:cursor-default data-[disabled]:pointer-events-auto'
                  : undefined
              }
            >
              {entry.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
