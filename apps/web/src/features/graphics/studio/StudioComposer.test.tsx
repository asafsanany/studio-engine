import { describe, expect, it } from 'vitest';
import { StudioComposer } from './StudioComposer';
import { makeComposer, renderStudio, tagWith, textOf } from './test-helpers';
import type { ComposerController } from './use-studio-composer';

/** The attribute a disabled control carries (its class list says `disabled:` too). */
const DISABLED = / disabled=""/;

async function composer(
  controller: Partial<ComposerController> = {},
  props: { hasMessages?: boolean; offline?: boolean } = {},
): Promise<string> {
  return renderStudio(
    <StudioComposer
      composer={makeComposer(controller)}
      hasMessages={props.hasMessages ?? false}
      offline={props.offline ?? false}
    />,
  );
}

const recorder = (
  phase: ComposerController['voice']['snapshot']['phase'],
  error: string | null = null,
) => ({
  ...makeComposer().voice,
  snapshot: { phase, pinnedSec: null, elapsedSec: 0, error },
});

describe('<StudioComposer> · the box', () => {
  it('is a textarea in its own text direction with three rows and the message limit', async () => {
    const tag = tagWith(await composer(), '<textarea');
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain('rows="3"');
    expect(tag).toContain('maxLength="4000"');
    expect(tag).toContain('resize-none');
    expect(tag).toContain('[unicode-bidi:plaintext]');
  });

  it('asks for the graphic first, and for a change once the chat has messages', async () => {
    const first = tagWith(await composer({}, { hasMessages: false }), '<textarea');
    expect(first).toContain('placeholder="Describe the graphic you need…"');
    expect(first).toContain('aria-label="Describe the graphic you need"');
    const next = tagWith(await composer({}, { hasMessages: true }), '<textarea');
    expect(next).toContain('placeholder="Ask for a change…"');
    expect(next).toContain('aria-label="Ask for a change"');
  });

  it('shows the draft', async () => {
    expect(await composer({ draft: 'כותרת קטנה' })).toMatch(
      /<textarea[^>]*>כותרת קטנה<\/textarea>/,
    );
  });

  it('lets the draft be typed while a version is being made (only Send waits)', async () => {
    const html = await composer({
      send: { enabled: false, reason: 'Wait until v3 is made, then send your next message.' },
    });
    expect(tagWith(html, '<textarea')).not.toMatch(DISABLED);
  });
});

describe('<StudioComposer> · Send', () => {
  it('is blue, says Send, and works with text', async () => {
    const html = await composer({ draft: 'Make it dark', send: { enabled: true, reason: null } });
    const at = html.indexOf('Send</button>');
    const open = html.lastIndexOf('<button', at);
    const tag = html.slice(open, html.indexOf('>', open) + 1);
    expect(tag).toContain('data-variant="default"');
    expect(tag).not.toMatch(DISABLED);
  });

  it('waits when it is off, and while the message is on its way shows a spinner', async () => {
    const off = await composer();
    const offAt = off.indexOf('Send</button>');
    expect(off.slice(off.lastIndexOf('<button', offAt), offAt)).toMatch(DISABLED);

    const sending = await composer({ sending: true });
    const at = sending.indexOf('Send</button>');
    const tag = sending.slice(sending.lastIndexOf('<button', at), at);
    expect(tag).toContain('aria-busy="true"');
    expect(tag).toContain('lucide-loader-circle');
  });

  it('says why it was refused, in the server’s words, under the box', async () => {
    const html = await composer({ notice: 'Wait until v3 is made, then send your next message.' });
    expect(tagWith(html, 'role="alert"')).toContain('text-destructive');
    expect(textOf(html)).toContain('Wait until v3 is made, then send your next message.');
  });
});

describe('<StudioComposer> · attach', () => {
  it('has a file picker for several images, videos, fonts and PDFs, behind a paperclip', async () => {
    const html = await composer();
    const tag = tagWith(html, 'data-slot="attach-input"');
    expect(tag).toContain('type="file"');
    expect(tag).toContain('multiple');
    expect(tag).toContain('hidden');
    expect(tag).toContain(
      'accept="image/*,video/*,application/pdf,.pdf,.ttf,.otf,.ttc,.woff,.woff2"',
    );
    expect(html).toContain('aria-label="Add a reference: a screenshot, a clip or a logo"');
    expect(html).toContain('lucide-paperclip');
  });

  it('shows the pending files as chips, each with a way to remove it', async () => {
    const html = await composer({
      files: [
        new File([''], 'lower-third-I-like.png', { type: 'image/png' }),
        new File([''], 'clip.mov'),
      ],
    });
    expect(html.match(/data-slot="file-chip"/g)).toHaveLength(2);
    expect(html).toContain('lower-third-I-like.png');
    expect(html).toContain('aria-label="Remove lower-third-I-like.png"');
    expect(html).toContain('aria-label="Remove clip.mov"');
  });

  it('shows no chips without files', async () => {
    expect(await composer()).not.toContain('data-slot="file-chip"');
  });
});

