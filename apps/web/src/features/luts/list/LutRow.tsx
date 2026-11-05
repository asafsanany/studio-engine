import { absoluteTime, type LutKind, type LutSummary, relativeTime } from '@studio/shared';
import { Camera, Contrast, Wrench } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { isContextMenuKey, openMenuFromKeyboard } from '@/features/jobs/row-menu-key';
import { bidiProps } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { type LutActions, renameOutcome } from './lut-actions';
import {
  kindLabel,
  LUT_LIST_TEXT,
  type LutMenuId,
  lutDetailText,
  lutMenuEntries,
  showsNewTag,
} from './lut-list';

/**
 * A row of the list: 44 px high, on a grid of the kind icon (16 px), the name (the rest of the
 * width, with the "New" tag after it), the kind and grid (100 px), the used label (150 px) and
 * when it was added (84 px, right-aligned), 12 px apart with 12 px of room on each side (board
 * LUPage). The skeleton rows share it, so a placeholder sits where the content will.
 */
export const LUT_ROW_LAYOUT =
  'grid h-11 grid-cols-[16px_minmax(0,1fr)_100px_150px_84px] items-center gap-3 rounded-lg px-3';

const KIND_ICONS = {
  look: Contrast,
  camera: Camera,
  fix: Wrench,
} as const satisfies Record<LutKind, typeof Camera>;

/** The name as an input, for Rename: Enter saves, Escape and leaving the field with nothing new put the old name back. */
function RenameField({
  lut,
  actions,
  onRenamed,
  onDone,
}: {
  lut: LutSummary;
  actions: LutActions;
  /** The engine took the name: the LUT's slug is now `slug`. */
  onRenamed: (from: string, to: string) => void;
  /** The field has ended; `viaKeyboard` is whether Enter or Escape ended it (focus goes back to the name). */
  onDone: (viaKeyboard: boolean) => void;
}) {
  const [value, setValue] = useState(lut.name);
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
    const outcome = renameOutcome(lut.name, value);
    if (outcome.kind === 'cancel') {
      onDone(viaKeyboard);
      return;
    }
    setSaving(true);
    const slug = await actions.rename(lut.slug, outcome.name);
    if (slug !== null) {
      onRenamed(lut.slug, slug);
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
      aria-label={`Name of ${lut.name}`}
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

export interface LutRowProps {
  lut: LutSummary;
  /** The LUT whose pane is open: the row takes the quiet background. */
  selected: boolean;
  /** The time, as epoch milliseconds: it decides the "New" tag and the "added" text. */
  now: number;
  /** Whether notes can name a LUT yet: Copy @luts/name is hidden while they cannot. */
  lutsInEdits: boolean;
  actions: LutActions;
  /** The row was picked (a click on it, or its menu opening). */
  onSelect: (slug: string) => void;
  /** Delete… was chosen: the list asks "Delete “Name”?". */
  onAskDelete: (lut: LutSummary) => void;
  /** A rename was taken by the engine: the LUT's slug moved. */
  onRenamed: (from: string, to: string) => void;
}

/**
 * One LUT of the list. A quiet row with no lines and no preview: the kind icon, the name (a
 * button, and a click anywhere on the row is a click on it) with a "New" tag for 30 minutes after
 * an import, "Look · 33³", how much it was used and when it was added. Everything else is in the
 * right-click menu, which Shift+F10 and the menu key open too. The row takes the quiet background
 * while the pointer is over it, while its menu is open, while its name has keyboard focus and
 * while it is the open one.
 */
export function LutRow({
  lut,
  selected,
  now,
  lutsInEdits,
  actions,
  onSelect,
  onAskDelete,
  onRenamed,
}: LutRowProps) {
  const [renaming, setRenaming] = useState(false);
  const name = useRef<HTMLButtonElement>(null);
  // Rename is chosen while the menu is still open; the field comes once the menu has let go of the focus.
  const renameAsked = useRef(false);
  const Icon = KIND_ICONS[lut.kind];
  const added = lut.addedAt === null ? LUT_LIST_TEXT.builtInAdded : relativeTime(lut.addedAt, now);

  function choose(id: LutMenuId) {
    if (id === 'rename') renameAsked.current = true;
    else if (id === 'reveal') void actions.reveal(lut.slug);
    else if (id === 'duplicate') void actions.duplicate(lut.slug);
    else if (id === 'copy') void actions.copyToken(lut.slug);
    else onAskDelete(lut);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-lut-slug={lut.slug}
          data-owner={lut.owner}
          data-selected={selected ? 'true' : 'false'}
          className={cn(
            LUT_ROW_LAYOUT,
            'relative transition-colors duration-150 ease-in-out hover:bg-muted/60 has-[[data-slot=lut-name]:focus-visible]:bg-muted/60 data-[selected=true]:bg-muted/60 data-[state=open]:bg-muted/60',
          )}
          onContextMenu={() => onSelect(lut.slug)}
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            openMenuFromKeyboard(event.currentTarget, event.target as Element);
          }}
        >
          <span className="flex">
            <Icon
              role="img"
              aria-label={kindLabel(lut.kind)}
              className="size-4 text-muted-foreground"
            />
          </span>
          <span className="flex min-w-0 items-center gap-2">
            {renaming ? (
              <RenameField
                lut={lut}
                actions={actions}
                onRenamed={onRenamed}
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
                data-slot="lut-name"
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(lut.slug)}
                // The button's own box is the name; its ::after covers the whole row, so the row is the target.
                className={cn(
                  bidiProps.className,
                  "min-w-0 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']",
                )}
              >
                {lut.name}
              </button>
            )}
            {!renaming && showsNewTag(lut, now) && (
              <span
                data-slot="lut-new"
                className="relative inline-flex h-[18px] flex-none items-center rounded-full bg-blue-500/15 px-1.5 text-[11px] font-medium text-blue-300"
              >
                {LUT_LIST_TEXT.newTag}
              </span>
            )}
          </span>
          <span className="text-[13px] whitespace-nowrap text-muted-foreground">
            {lutDetailText(lut)}
          </span>
          <span className="truncate text-[13px] whitespace-nowrap text-muted-foreground">
            {lut.usedLabel}
          </span>
          <span
            className="text-right text-[13px] whitespace-nowrap text-muted-foreground"
            title={lut.addedAt === null ? undefined : absoluteTime(lut.addedAt)}
          >
            {added}
          </span>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-55"
        aria-label={`Actions for ${lut.name}`}
        onCloseAutoFocus={(event) => {
          if (!renameAsked.current) return;
          renameAsked.current = false;
          event.preventDefault();
          setRenaming(true);
        }}
      >
        {lutMenuEntries(lut, { lutsInEdits }).map((entry) =>
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
                  ? 'data-[disabled]:pointer-events-auto data-[disabled]:cursor-default'
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
