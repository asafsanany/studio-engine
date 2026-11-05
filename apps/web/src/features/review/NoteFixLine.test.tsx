import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { type NoteFixLine, noteFixLine } from './fix-lines';
import { makeOpenFix, makeQuickFix, routedNote } from './fix-test-helpers';
import { NoteFixLineView } from './NoteFixLine';
import { renderReview, tagWith } from './test-helpers';

// The line under a note (board QFReview): its icon, its words, the Undo button and the bar.

const CONTEXT = { auto: true, loaded: true, newestFixedId: 'f1', busy: false };

function lineOf(...args: Parameters<typeof noteFixLine>): NoteFixLine {
  const line = noteFixLine(...args);
  if (line === null) throw new Error('the note has no line');
  return line;
}

function view(line: NoteFixLine | null, phone = false, undoing = false): string {
  return renderReview(
    <NoteFixLineView line={line} phone={phone} onUndo={() => {}} undoing={undoing} />,
  );
}

const reading = lineOf(makeReviewNote({ routeStatus: 'pending' }), null, CONTEXT);
const queued = lineOf(routedNote('quick'), makeOpenFix('queued'), CONTEXT);
const running = lineOf(
  routedNote('quick'),
  makeOpenFix('running', { step: 1, stepLabel: 'Changing the caption font' }),
  CONTEXT,
);
const fixed = lineOf(routedNote('quick'), makeQuickFix({ durationSec: 38 }), CONTEXT);
const sends = lineOf(routedNote('revise'), null, CONTEXT);
const escalated = lineOf(
  routedNote('quick'),
  makeQuickFix({ status: 'escalated', why: 'the sign is part of the footage', said: null }),
  CONTEXT,
);
const undone = lineOf(routedNote('quick'), makeQuickFix({ status: 'undone', said: null }), CONTEXT);

describe('<NoteFixLineView>: the icon and the words of each line', () => {
  const table: [string, NoteFixLine, string, string, string][] = [
    ['reading', reading, 'lucide-loader-circle', 'text-muted-foreground', 'Reading the note…'],
    ['queued', queued, 'lucide-clock', 'text-muted-foreground', 'Quick fix · next in line'],
    [
      'running',
      running,
      'lucide-loader-circle',
      'text-blue-300',
      'Fixing it now · Changing the caption font',
    ],
    ['fixed', fixed, 'lucide-check', 'text-[#34D399]', 'Fixed in 38 s.'],
    ['sends', sends, 'lucide-send', 'text-muted-foreground', 'Goes with Send · it changes the cut'],
    [
      'escalated',
      escalated,
      'lucide-info',
      'text-[#FBBF24]',
      'Couldn’t do it here: the sign is part of the footage. It goes with Send.',
    ],
    [
      'undone',
      undone,
      'lucide-undo-2',
      'text-muted-foreground',
      'Undone. It goes to the editor when you send.',
    ],
  ];

  for (const [kind, line, icon, color, words] of table) {
    it(`${kind}: ${words}`, () => {
      const html = view(line);
      expect(tagWith(html, 'data-slot="note-fix"')).toContain(`data-kind="${kind}"`);
      expect(html).toContain(icon);
      // The icon's box carries the colour; the icon itself is hidden from screen readers.
      const box = tagWith(html, color);
      expect(box).toContain('aria-hidden="true"');
      expect(html).toContain(words);
    });
  }

  it('says the words in a live region, 13 px', () => {
    const html = view(running);
    const status = tagWith(html, 'role="status"');
    expect(status).toContain('text-[13px]');
    expect(status).toContain('text-zinc-300');
    expect(html).toContain('Fixing it now · Changing the caption font</span>');
  });

  it('says what waits more quietly than what happened', () => {
    expect(tagWith(view(sends), 'role="status"')).toContain('text-muted-foreground');
    expect(tagWith(view(fixed), 'role="status"')).toContain('text-zinc-300');
  });

  it('spins for reading and fixing only', () => {
    expect(view(reading)).toContain('animate-spin');
    expect(view(running)).toContain('animate-spin');
    for (const line of [queued, fixed, sends, escalated, undone]) {
      expect(view(line)).not.toContain('animate-spin');
    }
  });

  it('shows an English reply after the words on the same line, in its own isolate', () => {
    const html = view(fixed);
    expect(html).toContain(
      'Fixed in 38 s. <bdi dir="auto" data-slot="note-fix-said">The captions are Heebo Bold now.</bdi>',
    );
    expect(html).not.toContain('<span dir="auto"');
  });

  it('shows a Hebrew reply in its own element, dir="auto", on its own line below the words', () => {
    const said = 'הכיתוב בשנייה 25.6 הוא עכשיו "יש סיפור משלו".';
    const hebrew = lineOf(routedNote('quick'), makeQuickFix({ said, durationSec: 38 }), CONTEXT);
    const html = view(hebrew);
    const element = tagWith(html, 'data-slot="note-fix-said"');
    expect(element.startsWith('<span ')).toBe(true);
    expect(element).toContain('dir="auto"');
    expect(element).toContain('[unicode-bidi:plaintext]');
    // A block: it starts a line of its own, so the words keep "Fixed in 38 s." to themselves.
    expect(element).toContain('class="block ');
    expect(html).toContain(`Fixed in 38 s.<span dir="auto"`);
    expect(html).toContain(`>${said.replace(/"/g, '&quot;')}</span>`);
    expect(html).not.toContain('<bdi');
  });

  it('puts a reply that starts in Latin letters but holds Hebrew inline, and one that starts in Hebrew on its own line', () => {
    const mixed = view(
      lineOf(routedNote('quick'), makeQuickFix({ said: 'The title is “יש סיפור” now.' }), CONTEXT),
    );
    expect(tagWith(mixed, 'data-slot="note-fix-said"').startsWith('<bdi ')).toBe(true);
    const other = view(
      lineOf(routedNote('quick'), makeQuickFix({ said: '“יש סיפור” הוא הכיתוב עכשיו.' }), CONTEXT),
    );
    expect(tagWith(other, 'data-slot="note-fix-said"').startsWith('<span ')).toBe(true);
  });

  it('draws no reply element when the fix said nothing', () => {
    const quiet = lineOf(routedNote('quick'), makeQuickFix({ said: null }), CONTEXT);
    expect(view(quiet)).not.toContain('note-fix-said');
  });

  it('draws nothing for no line', () => {
    expect(view(null)).toBe('');
  });
});

