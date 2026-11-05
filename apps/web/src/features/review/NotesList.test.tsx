import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { libraryClient } from '../library-picker/test-helpers';
import { NotesList } from './NotesList';
import { renderReview, sampleNotes, tagWith } from './test-helpers';

function list(props: Partial<React.ComponentProps<typeof NotesList>> = {}): string {
  return renderReview(
    <NotesList
      jobId="r1"
      client="מאפיית הצפון"
      seriesName={null}
      notes={[]}
      loading={false}
      failed={false}
      onRetry={() => {}}
      hoveredId={null}
      isActive={() => false}
      onHover={() => {}}
      onGo={() => {}}
      onDeleted={() => {}}
      cardRef={() => {}}
      onPlayVoice={() => {}}
      {...props}
    />,
  );
}

describe('<NotesList>', () => {
  it('is a scrolling column with the board’s padding and gap', () => {
    const html = list();
    expect(html).toContain('data-slot="review-notes-list"');
    for (const className of ['flex-1', 'overflow-y-auto', 'gap-2', 'p-3', 'min-h-0']) {
      expect(html).toContain(className);
    }
  });

  it('says what to do when there are no notes', () => {
    const html = list();
    expect(html).toContain(
      'No notes yet. Pause where something should change, then write or record a note below.',
    );
    expect(html).not.toContain('data-slot="review-note"');
  });

  it('lists the notes in time order, whatever order they arrive in', () => {
    const html = list({ notes: sampleNotes('r1') });
    const ids = [...html.matchAll(/data-slot="review-note" data-note-id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(ids).toEqual(['n1', 'n2', 'n3']);
    expect(html).not.toContain('No notes yet.');
  });

  it('marks the hovered and the active notes', () => {
    const html = list({
      notes: sampleNotes('r1'),
      hoveredId: 'n2',
      isActive: (note) => note.id === 'n3',
    });
    const states = [
      ...html.matchAll(/data-note-id="([^"]+)" data-kind="[a-z]+" data-state="([a-z]+)"/g),
    ].map((match) => `${match[1]}:${match[2]}`);
    expect(states).toEqual(['n1:idle', 'n2:hovered', 'n3:active']);
  });

  it('says it could not load the notes, with Try again', () => {
    const html = list({ notes: undefined, failed: true });
    expect(html).toContain('Couldn&#x27;t load the notes.');
    expect(html).toContain('Try again</button>');
    expect(html).not.toContain('No notes yet.');
  });

  it('shows no skeleton on the first render of a load (they wait 300 ms)', () => {
    const html = list({ notes: undefined, loading: true });
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('Loading the notes');
    expect(html).not.toContain('No notes yet.');
    expect(html).not.toContain('Try again');
  });

  it('keeps showing the notes it has even if a later load failed', () => {
    const html = list({ notes: sampleNotes('r1'), failed: true });
    expect(html).toContain('data-slot="review-note"');
    expect(html).not.toContain('Try again');
  });

  it('gives every card the Series toggle when the job is an episode, and none otherwise', () => {
    const notes = sampleNotes('r1');
    const episode = list({ notes, seriesName: 'מיתוס או אמת' });
    expect(episode.match(/data-slot="review-note"/g)).toHaveLength(3);
    expect(episode.match(/lucide-layers-2/g)).toHaveLength(3);
    const other = list({ notes });
    expect(other).not.toContain('lucide-layers-2');
    expect(other.match(/Add to style/g)).toHaveLength(2);
  });
});

describe('<NotesList> on the phone', () => {
  it('says what to do without "below": Write and Record are not under the list', () => {
    const html = list({ variant: 'phone' });
    expect(html).toContain(
      'No notes yet. Pause where something should change, then write or record a note.',
    );
    expect(html).not.toContain('below');
  });

  it('has the board’s 12 px above the first card and 16 px between cards (the Mac keeps 8)', () => {
    const phone = tagWith(list({ variant: 'phone' }), 'data-slot="review-notes-list"');
    expect(phone).toContain('gap-4');
    expect(phone).toContain('p-3');
    expect(phone).not.toContain('gap-2');
    expect(phone).not.toContain('pt-1');
    expect(tagWith(list(), 'data-slot="review-notes-list"')).toContain('gap-2');
  });

  it('keeps the list inside itself when it is scrolled to its end', () => {
    expect(list({ variant: 'phone' })).toContain('overscroll-contain');
    expect(list()).not.toContain('overscroll-contain');
  });

  it('gives its cards the phone’s 32 px buttons', () => {
    const html = list({ variant: 'phone', notes: sampleNotes('r1') });
    expect(html).toContain('h-8');
    expect(html).not.toContain('h-[22px]');
  });
});

describe('<NotesList> and notes that name a LUT', () => {
  const named = [makeReviewNote({ id: 'n9', text: 'Make it @luts/cinematic', atSec: 12.4 })];

  it('shows the pill and the line when lutsInEdits is on', () => {
    const html = renderReview(
      <NotesList
        jobId="r1"
        client="c"
        seriesName={null}
        notes={named}
        loading={false}
        failed={false}
        onRetry={() => {}}
        hoveredId={null}
        isActive={() => false}
        onHover={() => {}}
        onGo={() => {}}
        onDeleted={() => {}}
        cardRef={() => {}}
        onPlayVoice={() => {}}
      />,
      libraryClient({ inEdits: true }),
    );
    expect(html).toContain('data-slot="library-token"');
    expect(html).toContain('Saved. The next edit uses Cinematic on the whole video.');
  });

  it('shows the text as it was when lutsInEdits is off', () => {
    const html = renderReview(
      <NotesList
        jobId="r1"
        client="c"
        seriesName={null}
        notes={named}
        loading={false}
        failed={false}
        onRetry={() => {}}
        hoveredId={null}
        isActive={() => false}
        onHover={() => {}}
        onGo={() => {}}
        onDeleted={() => {}}
        cardRef={() => {}}
        onPlayVoice={() => {}}
      />,
      libraryClient({ inEdits: false }),
    );
    expect(html).toContain('Make it @luts/cinematic</p>');
    expect(html).not.toContain('library-');
  });

  it('leaves the phone’s cards alone, switch on or off', () => {
    const html = renderReview(
      <NotesList
        variant="phone"
        jobId="r1"
        client="c"
        seriesName={null}
        notes={named}
        loading={false}
        failed={false}
        onRetry={() => {}}
        hoveredId={null}
        isActive={() => false}
        onHover={() => {}}
        onGo={() => {}}
        onDeleted={() => {}}
        cardRef={() => {}}
        onPlayVoice={() => {}}
      />,
      libraryClient({ inEdits: true }),
    );
    expect(html).toContain('Make it @luts/cinematic</p>');
    expect(html).not.toContain('library-');
  });
});

describe('<NotesList> with Quick fixes on', () => {
  it('gives each card its own line, and none to a note without one', () => {
    const lines = new Map([
      [
        'n1',
        {
          kind: 'sends' as const,
          text: 'Goes with Send · it changes the cut',
          tail: null,
          progress: null,
          undoFixId: null,
          undoBlocked: false,
          deleteMode: 'ok' as const,
        },
      ],
    ]);
    const html = list({ notes: sampleNotes('r1'), fixLines: lines });
    expect(html.match(/data-slot="note-fix"/g)).toHaveLength(1);
    expect(html).toContain('Goes with Send · it changes the cut');
    // The first card is n1, the one with the line.
    expect(html.indexOf('data-note-id="n1"')).toBeLessThan(html.indexOf('data-slot="note-fix"'));
    expect(html.indexOf('data-slot="note-fix"')).toBeLessThan(html.indexOf('data-note-id="n2"'));
  });

  it('is the list it was while they are off (no lines given)', () => {
    const html = list({ notes: sampleNotes('r1') });
    expect(html).not.toContain('data-slot="note-fix"');
    expect(html).not.toContain('role="status"');
  });
});
