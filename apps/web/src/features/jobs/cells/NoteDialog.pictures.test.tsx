import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRow } from '../note-attachments';
import { textOf } from './test-helpers';

// The pictures part of "Note for the editor" (Songs, SG5; design canvas board SGNote, states
// empty, shot, link), server-rendered. Choosing, pasting and dropping run in the browser; their
// rules are in note-attachments.test.ts and note-dialog.attachments.test.ts.

vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { NoteDialog } = await import('./NoteDialog');
const { renderCell } = await import('./test-helpers');

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  key: 'new-1',
  name: 'IMG_4412.PNG',
  bytes: 1_200_000,
  from: 'pasted',
  status: 'ready',
  error: null,
  previewUrl: 'blob:http://localhost/abc',
  ...over,
});

const pictures = (
  rows: AttachmentRow[] = [],
  over: Partial<{ dragging: boolean }> = {},
): React.ComponentProps<typeof NoteDialog>['pictures'] => ({
  rows,
  dragging: false,
  onFiles: () => {},
  onRemove: () => {},
  ...over,
});

const dialog = (props: Partial<React.ComponentProps<typeof NoteDialog>> = {}) =>
  renderCell(
    <NoteDialog
      open
      jobName="Demo 2"
      client="Falcon FPV"
      text=""
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

describe('the dialog without pictures (Songs off, or the phone)', () => {
  it('is as it was: no drop zone, no file input', () => {
    const markup = dialog({ pictures: null });
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain('Choose a file');
    expect(markup).not.toContain('Drop a screenshot');
    expect(dialog({ pictures: undefined })).toBe(markup);
  });

  it('shows no reel-link line even for a reel link', () => {
    const markup = dialog({
      pictures: null,
      text: 'The song: https://www.instagram.com/reel/DQx7mK2kF9a/',
    });
    expect(markup).not.toContain('An Instagram reel link');
  });
});

describe('board state: nothing attached', () => {
  it('shows the drop zone, in the board’s words, with Choose a file', () => {
    const markup = dialog();
    expect(textOf(markup)).toContain(
      'Drop a screenshot here or paste one (⌘V). Links go in the note.',
    );
    expect(markup).toMatch(/<button[^>]*>Choose a file<\/button>/);
    expect(markup).not.toContain('Attached');
    expect(markup).not.toContain('Add another');
  });

  it('has a file input that takes pictures, several at a time, and is not in the way', () => {
    const markup = dialog();
    const input = markup.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('accept="image/*"');
    expect(input).toContain('multiple');
    expect(input).toContain('hidden');
  });

  it('sits under the text box and above Cancel and Save', () => {
    const markup = dialog();
    expect(markup.indexOf('<textarea')).toBeLessThan(markup.indexOf('Drop a screenshot'));
    expect(markup.indexOf('Drop a screenshot')).toBeLessThan(markup.indexOf('Cancel'));
  });

  it('lights the zone while a file is dragged over the page, and says where it lands', () => {
    const idle = dialog();
    const over = dialog({ pictures: pictures([], { dragging: true }) });
    expect(idle).not.toContain('Drop to attach');
    expect(over).toContain('Drop to attach');
    expect(over).toContain('border-ring');
  });
});

describe('board state: a screenshot attached', () => {
  const markup = dialog({ pictures: pictures([row()]) });

  it('shows the row: thumbnail, name, “Screenshot · 1.2 MB · pasted” and what the brief does with it', () => {
    const text = textOf(markup);
    expect(text).toContain('Attached');
    expect(text).toContain('IMG_4412.PNG');
    expect(text).toContain('Screenshot · 1.2 MB · pasted');
    expect(text).toContain(
      'The brief reads the song off it: the name under the reel, and “sped up” or “remix” when it says so.',
    );
    expect(markup).toContain('src="blob:http://localhost/abc"');
    // A phone screenshot’s shape: 72 × 128.
    expect(markup).toContain('w-[72px]');
    expect(markup).toContain('h-32');
  });

  it('has a ghost × named for the picture, and no drop zone', () => {
    expect(markup).toContain('aria-label="Remove IMG_4412.PNG"');
    expect(markup).not.toContain('Drop a screenshot here');
    expect(markup).toMatch(/<button[^>]*>Add another<\/button>/);
  });

  it('says how it came: dropped, chosen', () => {
    expect(textOf(dialog({ pictures: pictures([row({ from: 'dropped' })]) }))).toContain(
      'Screenshot · 1.2 MB · dropped',
    );
    expect(textOf(dialog({ pictures: pictures([row({ from: 'chosen' })]) }))).toContain(
      'Screenshot · 1.2 MB · chosen',
    );
  });

  it('says only “Screenshot · 1.2 MB” for a picture from an earlier opening', () => {
    const text = textOf(dialog({ pictures: pictures([row({ from: 'earlier' })]) }));
    expect(text).toContain('Screenshot · 1.2 MB The brief reads');
  });

  it('shows a Hebrew name in its own direction', () => {
    const hebrew = dialog({ pictures: pictures([row({ name: 'צילום מסך 14.03.png' })]) });
    expect(hebrew).toMatch(
      /<span dir="auto" class="[^"]*\bbidi\b[^"]*">צילום מסך 14\.03\.png<\/span>/,
    );
    expect(hebrew).toContain('aria-label="Remove צילום מסך 14.03.png"');
  });

  it('lists several, and stops offering Add another at six', () => {
    const five = Array.from({ length: 5 }, (_, n) => row({ key: `k${n}`, name: `shot-${n}.png` }));
    expect(dialog({ pictures: pictures(five) })).toContain('Add another');
    const six = [...five, row({ key: 'k5', name: 'shot-5.png' })];
    const full = dialog({ pictures: pictures(six) });
    expect(full).not.toContain('Add another');
    expect(full.match(/aria-label="Remove /g)).toHaveLength(6);
  });

  it('turns every button off while the note is being saved', () => {
    const saving = dialog({ pictures: pictures([row()]), saving: true });
    expect(saving).toMatch(/<button[^>]*disabled[^>]*aria-label="Remove IMG_4412.PNG"/);
    const empty = dialog({ pictures: pictures(), saving: true });
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>Choose a file<\/button>/);
  });
});

describe('a picture on its way and one that failed', () => {
  it('shows a small spinner on a picture that is being sent', () => {
    const markup = dialog({ pictures: pictures([row({ status: 'uploading' })]) });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('animate-spin');
    expect(markup).toContain('Attaching…');
  });

  it('shows no spinner once it is kept', () => {
    expect(dialog({ pictures: pictures([row()]) })).not.toContain('animate-spin');
  });

  it('says why a picture did not attach, in its row, and can still be taken off', () => {
    const markup = dialog({
      pictures: pictures([
        row({
          name: 'notes.pdf',
          status: 'failed',
          error: 'That isn’t a picture. Attach a PNG, JPG, HEIC, WEBP or GIF.',
          previewUrl: null,
        }),
      ]),
    });
    expect(markup).toContain('role="alert"');
    expect(textOf(markup)).toContain('That isn’t a picture. Attach a PNG, JPG, HEIC, WEBP or GIF.');
    expect(markup).not.toContain('Screenshot ·');
    expect(markup).toContain('aria-label="Remove notes.pdf"');
  });
});

describe('board state: a reel link in the text', () => {
  it('says what the editor does with it', () => {
    const markup = dialog({
      text: 'Yael wants the song from this reel: https://www.instagram.com/reel/DQx7mK2kF9a/',
    });
    expect(textOf(markup)).toContain(
      'An Instagram reel link The editor takes the song from that reel, and the exact part it uses.',
    );
  });

  it('says it next to the picture too, and only for a reel link', () => {
    const both = dialog({
      pictures: pictures([row()]),
      text: 'Yael wants the song from this reel: https://www.instagram.com/reel/DQx7mK2kF9a/',
    });
    expect(both).toContain('An Instagram reel link');
    expect(both.indexOf('An Instagram reel link')).toBeLessThan(both.indexOf('Attached'));
    expect(dialog({ text: 'Yael wants this song. Start it where the reel does.' })).not.toContain(
      'An Instagram reel link',
    );
  });
});