describe('<NoteFixLineView>: Undo', () => {
  it('is a ghost button with the undo icon on the newest fixed fix', () => {
    const html = view(fixed);
    const button = tagWith(html, 'data-variant="ghost"');
    expect(button).toContain('type="button"');
    expect(button).not.toContain('disabled=""');
    expect(html).toContain('Undo</button>');
    expect(html.match(/lucide-undo-2/g)).toHaveLength(1);
  });

  it('is not there on a fixed fix that is not the newest, nor on any other line', () => {
    const older = lineOf(routedNote('quick'), makeQuickFix(), { ...CONTEXT, newestFixedId: 'f9' });
    expect(older.undoFixId).toBeNull();
    for (const line of [older, reading, queued, running, sends, escalated]) {
      expect(view(line)).not.toContain('Undo');
    }
  });

  it('on the undone line the icon is the undo icon, but there is no button', () => {
    const html = view(undone);
    expect(html).toContain('lucide-undo-2');
    expect(html).not.toContain('<button');
  });

  it('waits while another fix runs, and while its own Undo is on its way', () => {
    const blocked = lineOf(routedNote('quick'), makeQuickFix(), { ...CONTEXT, busy: true });
    expect(tagWith(view(blocked), 'data-variant="ghost"')).toContain('disabled=""');
    expect(tagWith(view(fixed, false, true), 'data-variant="ghost"')).toContain('disabled=""');
  });

  it('is 32 px tall on the phone', () => {
    expect(tagWith(view(fixed, true), 'data-variant="ghost"')).toContain('h-8');
    expect(tagWith(view(fixed), 'data-variant="ghost"')).not.toContain('h-8');
  });
});

describe('<NoteFixLineView>: the bar', () => {
  it('is 2 px, blue, at (step + 1) × 25 % while the fix runs, under the line', () => {
    const html = view(running);
    const bar = tagWith(html, 'data-slot="note-fix-bar"');
    expect(bar).toContain('width:50%');
    expect(bar).toContain('bg-[#3B82F6]');
    expect(bar).toContain('ease-in-out');
    expect(html).toContain('h-0.5');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf('note-fix-bar'));
  });

  it('follows the step', () => {
    const at = (step: number) =>
      view(lineOf(routedNote('quick'), makeOpenFix('running', { step }), CONTEXT));
    expect(at(0)).toContain('width:25%');
    expect(at(3)).toContain('width:100%');
  });

  it('is there only while the fix runs', () => {
    for (const line of [reading, queued, fixed, sends, escalated, undone]) {
      expect(view(line)).not.toContain('note-fix-bar');
    }
  });
});
