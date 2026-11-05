import { openPickerQuery, removeToken, replacePickerQuery } from '@studio/shared';
import { useRouter } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  insertEntry,
  type NotePickerView,
  notePickerView,
  openNoteQuery,
  type PickerEntry,
  pointAtText,
} from './font-picker';
import { LibraryPickerList, LibraryPickerNone, pickerOptionId } from './LibraryPickerPopover';
import { LibraryUses } from './LibraryUses';
import { type LibraryFrame, testLibraryFrame } from './library-frame';
import { noteUseKey, readNote, removeNoteUse } from './note-uses';
import {
  clampHighlight,
  moveHighlight,
  namedItems,
  type PlacedAt,
  pickerView,
} from './picker-items';
import { pickerKeyAction } from './picker-keys';
import { useFontPickerCatalog } from './use-font-picker-catalog';
import { useLibraryItems } from './use-library-items';

interface UseLibraryPickerOptions {
  /** The note's text, as the box shows it. */
  text: string;
  /** Changes the note's text: typing, picking an item, removing a chip. */
  onTextChange: (text: string) => void;
  /** The box, to put the focus back in it after a pick or a remove. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** "0:12": where the note is pinned ("Placed at …", "A graphic is placed at …"). */
  timeLabel: PlacedAt;
  /** The picture LUTs are shown on. Default: the test frame of the LUTs page; LU11 passes the paused frame. */
  frame?: LibraryFrame;
}

/** What a box gives its textarea when the picker is on: spread `aria` on it and call the handlers. */
export interface LibraryPicker {
  /**
   * Notes can name library items (the `lutsInEdits` switch) or fonts (`fontsInNotes`). Both off:
   * everything below is inert.
   */
  enabled: boolean;
  /** What `@` points at, for the box's placeholder: "a LUT or a graphic", "a font, a LUT or a graphic". */
  pointAt: string;
  /** The popover is showing (a list, or the "no match" panel). */
  open: boolean;
  /** Attributes of the textarea; empty while the switch is off. */
  aria: Record<string, string | undefined>;
  /** Typing: the new text. */
  onChange: (text: string) => void;
  /** A key in the textarea. `true` when the picker took it (`preventDefault` is done). */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onFocus: () => void;
  onBlur: () => void;
  /** Put inside the `relative` wrapper that holds the textarea. `null` while closed. */
  popover: ReactNode;
  /** The "Uses" row, for under the textarea. `null` when the text names nothing. */
  uses: ReactNode;
  /** Screen readers only: what the popover shows, said once per change. */
  status: string;
}

/**
 * The @ picker for one note box (LUTs plan, "The @ picker"; board LUReview), shared by the Review
 * notes box and, later, the Brief notes box. The box keeps its own state (the text) and calls the
 * handlers; the picker keeps the rest: which row is highlighted and whether Esc or leaving the box
 * closed it. It opens when the text ends in `@` and an optional query (LU7's `openPickerQuery`),
 * closes on Esc, on blur and when the text moves on, and opens again on focus. Picking replaces the
 * query with `@luts/slug `; the note stays plain text.
 *
 * With `lutsInEdits` and `fontsInNotes` off the picker is inert and nothing is asked: `enabled` is
 * false, the handlers do nothing, and `popover`, `uses` and `aria` are empty. With `fontsInNotes`
 * on it also offers the fonts of the library (font-picker.ts, board FOReview): the query may hold
 * spaces and capitals, a font is picked as `@Heebo Bold `, and with it off the picker is LU8's,
 * byte for byte.
 */
