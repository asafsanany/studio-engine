import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import type { RecorderSnapshot } from '@/features/review/voice-recorder';
import { PhoneRecordingBar } from './PhoneRecordingBar';

const noop = () => {};

function bar(snapshot: Partial<RecorderSnapshot> = {}): string {
  return render(
    <PhoneRecordingBar
      snapshot={{ phase: 'recording', pinnedSec: 21.4, elapsedSec: 7.6, error: null, ...snapshot }}
      onCancel={noop}
      onStop={noop}
      onRetry={noop}
      onDiscard={noop}
    />,
  );
}

/** The opening tag of the first element in `html` that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

const disabledButton = (label: string) =>
  new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>).)*${label}</button>`);

describe('<PhoneRecordingBar> (board MReviewRec)', () => {
  it('says "Recording 0:07" and "pinned at 0:21" in a red 44 px bar', () => {
    const html = bar();
    const status = tagWith(html, 'role="status"');
    expect(status).toContain('min-h-11');
    expect(status).toContain('#F87171');
    expect(html).toContain('Recording 0:07');
    expect(html).toContain('pinned at 0:21');
    // The clock is not read out every second: a screen reader hears "Recording".
    expect(html).toMatch(
      /<span aria-hidden="true">Recording 0:07<\/span><span class="sr-only">Recording<\/span>/,
    );
  });

  it('has Cancel and Stop and add, 44 px each, above the home indicator', () => {
    const html = bar();
    expect(html).toContain('>Cancel</button>');
    expect(html).toMatch(/Stop and add<\/button>/);
    expect(html).not.toMatch(disabledButton('Stop and add'));
    expect(tagWith(html, 'data-slot="phone-recording-bar"')).toContain('var(--safe-bottom)');
    expect(html.match(/h-11 flex-1/g)).toHaveLength(2);
  });

  it('is the board’s 124 px box, above the home indicator’s room', () => {
    expect(tagWith(bar(), 'data-slot="phone-recording-bar"')).toContain(
      'min-h-[calc(124px+var(--safe-bottom))]',
    );
  });

  it('waits for the microphone: iPhone Safari is asking, so Stop waits', () => {
    const html = bar({ phase: 'starting', elapsedSec: 0 });
    expect(html).toContain('Waiting for the microphone…');
    expect(html).toContain('pinned at 0:21');
    expect(html).toMatch(disabledButton('Stop and add'));
    expect(html).not.toMatch(disabledButton('Cancel'));
  });

  it('adds the note: both buttons wait, Stop and add spins', () => {
    const html = bar({ phase: 'saving' });
    expect(html).toContain('Adding the voice note…');
    expect(html).toMatch(disabledButton('Cancel'));
    expect(html).toMatch(disabledButton('Stop and add'));
    expect(html).toContain('animate-spin');
  });

  it('a failed upload says why, keeps the recording, and offers Discard and Try again', () => {
    const html = bar({ phase: 'failed', error: "Couldn't add the voice note: offline" });
    expect(html).toContain('Couldn&#x27;t add the voice note: offline');
    expect(html).not.toContain('pinned at');
    expect(html).toContain('>Discard</button>');
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('Stop and add');
  });
});
