import { NOTE_ATTACHMENTS, NOTE_MAX_LENGTH, type NoteAttachment } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, deferred } from '@/data/test-utils';
import type { NoteDialogProps } from '@/features/jobs/cells/NoteDialog';
import { renderCell, textOf } from '../jobs/cells/test-helpers';
import { createNoteAttachments, type NoteAttachmentsDeps } from '../jobs/note-attachments';
import { createNoteDialogStore, isNoteDialogOpen } from '../jobs/note-dialog';
import { CANVAS_JOBS } from '../jobs/test-jobs';

// The phone's "Note for the editor" (Songs, SG6; design canvas board SGPhone, left phone "The note
// sheet"), server-rendered: the sheet's markup in each state, what its buttons and the sheet's
// own events call, and the whole of it through NoteDialogHost with the real pictures controller
// (add, remove, Save waiting for an upload, closing without saving). Choosing a file in the
// browser's own picker is outside what a server render can do; the file input's markup is checked
// and the flow was run in a browser (see the item's hand-off).

// What the sheet's pieces were given during the last render: the tests press them by name.
const pressed = new Map<string, () => void>();
let sheetEvents: {
  onOpenChange?: (open: boolean) => void;
  onPaste?: (event: unknown) => void;
  onOpenAutoFocus?: (event: { preventDefault(): void }) => void;
  onCloseAutoFocus?: (event: { preventDefault(): void }) => void;
} = {};
let grabberClose: (() => void) | null = null;

// Radix renders a sheet in a portal, which does not exist on a server: plain elements that keep the
// props this test cares about.
vi.mock('@/components/ui/sheet', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, onOpenChange, children }: Props) => {
      sheetEvents = { ...sheetEvents, onOpenChange: onOpenChange as (open: boolean) => void };
      return open ? h('div', { 'data-open': '' }, children) : null;
    },
    SheetContent: ({
      children,
      side,
      showCloseButton,
      className,
      onPaste,
      onOpenAutoFocus,
      onCloseAutoFocus,
      ...rest
    }: Props) => {
      sheetEvents = {
        ...sheetEvents,
        onPaste: onPaste as typeof sheetEvents.onPaste,
        onOpenAutoFocus: onOpenAutoFocus as typeof sheetEvents.onOpenAutoFocus,
        onCloseAutoFocus: onCloseAutoFocus as typeof sheetEvents.onCloseAutoFocus,
      };
      return h(
        'div',
        {
          role: 'dialog',
          'data-slot': rest['data-slot'],
          'data-side': String(side),
          'data-close-button': String(showCloseButton),
          'aria-describedby': rest['aria-describedby'] as string | undefined,
          className,
        },
        children,
      );
    },
    SheetTitle: ({ children, className }: Props) => h('h2', { className }, children),
    SheetDescription: ({ children }: Props) => h('p', null, children),
  };
});

vi.mock('@/components/ui/sheet-grabber', async () => {
  const { createElement: h } = await import('react');
  return {
    SheetGrabber: ({ onClose }: { onClose: () => void }) => {
      grabberClose = onClose;
      return h('div', { 'data-slot': 'sheet-grabber' });
    },
  };
});

// The Mac's dialog, for the switch-off case.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children }: Props) =>
      h('div', { role: 'dialog', 'data-slot': 'dialog' }, children),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

// A button keeps what it was given, and says what it was pressed with: its label, or its words.
vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  const wordsOf = (node: React.ReactNode): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(wordsOf).join('');
    return '';
  };
  return {
    Button: ({ children, onClick, variant, className, disabled, ...rest }: Props) => {
      const label = String(rest['aria-label'] ?? wordsOf(children));
      if (typeof onClick === 'function' && disabled !== true)
        pressed.set(label, onClick as () => void);
      return h(
        'button',
        { type: rest.type as string, 'data-variant': variant, className, disabled, ...rest },
        children,
      );
    },
  };
});

// What the host asks of the engine through the data layer: the note's Save, and the Hold / Release.
const saved: [string, string][] = [];
let saveHeld: Promise<void> | null = null;
vi.mock('@/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data')>();
  return {
    ...actual,
    useSaveNote: () => ({
      mutateAsync: async ({ id, note }: { id: string; note: string }) => {
        await saveHeld;
        saved.push([id, note]);
      },
    }),
    useJobAction: () => ({ mutateAsync: async () => undefined }),
  };
});

