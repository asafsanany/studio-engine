import type { FontPickerCatalog, PickerEntry } from './font-picker';
import { entryLabel, noteSavedLines, readNote } from './note-uses';
import { type PickerItem, type PlacedAt, sentNoteLines, sentNoteParts } from './picker-items';

/**
 * The inline chip of a token in a sent note: a blue-tinted pill with the slug, 13 px. With fonts in
 * the notes (`label` given) it says what the chip says, `@Heebo Bold`.
 */
export function TokenPill({ item, label }: { item: PickerEntry; label?: string }) {
  return (
    <span
      data-slot="library-token"
      data-token={item.token}
      // The slug is always left to right, even inside a Hebrew note.
      dir="ltr"
      className="mx-px inline-block rounded-md bg-[#3B82F6]/15 px-1.5 text-[13px] leading-5 text-[#93C5FD] [unicode-bidi:isolate]"
    >
      {label ?? item.token}
    </span>
  );
}

interface NoteTokenTextProps {
  text: string;
  /** The LUTs and graphics a note can name. */
  items: readonly PickerItem[];
  /**
   * The font library, when notes can name a font (`fontsInNotes`): a font token is a pill too, a
   * token after a hyphen counts, and the three kinds are written with their `@`. Left out, the
   * text is read as LU8 reads it.
   */
  fonts?: FontPickerCatalog;
}

/**
 * A sent note's text with every token that points at a library item shown as a chip. A note with
 * no such token is its text, as it always was.
 */
export function NoteTokenText({ text, items, fonts }: NoteTokenTextProps) {
  if (fonts !== undefined) {
    const parts = readNote(text, { fonts, items }).parts;
    if (parts.every((part) => !('entry' in part))) return text;
    return parts.map((part, index) =>
      'entry' in part ? (
        // The parts are cut from a fixed text, so their order is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <TokenPill key={index} item={part.entry} label={entryLabel(part.entry)} />
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <span key={index}>{part.text}</span>
      ),
    );
  }
  const parts = sentNoteParts(text, items);
  if (parts.every((part) => !('item' in part))) return text;
  return parts.map((part, index) =>
    'item' in part ? (
      // The parts are cut from a fixed text, so their order is their identity.
      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
      <TokenPill key={index} item={part.item} />
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
      <span key={index}>{part.text}</span>
    ),
  );
}

/** The dim lines under a sent note that names library items (none for a note that names nothing). */
export function SentNoteLines({
  text,
  items,
  timeLabel,
  fonts,
}: {
  text: string;
  items: readonly PickerItem[];
  timeLabel: PlacedAt;
  /** The font library, when notes can name a font: a font gets its line, with the text it is for. */
  fonts?: FontPickerCatalog;
}) {
  const lines =
    fonts === undefined
      ? sentNoteLines(text, items, timeLabel)
      : noteSavedLines(readNote(text, { fonts, items }), timeLabel);
  if (lines.length === 0) return null;
  return (
    <div data-slot="library-note-lines" className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <p key={line} className="pr-1 text-xs text-pretty text-zinc-500">
          {line}
        </p>
      ))}
    </div>
  );
}
