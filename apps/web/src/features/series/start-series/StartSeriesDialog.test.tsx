import { describe, expect, it, vi } from 'vitest';
import { renderCell } from '@/features/jobs/cells/test-helpers';
import type { StartSeriesTarget } from './start-series-dialog';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces
// for plain elements that keep the props this test cares about (width, disabled, busy).
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    AlertDialog: ({ open, children }: Props) =>
      open ? h('div', { 'data-open': '' }, children) : null,
    AlertDialogContent: ({ children, className }: Props) =>
      h('div', { role: 'alertdialog', className }, children),
    AlertDialogHeader: ({ children }: Props) => h('header', null, children),
    AlertDialogTitle: ({ children }: Props) => h('h2', null, children),
    AlertDialogDescription: ({ children }: Props) =>
      h('p', { 'data-role': 'description' }, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ variant, disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', 'data-variant': variant, disabled }, children),
    AlertDialogAction: ({ disabled, children, ...rest }: Props) =>
      h('button', { 'data-role': 'confirm', disabled, 'aria-busy': rest['aria-busy'] }, children),
  };
});

const { START_SERIES_DIALOG_TEXT, StartSeriesDialog } = await import('./StartSeriesDialog');

const TARGET: StartSeriesTarget = {
  jobId: 'faq-5',
  jobName: 'שאלות נפוצות 5',
  clientId: 'client-1',
  client: 'עו״ד דוד לוי',
  suggested: 'שאלות נפוצות',
  durationSec: 34,
};

const dialog = (props: Partial<React.ComponentProps<typeof StartSeriesDialog>> = {}) =>
  renderCell(
    <StartSeriesDialog
      open
      target={TARGET}
      name="שאלות נפוצות"
      problem={null}
      saving={false}
      onNameChange={() => {}}
      onConfirm={() => {}}
      onOpenChange={() => {}}
      skeletonDelayMs={250}
      {...props}
    />,
  );

/** The visible sentences of some markup: tags removed. */
const sentences = (markup: string) => markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');

/** The opening tag of the `<button>` with `data-role`. */
const button = (markup: string, role: string) =>
  markup.match(new RegExp(`<button [^>]*data-role="${role}"[^>]*>`))?.[0] ?? '';