const { PhoneNoteSheet, PhoneNoteDialogHost, PHONE_NOTE_TEXT } = await import('./PhoneNoteSheet');
const { NoteDialogHost } = await import('../jobs/cells/NoteDialogHost');

beforeEach(() => {
  pressed.clear();
  sheetEvents = {};
  grabberClose = null;
  saved.length = 0;
  saveHeld = null;
});

type Pictures = NonNullable<NoteDialogProps['pictures']>;
type Row = Pictures['rows'][number];

const picture = (over: Partial<Row> = {}): Row => ({
  key: 'new-1',
  name: 'IMG_4412.PNG',
  bytes: 1_200_000,
  from: 'chosen',
  status: 'ready',
  error: null,
  previewUrl: 'blob:http://localhost/abc',
  ...over,
});

const pictures = (rows: Row[] = [], over: Partial<Pictures> = {}): Pictures => ({
  rows,
  dragging: false,
  onFiles: () => {},
  onRemove: () => {},
  ...over,
});

const sheet = (props: Partial<NoteDialogProps> = {}) =>
  renderCell(
    <PhoneNoteSheet
      open
      jobName="Demo 2"
      client="Falcon FPV"
      text="Yael wants this song. Start it where the reel does."
      onTextChange={() => {}}
      held={false}
      saving={false}
      error={null}
      onSave={() => {}}
      onOpenChange={() => {}}
      pictures={pictures()}
      {...props}
    />,
  );

/** The opening tag of the first element named `<name`, or whose opening tag contains `needle`. */
const tag = (markup: string, needle: string) =>
  markup.match(
    needle.startsWith('<') ? new RegExp(`${needle}\\b[^>]*>`) : new RegExp(`<[^>]*${needle}[^>]*>`),
  )?.[0] ?? '';

/** Whether an opening tag has the `disabled` attribute (class names such as `disabled:opacity-50` do not count). */
const isDisabled = (opening: string) => / disabled=""/.test(opening);

describe('<PhoneNoteSheet>: the shell', () => {
  const markup = sheet();

  it('is a bottom sheet with no close button of its own, and the phone sheets’ shell', () => {
    expect(markup).toContain('data-slot="phone-note-sheet"');
    expect(markup).toContain('data-side="bottom"');
    expect(markup).toContain('data-close-button="false"');
    expect(markup).toContain('data-slot="sheet-grabber"');
    expect(markup).toContain('rounded-t-2xl');
    expect(markup).toContain('pb-[max(34px,var(--safe-bottom))]');
  });

  it('has the title, and the job’s name and client under it, each in its own direction', () => {
    expect(textOf(markup)).toContain('Note for the editor Demo 2 · Falcon FPV');
    expect(markup).toMatch(/<span dir="auto" class="[^"]*\bbidi\b[^"]*">Demo 2<\/span>/);
    expect(markup).toMatch(/<span dir="auto" class="[^"]*\bbidi\b[^"]*">Falcon FPV<\/span>/);
    const hebrew = sheet({ jobName: 'מיתוס או אמת 5', client: 'עו״ד דוד לוי' });
    expect(hebrew).toMatch(/dir="auto"[^>]*>מיתוס או אמת 5</);
  });

  it('has a text box of 96 px at 16 px, in the text’s own direction, with the note in it', () => {
    const box = tag(markup, '<textarea');
    expect(box).toContain('id="phone-note-text"');
    expect(box).toContain('dir="auto"');
    expect(box).toContain(`maxLength="${NOTE_MAX_LENGTH}"`);
    expect(box).toContain('h-24');
    expect(box).toContain('text-base');
    // At md the stock box drops to 14 px; the sheet's stays 16 so iOS does not zoom in.
    expect(box).toContain('md:text-base');
    expect(box).toContain('resize-none');
    expect(markup).toContain('Yael wants this song. Start it where the reel does.</textarea>');
    expect(markup).toMatch(/<label[^>]*for="phone-note-text"[^>]*sr-only[^>]*>Note<\/label>/);
  });

  it('has no Cancel and no close ×: the grabber, a tap on the page and Esc close it', () => {
    expect(textOf(markup)).not.toContain('Cancel');
    expect(markup).not.toContain('Close');
  });

  it('has Save, full width and 48 px, as the last thing in the sheet', () => {
    const save = markup.slice(markup.lastIndexOf('<button'));
    expect(save).toContain('>Save<');
    expect(save).toContain('h-12');
    expect(save).toContain('w-full');
    // The primary button: no outline variant.
    expect(save).not.toContain('data-variant');
  });

  it('shows nothing while it is closed', () => {
    expect(sheet({ open: false })).toBe('');
  });

  it('does not put the focus in the text box when it opens (the keyboard would cover Save)', () => {
    sheet();
    const prevented = vi.fn();
    sheetEvents.onOpenAutoFocus?.({ preventDefault: prevented });
    sheetEvents.onCloseAutoFocus?.({ preventDefault: prevented });
    expect(prevented).toHaveBeenCalledTimes(2);
  });
});