export function useLibraryPicker({
  text,
  onTextChange,
  textareaRef,
  timeLabel,
  frame,
}: UseLibraryPickerOptions): LibraryPicker {
  const library = useLibraryItems();
  const fonts = useFontPickerCatalog();
  const { items } = library;
  const enabled = library.enabled || fonts.enabled;
  const listId = useId();
  // Outside a router (a bare render in a test) there is nowhere to go.
  const router = useRouter({ warn: false });
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  /** The highlight came from a key, so the row is scrolled into view (a pointer move needs no scroll). */
  const byKeyboard = useRef(false);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(focusTimer.current), []);

  const asking = enabled && !dismissed && !library.loading && !fonts.loading;
  const fontsOn = fonts.enabled;
  const fontCatalog = fonts.catalog;
  const libraryOn = library.enabled;
  // One view per text, so the rows' faces (`LibraryPickerList`) are asked for once, not on every render.
  const view = useMemo((): NotePickerView | null => {
    if (!asking) return null;
    if (fontsOn) {
      // Fonts are in the notes: the box is read for a font's name too (spaces, capitals, `ל-@he`).
      const noteQuery = openNoteQuery(text, libraryOn);
      return noteQuery === null
        ? null
        : notePickerView({ fonts: fontCatalog, items, library: libraryOn }, noteQuery);
    }
    const query = openPickerQuery(text);
    return query === null ? null : pickerView(items, query);
  }, [asking, fontsOn, fontCatalog, libraryOn, items, text]);
  const count = view?.flat.length ?? 0;
  const active = clampHighlight(highlight, count);
  const open = view !== null;
  const resolvedFrame = useMemo(() => frame ?? testLibraryFrame(items), [frame, items]);

  // Keyboard moves bring the row into view; the box's own scroll does not follow the pointer.
  useEffect(() => {
    if (!open || !byKeyboard.current) return;
    document.getElementById(pickerOptionId(listId, active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  // What the text names, once each. With fonts in the notes the text is read for fonts too (and
  // after a hyphen: `ל-@luts/x`); with them off it is LU8's `namedItems`, as it was.
  const used = useMemo((): PickerEntry[] => {
    if (fontsOn) return readNote(text, { fonts: fontCatalog, items }).uses.map((use) => use.entry);
    return libraryOn ? namedItems(text, items) : [];
  }, [fontsOn, fontCatalog, libraryOn, text, items]);

  /** The box gets the focus back with the caret at the end, once the new text is in. */
  function focusAtEnd() {
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      const box = textareaRef.current;
      if (box === null) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 0);
  }

  function pick(entry: PickerEntry) {
    let next: string;
    if (fonts.enabled) {
      const current = openNoteQuery(text, library.enabled);
      if (current === null) return;
      next = insertEntry(text, current, entry);
    } else {
      const current = openPickerQuery(text);
      if (current === null || entry.type === 'font') return;
      next = replacePickerQuery(text, current, { library: entry.library, slug: entry.slug });
    }
    byKeyboard.current = false;
    setHighlight(0);
    setDismissed(false);
    onTextChange(next);
    focusAtEnd();
  }

  function removeChip(entry: PickerEntry) {
    if (fontsOn) {
      onTextChange(removeNoteUse(text, { fonts: fontCatalog, items }, noteUseKey(entry)));
    } else if (entry.type !== 'font') {
      onTextChange(removeToken(text, { library: entry.library, slug: entry.slug }));
    }
    focusAtEnd();
  }

  function openPage(to: '/luts' | '/graphics' | '/fonts') {
    // The note stays in the draft (it lives in the review store, not in the page), so there is
    // nothing to ask: leave in the same tab.
    router?.history.push(to);
  }

  const status =
    view === null
      ? ''
      : view.flat.length === 0
        ? (view.none?.message ?? '')
        : `${view.flat.length === 1 ? '1 result' : `${view.flat.length} results`}. ${view.flat[active]?.name ?? ''} selected.`;

  let popover: ReactNode = null;
  if (view !== null) {
    popover =
      view.flat.length > 0 ? (
        <LibraryPickerList
          view={view}
          highlight={active}
          listId={listId}
          timeLabel={timeLabel}
          frame={resolvedFrame}
          fonts={fonts.enabled ? fonts.catalog : undefined}
          onHover={(index) => {
            byKeyboard.current = false;
            setHighlight(index);
          }}
          onPick={pick}
        />
      ) : view.none === null ? null : (
        <LibraryPickerNone none={view.none} onOpenPage={openPage} withFonts={fontsOn} />
      );
  }

  const uses = (
    <LibraryUses
      items={used}
      frame={resolvedFrame}
      timeLabel={timeLabel}
      onRemove={removeChip}
      fonts={fontsOn ? fontCatalog : undefined}
    />
  );

  const pointAt = pointAtText(fonts.enabled, library.enabled);

  if (!enabled) {
    return {
      enabled: false,
      pointAt,
      open: false,
      aria: {},
      onChange: onTextChange,
      onKeyDown: () => false,
      onFocus: () => {},
      onBlur: () => {},
      popover: null,
      uses: null,
      status: '',
    };
  }

  return {
    enabled: true,
    pointAt,
    open,
    aria: {
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      'aria-controls': listId,
      'aria-activedescendant': open && count > 0 ? pickerOptionId(listId, active) : undefined,
      // The review dialog's Esc reads this: while the picker is open, Esc closes the picker only.
      'data-picker': open ? 'open' : undefined,
    },
    onChange(next) {
      byKeyboard.current = false;
      setHighlight(0);
      setDismissed(false);
      onTextChange(next);
    },
    onKeyDown(event) {
      if (!open) return false;
      const action = pickerKeyAction(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          // keyCode 229 is the key press that confirms an IME composition in browsers that
          // report the composition as over by the time keydown arrives.
          isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
        },
        count,
      );
      if (action === null) return false;
      event.preventDefault();
      if (action === 'close') {
        setDismissed(true);
      } else if (action === 'insert') {
        const item = view?.flat[active];
        if (item !== undefined) pick(item);
      } else {
        byKeyboard.current = true;
        setHighlight(moveHighlight(active, count, action === 'next' ? 1 : -1));
      }
      return true;
    },
    onFocus() {
      setDismissed(false);
    },
    onBlur() {
      setDismissed(true);
    },
    popover,
    uses: used.length > 0 ? uses : null,
    status,
  };
}
