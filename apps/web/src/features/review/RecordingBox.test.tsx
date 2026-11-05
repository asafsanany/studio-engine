import { describe, expect, it } from 'vitest';
import { RecordingBox } from './RecordingBox';
import { renderReview, tagWith } from './test-helpers';
import type { RecorderSnapshot } from './voice-recorder';

function box(snapshot: Partial<RecorderSnapshot> = {}): string {
  return renderReview(
    <RecordingBox
      snapshot={{ phase: 'recording', pinnedSec: 2.4, elapsedSec: 7.9, error: null, ...snapshot }}
      onCancel={() => {}}
      onStop={() => {}}
      onRetry={() => {}}
      onDiscard={() => {}}
    />,
  );
}

/** The opening tag of the button whose text is `label`. */
function buttonLabelled(html: string, label: string): string {
  const at = html.indexOf(`${label}</button>`);
  if (at === -1) throw new Error(`no button "${label}"`);
  return html.slice(
    html.lastIndexOf('<button', at),
    html.indexOf('>', html.lastIndexOf('<button', at)) + 1,
  );
}

describe('<RecordingBox> while recording', () => {
  it('shows the time and the pin on the right', () => {
    const html = box();
    expect(html).toContain('Recording 0:07</span>');
    expect(html).toContain('pinned at 0:02</span>');
    expect(html.indexOf('Recording 0:07')).toBeLessThan(html.indexOf('pinned at 0:02'));
  });

  it('is the composer’s outer box, marked with its phase', () => {
    const tag = tagWith(box(), 'data-slot="recording-box"');
    expect(tag).toContain('data-phase="recording"');
    for (const className of ['flex', 'shrink-0', 'flex-col', 'gap-2', 'border-t', 'p-3']) {
      expect(tag).toContain(className);
    }
  });

  it('is the red 76 px box', () => {
    const tag = tagWith(box(), 'role="status"');
    for (const className of [
      'h-[76px]',
      'rounded-md',
      'border-[#F87171]/40',
      'bg-[#F87171]/10',
      'px-3.5',
      'text-[13px]',
      'tabular-nums',
      'text-[#FCA5A5]',
    ]) {
      expect(tag).toContain(className);
    }
    expect(tagWith(box(), 'bg-[#F87171]"')).toContain('size-2');
  });

  it('has Cancel and "Stop and add", the second with a stop square', () => {
    const html = box();
    const cancel = buttonLabelled(html, 'Cancel');
    expect(cancel).toContain('data-variant="ghost"');
    expect(cancel).toContain('data-size="sm"');
    expect(cancel).not.toContain('disabled=""');
    const stop = buttonLabelled(html, 'Stop and add');
    expect(stop).toContain('data-variant="default"');
    expect(stop).toContain('data-size="sm"');
    expect(stop).not.toContain('disabled=""');
    expect(html).toContain('lucide-square');
    expect(tagWith(html, 'lucide-square')).toContain('size-3.5');
    expect(html.indexOf('Cancel</button>')).toBeLessThan(html.indexOf('Stop and add</button>'));
  });

  it('gives "Stop and add" the board’s 12 px sides and 8 px between the square and the label', () => {
    const stop = buttonLabelled(box(), 'Stop and add');
    expect(stop).toContain('gap-2');
    expect(stop).toContain('has-[&gt;svg]:px-3');
    // Cancel has no icon: shadcn's own 12 px sides are the board's, and it needs no gap.
    const cancel = buttonLabelled(box(), 'Cancel');
    expect(cancel).toContain(' px-3 ');
    expect(cancel).not.toContain('gap-2');
  });

  it('has no title attributes (the keys are tooltips)', () => {
    expect(box()).not.toContain('title=');
  });
});