describe('<StudioComposer> · the mic', () => {
  it('records on a press, and says so', async () => {
    const html = await composer();
    const tag = tagWith(html, 'aria-label="Record a voice note"');
    expect(tag).toContain('aria-pressed="false"');
    expect(html).not.toContain('data-slot="voice-line"');
  });

  it('says "Recording · press the mic again to stop" while it records, and the mic offers to stop', async () => {
    const html = await composer({ voice: recorder('recording') });
    expect(tagWith(html, 'data-slot="voice-line"')).toContain('data-phase="recording"');
    expect(textOf(html)).toContain('Recording · press the mic again to stop');
    const mic = tagWith(html, 'aria-label="Stop recording"');
    expect(mic).toContain('aria-pressed="true"');
    expect(mic).toContain('text-red-400');
  });

  it('says it waits for the microphone, and that it types the note out', async () => {
    expect(textOf(await composer({ voice: recorder('starting') }))).toContain(
      'Waiting for the microphone…',
    );
    const saving = await composer({ voice: recorder('saving') });
    expect(textOf(saving)).toContain('Typing out your voice note…');
    // The mic waits while the note is typed out.
    expect(tagWith(saving, 'aria-label="Record a voice note"')).toMatch(DISABLED);
  });

  it('keeps a recording the engine could not type out, with Try again and Discard', async () => {
    const html = await composer({
      voice: recorder(
        'failed',
        'Couldn’t add the voice note: The voice note could not be typed out. Try again, or type it.',
      ),
    });
    expect(textOf(html)).toContain('The voice note could not be typed out. Try again, or type it.');
    expect(html).toContain('Try again</button>');
    expect(html).toContain('Discard</button>');
  });

  it('says why the microphone could not start', async () => {
    const html = await composer({
      voice: recorder(
        'idle',
        'Microphone access is off. Allow it in the browser to record voice notes.',
      ),
    });
    expect(textOf(html)).toContain('Microphone access is off.');
  });
});

describe('<StudioComposer> · effort', () => {
  it('says Extra high, the default', async () => {
    const html = await composer();
    const tag = tagWith(html, 'data-slot="graphic-effort"');
    expect(tag).toContain('aria-label="Effort: Extra high"');
    expect(html).toContain('Extra high<');
    expect(html).toContain('lucide-chevron-down');
  });

  it('says the level that was picked', async () => {
    expect(tagWith(await composer({ effort: 'high' }), 'data-slot="graphic-effort"')).toContain(
      'aria-label="Effort: High"',
    );
    expect(tagWith(await composer({ effort: 'medium' }), 'data-slot="graphic-effort"')).toContain(
      'aria-label="Effort: Medium"',
    );
  });
});

describe('<StudioComposer> · offline', () => {
  it('makes the box and its buttons wait', async () => {
    const html = await composer({}, { offline: true });
    expect(tagWith(html, '<textarea')).toMatch(DISABLED);
    expect(tagWith(html, 'data-slot="graphic-effort"')).toMatch(DISABLED);
    expect(tagWith(html, 'aria-label="Record a voice note"')).toMatch(DISABLED);
    expect(tagWith(html, 'aria-label="Add a reference: a screenshot, a clip or a logo"')).toMatch(
      DISABLED,
    );
    expect(tagWith(html, 'data-slot="studio-composer"')).toContain('flex-none');
    expect(html).toContain('opacity-60');
  });
});

describe('<StudioComposer> · sending', () => {
  it('freezes the box and the files while the message is on its way', async () => {
    const html = await composer({
      sending: true,
      files: [new File([''], 'pill.png', { type: 'image/png' })],
    });
    expect(tagWith(html, '<textarea')).toMatch(DISABLED);
    expect(tagWith(html, 'aria-label="Remove pill.png"')).toMatch(DISABLED);
  });
});