describe('<StartSeriesDialog>', () => {
  it('uses the words of the design canvas, word for word', () => {
    expect(START_SERIES_DIALOG_TEXT).toEqual({
      cancel: 'Cancel',
      confirm: 'Start series',
      nameLabel: 'Series name',
      description:
        'Later episodes are rebuilt from this video’s composition. Each one brings only its own footage and words.',
      keptLead: 'Kept in every episode:',
      kept: 'the opening, titles and graphics, how the captions look, music, sounds and pacing.',
      newLead: 'New in each episode:',
      new: 'the footage, the on-screen text from the client’s brief, and captions from what’s said.',
    });
    const text = sentences(dialog());
    expect(text).toContain('Start a series from שאלות נפוצות 5?');
    expect(text).toContain(
      'Later episodes are rebuilt from this video’s composition. Each one brings only its own footage and words.',
    );
    expect(text).toContain(
      'Kept in every episode: the opening, titles and graphics, how the captions look, music, sounds and pacing.',
    );
    expect(text).toContain(
      'New in each episode: the footage, the on-screen text from the client’s brief, and captions from what’s said.',
    );
    expect(text).toContain(
      'Whatever only this show does moves out of עו״ד דוד לוי’s style and into the series, so the client’s other videos stop picking it up. Finished videos don’t change.',
    );
  });

  it('shows nothing while closed', () => {
    expect(dialog({ open: false })).toBe('');
  });

  it('is the board’s 520 px wide, spaced by 20 px', () => {
    const markup = dialog();
    expect(markup).toContain('data-[size=default]:sm:max-w-[520px]');
    expect(markup).toContain('gap-5');
  });

  it('prefills the name input and labels it', () => {
    const markup = dialog();
    expect(markup).toContain(
      '<label for="start-series-name" class="font-medium">Series name</label>',
    );
    const input = markup.match(/<input [^>]*>/)?.[0] ?? '';
    expect(input).toContain('id="start-series-name"');
    expect(input).toContain('value="שאלות נפוצות"');
    // Any direction, and the bidi look every name has.
    expect(input).toContain('dir="auto"');
    expect(input).toContain('bidi');
    expect(input).not.toContain(' disabled=""');
  });

  it('says which folders join the series, counting on from the job’s number', () => {
    expect(sentences(dialog())).toContain(
      'Folders named שאלות נפוצות 6, שאלות נפוצות 7 and so on join it on their own.',
    );
    // They follow the name as it is typed.
    expect(sentences(dialog({ name: 'Q&A' }))).toContain(
      'Folders named Q&amp;A 6, Q&amp;A 7 and so on join it on their own.',
    );
    // An empty input falls back to the suggestion.
    expect(sentences(dialog({ name: '' }))).toContain('Folders named שאלות נפוצות 6,');
  });

  it('puts every name in its own <bdi>', () => {
    const markup = dialog();
    expect(markup).toContain('<bdi>שאלות נפוצות 5</bdi>');
    expect(markup).toContain('<bdi>עו״ד דוד לוי</bdi>');
    expect(markup).toContain('<bdi>שאלות נפוצות 6</bdi>, <bdi>שאלות נפוצות 7</bdi>');
  });

  it('shows the job’s still with its name and length under it', () => {
    const markup = dialog();
    expect(markup).toContain('src="/api/jobs/faq-5/still"');
    expect(markup).toContain('aria-label="A frame of שאלות נפוצות 5"');
    expect(markup).toMatch(/<figcaption[^>]*><bdi>שאלות נפוצות 5<\/bdi> · 0:34<\/figcaption>/);
  });

  it('leaves the length out when the job has no export record', () => {
    expect(dialog({ target: { ...TARGET, durationSec: null } })).toMatch(
      /<figcaption[^>]*><bdi>שאלות נפוצות 5<\/bdi><\/figcaption>/,
    );
  });

  it('has Cancel (outline) and Start series, which is on while there is a name', () => {
    const markup = dialog();
    expect(button(markup, 'cancel')).toContain('data-variant="outline"');
    expect(markup).toMatch(/data-role="confirm"[^>]*>Start series<\/button>/);
    expect(button(markup, 'confirm')).not.toContain('disabled');
  });

  it.each(['', '   '])('turns Start series off while the name is empty (%j)', (name) => {
    const markup = dialog({ name });
    expect(button(markup, 'confirm')).toContain('disabled');
    expect(button(markup, 'cancel')).not.toContain('disabled');
  });

  it('says why under the input when the server refused the name (422), and not the hint', () => {
    const markup = dialog({ problem: 'This client already has a series called שאלות נפוצות.' });
    expect(markup).toContain('role="alert"');
    expect(sentences(markup)).toContain('This client already has a series called שאלות נפוצות.');
    expect(markup).not.toContain('and so on join it on their own');
    const input = markup.match(/<input [^>]*>/)?.[0] ?? '';
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="start-series-problem"');
    expect(markup).toContain('id="start-series-problem"');
  });

  it('has no refusal text and a valid input before anything is refused', () => {
    const markup = dialog();
    expect(markup).not.toContain('role="alert"');
    expect(markup.match(/<input [^>]*>/)?.[0]).toContain('aria-invalid="false"');
  });

  it('shows a spinner and locks everything while the request is in flight', () => {
    const markup = dialog({ saving: true });
    expect(button(markup, 'confirm')).toContain('aria-busy="true"');
    expect(button(markup, 'confirm')).toContain('disabled');
    expect(button(markup, 'cancel')).toContain('disabled');
    expect(markup.match(/<input [^>]*>/)?.[0]).toContain(' disabled=""');
    expect(markup).toContain('animate-spin');
  });
});