/** What a screen reader gets of the status box: its text without the `aria-hidden` parts. */
function spokenText(html: string): string {
  const start = html.indexOf('>', html.indexOf('role="status"')) + 1;
  const status = html.slice(start, html.indexOf('</div>', start));
  return status
    .replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('<RecordingBox> for screen readers', () => {
  it('stays a status (live) region', () => {
    for (const phase of ['starting', 'recording', 'saving', 'failed'] as const) {
      expect(tagWith(box({ phase }), 'role="status"')).toContain('<div');
    }
  });

  it('hides the ticking clock and says only "Recording" in its place while recording', () => {
    const html = box();
    // The clock is shown, but hidden from assistive technology.
    expect(html).toContain('<span aria-hidden="true">Recording 0:07</span>');
    // A visually hidden label stands in for it; it does not change while the time does.
    expect(html).toContain('<span class="sr-only">Recording</span>');
    expect(spokenText(html)).toBe('Recording pinned at 0:02');
    expect(html).not.toContain('aria-live');
  });

  it('speaks the same words whatever the time is, so the clock never makes it announce again', () => {
    const at = (elapsedSec: number) => spokenText(box({ elapsedSec }));
    expect(at(0)).toBe(at(7.9));
    expect(at(65.5)).toBe(at(299));
    expect(at(0)).not.toMatch(/\d:\d\d.*\d:\d\d/);
  });

  it('keeps the other phases as plain text: they change only when the phase does', () => {
    for (const [snapshot, line] of [
      [{ phase: 'starting', elapsedSec: 0 }, 'Waiting for the microphone…'],
      [{ phase: 'saving' }, 'Adding the voice note…'],
    ] as const) {
      const html = box(snapshot);
      expect(html).not.toContain('sr-only');
      expect(spokenText(html)).toContain(line);
    }
    const failed = box({ phase: 'failed', error: "Couldn't add the voice note: offline" });
    expect(failed).not.toContain('sr-only');
    expect(spokenText(failed)).toBe('Couldn&#x27;t add the voice note: offline');
  });
});

describe('<RecordingBox> while starting', () => {
  it('waits for the microphone and offers only Cancel', () => {
    const html = box({ phase: 'starting', elapsedSec: 0 });
    expect(tagWith(html, 'data-slot="recording-box"')).toContain('data-phase="starting"');
    expect(html).toContain('Waiting for the microphone…</span>');
    expect(html).toContain('pinned at 0:02</span>');
    expect(html).toContain('Cancel</button>');
    expect(html).not.toContain('Stop and add');
    expect(html).not.toContain('lucide-square');
  });
});

describe('<RecordingBox> while the note uploads', () => {
  it('says so, with both buttons off and a spinner on "Stop and add"', () => {
    const html = box({ phase: 'saving' });
    expect(tagWith(html, 'data-slot="recording-box"')).toContain('data-phase="saving"');
    expect(html).toContain('Adding the voice note…</span>');
    expect(html).toContain('pinned at 0:02</span>');
    expect(buttonLabelled(html, 'Cancel')).toContain('disabled=""');
    const stop = buttonLabelled(html, 'Stop and add');
    expect(stop).toContain('disabled=""');
    expect(stop).toContain('aria-busy="true"');
    expect(html).toContain('lucide-loader-circle');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('lucide-square');
  });
});

describe('<RecordingBox> after a failed upload', () => {
  const failed = {
    phase: 'failed',
    error: "Couldn't add the voice note: A voice note can be at most 5 minutes long.",
  } as const;

  it('says why, with Discard and Try again and no pin', () => {
    const html = box(failed);
    expect(tagWith(html, 'data-slot="recording-box"')).toContain('data-phase="failed"');
    expect(html).toContain(
      'Couldn&#x27;t add the voice note: A voice note can be at most 5 minutes long.</span>',
    );
    expect(html).not.toContain('pinned at');
    expect(html).not.toContain('Recording');
    expect(buttonLabelled(html, 'Discard')).toContain('data-variant="ghost"');
    expect(buttonLabelled(html, 'Try again')).toContain('data-variant="default"');
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('Stop and add');
  });
});