describe('<PhoneNoteSheet>: Add photo (board state: nothing attached)', () => {
  const markup = sheet();
  const button = tag(markup, 'data-variant="outline"');

  it('has an outline, full-width, 44 px “Add photo” with a picture icon', () => {
    expect(PHONE_NOTE_TEXT.addPhoto).toBe('Add photo');
    expect(markup).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>(<svg[^>]*>.*?<\/svg>)?Add photo<\/button>/,
    );
    expect(button).toContain('h-11');
    expect(button).toContain('w-full');
    expect(button).toContain('type="button"');
  });

  it('sits under the box and above Save', () => {
    expect(markup.indexOf('<textarea')).toBeLessThan(markup.indexOf('Add photo'));
    expect(markup.indexOf('Add photo')).toBeLessThan(markup.indexOf('>Save<'));
  });

  it('opens a file input for pictures, several at a time, with no capture (Photo Library and Files)', () => {
    const input = tag(markup, 'type="file"');
    expect(input).toContain('accept="image/*"');
    expect(input).toContain('multiple');
    expect(input).toContain('hidden');
    expect(input).not.toContain('capture');
  });

  it('has no list of pictures yet', () => {
    expect(markup).not.toContain('Attached');
    expect(markup).not.toContain('The brief reads');
  });

  it('has none of this without pictures (the dialog without Songs): no Add photo, no input', () => {
    const without = sheet({ pictures: null });
    expect(without).not.toContain('Add photo');
    expect(without).not.toContain('type="file"');
    expect(without).toContain('>Save<');
  });
});

describe('<PhoneNoteSheet>: board state: a screenshot attached', () => {
  const markup = sheet({ pictures: pictures([picture()]) });

  it('shows the row: a 54 × 96 thumbnail, the name, and “The brief reads the song off it.”', () => {
    const text = textOf(markup);
    expect(text).toContain('IMG_4412.PNG The brief reads the song off it.');
    expect(markup).toContain('src="blob:http://localhost/abc"');
    expect(markup).toContain('w-[54px]');
    expect(markup).toContain('h-24');
    expect(markup).toContain('grid-cols-[54px_minmax(0,1fr)_44px]');
    // The Mac's row has its size and how it came, and the long sentence: not here.
    expect(text).not.toContain('Screenshot ·');
    expect(text).not.toContain('sped up');
  });

  it('has a 44 px × named for the picture, a button of its own', () => {
    const remove = tag(markup, 'aria-label="Remove IMG_4412.PNG"');
    expect(remove).toContain('size-11');
    expect(remove).toContain('type="button"');
    expect(remove).not.toContain('size-7');
  });

  it('lists the pictures under the box, above Add photo, in a list of their own that scrolls', () => {
    expect(markup.indexOf('<textarea')).toBeLessThan(markup.indexOf('<ul'));
    expect(markup.indexOf('<ul')).toBeLessThan(markup.indexOf('Add photo'));
    expect(tag(markup, '<ul')).toContain('aria-label="Attached"');
    expect(tag(markup, '<ul')).toContain('overflow-y-auto');
  });

  it('shows a Hebrew name in its own direction', () => {
    const hebrew = sheet({ pictures: pictures([picture({ name: 'צילום מסך 14.03.png' })]) });
    expect(hebrew).toMatch(
      /<span dir="auto" class="[^"]*\bbidi\b[^"]*">צילום מסך 14\.03\.png<\/span>/,
    );
    expect(hebrew).toContain('aria-label="Remove צילום מסך 14.03.png"');
  });

  it('shows a picture the browser cannot show as an image icon, not a broken image', () => {
    const none = sheet({ pictures: pictures([picture({ previewUrl: null })]) });
    expect(none).not.toContain('<img');
    expect(none).toContain('lucide-image');
  });
});

describe('<PhoneNoteSheet>: a picture on its way and one that failed', () => {
  it('shows a small spinner on the picture that is being sent', () => {
    const markup = sheet({ pictures: pictures([picture({ status: 'uploading' })]) });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('animate-spin');
    expect(markup).toContain('Attaching…');
  });

  it('says why a picture did not attach, in its row, in place of what the brief does, and can still be taken off', () => {
    const markup = sheet({
      pictures: pictures([
        picture({
          name: 'notes.pdf',
          status: 'failed',
          error: 'That isn’t a picture. Attach a PNG, JPG, HEIC, WEBP or GIF.',
          previewUrl: null,
        }),
      ]),
    });
    expect(markup).toContain('role="alert"');
    expect(textOf(markup)).toContain('That isn’t a picture. Attach a PNG, JPG, HEIC, WEBP or GIF.');
    expect(markup).not.toContain('The brief reads');
    expect(markup).toContain('aria-label="Remove notes.pdf"');
  });
});

describe('<PhoneNoteSheet>: how many', () => {
  const rows = (n: number, over: Partial<Row> = {}) =>
    Array.from({ length: n }, (_, i) => picture({ key: `k${i}`, name: `shot-${i}.png`, ...over }));

  it('lists several, and keeps Add photo until there are six', () => {
    const five = sheet({ pictures: pictures(rows(NOTE_ATTACHMENTS.maxFiles - 1)) });
    expect(five.match(/aria-label="Remove /g)).toHaveLength(5);
    expect(five).toContain('Add photo');
    const six = sheet({ pictures: pictures(rows(NOTE_ATTACHMENTS.maxFiles)) });
    expect(six.match(/aria-label="Remove /g)).toHaveLength(6);
    expect(six).not.toContain('Add photo');
    // The input stays: a picture taken off brings Add photo back.
    expect(six).toContain('type="file"');
  });

  it('does not count a picture that failed toward the six', () => {
    const markup = sheet({
      pictures: pictures([
        ...rows(5),
        picture({ key: 'bad', name: 'x.pdf', status: 'failed', error: 'No.', previewUrl: null }),
      ]),
    });
    expect(markup).toContain('Add photo');
  });
});

describe('<PhoneNoteSheet>: while it saves, and what it says', () => {
  it('turns Add photo, Save and every × off, and shows Save’s spinner', () => {
    const markup = sheet({ pictures: pictures([picture()]), saving: true });
    expect(isDisabled(tag(markup, 'data-variant="outline"'))).toBe(true);
    expect(isDisabled(tag(markup, 'aria-label="Remove IMG_4412.PNG"'))).toBe(true);
    const save = markup.slice(markup.lastIndexOf('<button'));
    expect(save).toContain('aria-busy="true"');
    expect(save).toMatch(/^<button[^>]*disabled/);
    expect(save).toContain('animate-spin');
  });

  it('says why the last Save failed, under the box, with the text still there', () => {
    const markup = sheet({ error: 'A picture didn’t attach. Take it off to save the note.' });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('id="phone-note-error"');
    expect(tag(markup, '<textarea')).toContain('aria-describedby="phone-note-error"');
    expect(markup.indexOf('<textarea')).toBeLessThan(markup.indexOf('A picture didn’t attach'));
    expect(markup).toContain('Yael wants this song');
  });

  it('says the job waits only while this sheet is the one holding it', () => {
    expect(textOf(sheet({ held: true }))).toContain(
      'This job waits while you write. Saving puts it back in line.',
    );
    expect(textOf(sheet({ held: false }))).not.toContain('This job waits');
  });
});

describe('<PhoneNoteSheet>: what it calls', () => {
  it('Save calls onSave', () => {
    const onSave = vi.fn();
    sheet({ onSave });
    pressed.get('Save')?.();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('a row’s × takes that row off, by its key', () => {
    const onRemove = vi.fn();
    sheet({
      pictures: pictures(
        [picture({ key: 'a', name: 'a.png' }), picture({ key: 'b', name: 'b.png' })],
        {
          onRemove,
        },
      ),
    });
    pressed.get('Remove b.png')?.();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('the grabber and a tap outside close it, and neither does while the note is on its way', () => {
    const onOpenChange = vi.fn();
    sheet({ onOpenChange });
    grabberClose?.();
    sheetEvents.onOpenChange?.(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    onOpenChange.mockClear();
    sheet({ onOpenChange, saving: true });
    grabberClose?.();
    sheetEvents.onOpenChange?.(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('a pasted picture is attached as pasted and the paste is cancelled; pasted text is left to the box', () => {
    const onFiles = vi.fn();
    sheet({ pictures: pictures([], { onFiles }) });
    const shot = new File([new Uint8Array(4)], 'image.png', { type: 'image/png' });
    const preventDefault = vi.fn();
    sheetEvents.onPaste?.({ clipboardData: { files: [shot], items: [] }, preventDefault });
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([shot], 'pasted');
    expect(preventDefault).toHaveBeenCalledOnce();

    onFiles.mockClear();
    preventDefault.mockClear();
    sheetEvents.onPaste?.({ clipboardData: { files: [], items: [] }, preventDefault });
    expect(onFiles).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('takes no paste while saving, and none without pictures', () => {
    sheet({ pictures: pictures(), saving: true });
    expect(sheetEvents.onPaste).toBeUndefined();
    sheet({ pictures: null });
    expect(sheetEvents.onPaste).toBeUndefined();
  });
});

// --- through the host, with the real pictures controller ----------------------------------------

const JOB = { id: 'j2', name: 'Demo 2', client: 'Falcon FPV' };

/** The engine, as far as the note's pictures go: what it holds, and uploads that land when told to. */
function fakeEngine(earlier: NoteAttachment[] = []) {
  const files = new Map<string, number>(earlier.map((a) => [a.name, a.bytes]));
  const landing: { name: string; land: () => void }[] = [];
  const deps: NoteAttachmentsDeps = {
    list: async () => earlier,
    upload: (_jobId, file, name) => {
      const gate = deferred<NoteAttachment>();
      landing.push({
        name,
        land: () => {
          files.set(name, file.size);
          gate.resolve({ name, bytes: file.size, addedAt: '2026-10-25T14:03:00.000Z' });
        },
      });
      return gate.promise;
    },
    remove: async (_jobId, name) => {
      files.delete(name);
    },
    urlOf: (jobId, name) => `/api/jobs/${jobId}/note/attachments/${name}`,
    objectUrl: () => 'blob:shot',
    revokeUrl: () => {},
  };
  return { deps, files, landing };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const shot = (name = 'IMG_4412.PNG') =>
  new File([new Uint8Array(1_000)], name, { type: 'image/png' });

/**
 * A phone sheet opened for a job, with the host's wiring and the real pictures controller. A server
 * render shows a store's state as it was created, so the host is rendered once, for the handlers
 * it hands the sheet (they are the real ones: they act on the controller and the dialog's store),
 * and `paint()` draws the sheet again from the stores' state as it is now.
 */
function openSheet(earlier: NoteAttachment[] = []) {
  const engine = fakeEngine(earlier);
  const attachments = createNoteAttachments(engine.deps);
  const store = createNoteDialogStore({ phase: 'writing', job: JOB, text: 'Use her song.' });
  const queryClient: QueryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { music: true, songs: true });
  // A server render runs no effects: the host's "the dialog opened" is done here.
  attachments.open(JOB.id);
  let given: NoteDialogProps | undefined;
  const View = (props: NoteDialogProps) => {
    given = props;
    return <PhoneNoteSheet {...props} />;
  };
  const hosted = renderCell(
    <NoteDialogHost
      jobs={CANVAS_JOBS}
      store={store}
      attachments={attachments}
      libraryPicker={false}
      view={View}
    />,
    queryClient,
  );
  if (given === undefined || given.pictures === null || given.pictures === undefined) {
    throw new Error('the host did not draw the sheet with pictures');
  }
  const handlers = given;
  const handedPictures = given.pictures;
  return {
    engine,
    attachments,
    store,
    hosted,
    handlers,
    pictures: handedPictures,
    paint: () => {
      const state = store.getState();
      return renderCell(
        <PhoneNoteSheet
          {...handlers}
          open={isNoteDialogOpen(state)}
          text={state.text}
          held={state.held}
          error={state.error}
          saving={state.phase === 'saving'}
          pictures={{ ...handedPictures, rows: attachments.store.getState().rows }}
        />,
        queryClient,
      );
    },
  };
}

describe('the phone’s note sheet through the host (Songs on)', () => {
  it('draws the sheet with Add photo, the note’s text and no rows', () => {
    const phone = openSheet();
    expect(phone.hosted).toContain('data-slot="phone-note-sheet"');
    expect(phone.hosted).toContain('Add photo');
    expect(phone.hosted).toContain('Use her song.</textarea>');
    expect(phone.hosted).not.toContain('The brief reads');
  });

  it('shows an added photo as a row at once, then the row is kept when it lands', async () => {
    const phone = openSheet();
    phone.pictures.onFiles([shot()], 'chosen');
    const sending = phone.paint();
    expect(sending).toContain('Attaching…');
    expect(sending).toContain('IMG_4412.PNG');

    phone.engine.landing[0]?.land();
    await flush();
    const kept = phone.paint();
    expect(kept).not.toContain('Attaching…');
    expect(textOf(kept)).toContain('IMG_4412.PNG The brief reads the song off it.');
    expect(phone.engine.files.has('IMG_4412.PNG')).toBe(true);
  });

  it('shows the pictures the note already had, with their thumbnails from the engine', async () => {
    const phone = openSheet([
      { name: 'IMG_4000.PNG', bytes: 90_000, addedAt: '2026-10-24T10:00:00.000Z' },
    ]);
    await flush();
    const markup = phone.paint();
    expect(textOf(markup)).toContain('IMG_4000.PNG The brief reads the song off it.');
    expect(markup).toContain('src="/api/jobs/j2/note/attachments/IMG_4000.PNG"');
  });

  it('the × of a picture added in this opening deletes it on the engine at once', async () => {
    const phone = openSheet();
    phone.pictures.onFiles([shot('a.png'), shot('b.png')], 'chosen');
    for (const upload of phone.engine.landing) upload.land();
    await flush();
    expect([...phone.engine.files.keys()]).toEqual(['a.png', 'b.png']);

    phone.paint();
    pressed.get('Remove a.png')?.();
    await flush();

    expect([...phone.engine.files.keys()]).toEqual(['b.png']);
    const markup = phone.paint();
    expect(markup).not.toContain('Remove a.png');
    expect(markup).toContain('Remove b.png');
  });

  it('Save waits for a picture still on its way, then sends the note, and the file is kept', async () => {
    const phone = openSheet();
    phone.pictures.onFiles([shot()], 'chosen');
    phone.paint();

    pressed.get('Save')?.();
    await flush();
    // The note is not sent while the picture is on its way, and the sheet shows it is saving.
    expect(saved).toEqual([]);
    expect(phone.store.getState().phase).toBe('saving');
    expect(phone.paint()).toMatch(/aria-busy="true"/);

    phone.engine.landing[0]?.land();
    await flush();
    await flush();

    expect(saved).toEqual([['j2', 'Use her song.']]);
    expect(phone.store.getState().phase).toBe('closed');
    expect(phone.engine.files.has('IMG_4412.PNG')).toBe(true);
    expect(phone.paint()).toBe('');
  });

  it('Save is stopped, in words, by a photo that did not attach, until it is taken off', async () => {
    const phone = openSheet();
    phone.pictures.onFiles([new File(['x'], 'notes.pdf', { type: 'application/pdf' })], 'chosen');
    phone.paint();
    pressed.get('Save')?.();
    await flush();

    expect(saved).toEqual([]);
    expect(phone.store.getState().phase).toBe('writing');
    expect(textOf(phone.paint())).toContain(
      'A picture didn’t attach. Take it off to save the note.',
    );

    pressed.get('Remove notes.pdf')?.();
    phone.paint();
    pressed.get('Save')?.();
    await flush();
    await flush();
    expect(saved).toEqual([['j2', 'Use her song.']]);
  });

  it('closing without saving deletes the photos this opening added, and keeps the earlier ones', async () => {
    const phone = openSheet([
      { name: 'IMG_4000.PNG', bytes: 90_000, addedAt: '2026-10-24T10:00:00.000Z' },
    ]);
    await flush();
    phone.pictures.onFiles([shot('new.png')], 'chosen');
    phone.engine.landing[0]?.land();
    await flush();
    expect([...phone.engine.files.keys()].sort()).toEqual(['IMG_4000.PNG', 'new.png']);

    // A tap on the dimmed page (or the grabber, or Esc): the sheet's onOpenChange(false).
    phone.paint();
    sheetEvents.onOpenChange?.(false);
    await flush();

    expect([...phone.engine.files.keys()]).toEqual(['IMG_4000.PNG']);
    expect(saved).toEqual([]);
    expect(phone.store.getState().phase).toBe('closed');
    expect(phone.paint()).toBe('');
  });

  it('the grabber closes it the same way', async () => {
    const phone = openSheet();
    phone.pictures.onFiles([shot('new.png')], 'chosen');
    phone.engine.landing[0]?.land();
    await flush();

    phone.paint();
    grabberClose?.();
    await flush();

    expect([...phone.engine.files.keys()]).toEqual([]);
    expect(phone.store.getState().phase).toBe('closed');
  });

  it('closing deletes a photo that lands after the sheet was closed', async () => {
    const phone = openSheet();
    phone.pictures.onFiles([shot('late.png')], 'chosen');
    phone.paint();
    sheetEvents.onOpenChange?.(false);
    await flush();
    phone.engine.landing[0]?.land();
    await flush();
    expect([...phone.engine.files.keys()]).toEqual([]);
  });

  it('cannot be closed while the note is on its way', async () => {
    const phone = openSheet();
    let release!: () => void;
    saveHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    phone.paint();
    pressed.get('Save')?.();
    await flush();
    expect(phone.store.getState().phase).toBe('saving');

    // The sheet, drawn while saving, does not pass the close on (and the flow would not take it).
    phone.paint();
    sheetEvents.onOpenChange?.(false);
    grabberClose?.();
    await flush();
    expect(phone.store.getState().phase).toBe('saving');

    release();
    await flush();
    await flush();
    expect(phone.store.getState().phase).toBe('closed');
    expect(saved).toEqual([['j2', 'Use her song.']]);
  });
});

describe('<PhoneNoteDialogHost>: which view the phone gets', () => {
  const renderHost = (health: object | null) => {
    const queryClient = createTestQueryClient();
    if (health !== null) queryClient.setQueryData(HEALTH_KEY, health);
    const store = createNoteDialogStore({ phase: 'writing', job: JOB, text: 'Hello' });
    return renderCell(<PhoneNoteDialogHost jobs={CANVAS_JOBS} store={store} />, queryClient);
  };

  it('is the bottom sheet, with Add photo, while the Songs switch is on', () => {
    const markup = renderHost({ music: true, songs: true });
    expect(markup).toContain('data-slot="phone-note-sheet"');
    expect(markup).toContain('Add photo');
    expect(markup).not.toContain('Cancel');
  });

  it('is the dialog it always was while Songs is off (no health answer, songs off, or music off)', () => {
    for (const health of [null, { music: true, songs: false }, { music: false, songs: true }]) {
      const markup = renderHost(health);
      expect(markup, JSON.stringify(health)).toContain('data-slot="dialog"');
      expect(markup).not.toContain('phone-note-sheet');
      expect(markup).not.toContain('Add photo');
      expect(textOf(markup)).toContain('Cancel');
      expect(textOf(markup)).toContain('The brief comes from the files in the job folder.');
    }
  });
});
