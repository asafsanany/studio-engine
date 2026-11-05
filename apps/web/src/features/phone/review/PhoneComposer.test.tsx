import { describe, expect, it } from 'vitest';
import { render } from '@/components/jobs/test-helpers';
import { PhoneComposer } from './PhoneComposer';

const noop = () => {};

function composer(props: Partial<React.ComponentProps<typeof PhoneComposer>> = {}): string {
  return render(
    <PhoneComposer
      timeLabel="0:27"
      draft=""
      onDraftChange={noop}
      onAdd={noop}
      onCancel={noop}
      onFocus={noop}
      adding={false}
      error={null}
      composerRef={null}
      keyboardOpen={false}
      {...props}
    />,
  );
}

/** The opening tag of the first element in `html` that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('<PhoneComposer> (board MReviewWrite)', () => {
  it('says where the note goes: "New note at 0:27"', () => {
    expect(composer()).toMatch(/New note at <span[^>]*>0:27<\/span>/);
  });

  it('has a 16 px box (iPhone Safari zooms into less), 84 px tall, in its own direction', () => {
    const box = tagWith(composer(), '<textarea');
    expect(box).toContain('text-base');
    expect(box).toContain('md:text-base');
    expect(box).toContain('h-[84px]');
    expect(box).toContain('dir="auto"');
    expect(box).toContain('maxLength="2000"');
    expect(box).toContain('placeholder="Write a note… the video pauses while you type"');
  });

  it('has Cancel and Comment, 44 px each; Comment waits for a word', () => {
    const empty = composer();
    expect(tagWith(empty, 'data-variant="outline"')).toContain('h-11');
    expect(empty).toMatch(/<button[^>]*h-11[^>]*>Cancel<\/button>/);
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>.*?Comment<\/button>/);
    const typed = composer({ draft: 'לחתוך את השוט של המדרגות' });
    expect(typed).not.toMatch(/<button[^>]*disabled=""[^>]*>.*?Comment<\/button>/);
    expect(typed).toContain('לחתוך את השוט של המדרגות');
  });

  it('a blank draft is no note', () => {
    expect(composer({ draft: '   ' })).toMatch(/<button[^>]*disabled=""[^>]*>.*?Comment<\/button>/);
  });

  it('shows a spinner on Comment while the note is on its way', () => {
    const html = composer({ draft: 'x', adding: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-spin');
  });

  it('says why the last add failed', () => {
    const html = composer({ draft: 'x', error: 'This job is no longer in Review.' });
    expect(html).toMatch(/role="alert"[^>]*>This job is no longer in Review\.</);
    expect(tagWith(html, '<textarea')).toContain('aria-describedby=');
  });

  it('sets its label in the page’s 1.43 line, as the board does', () => {
    expect(tagWith(composer(), '<label')).toContain('leading-[1.43]');
  });

  it('keeps room for the home indicator, unless the keyboard covers it', () => {
    const down = tagWith(composer(), 'data-slot="phone-composer"');
    expect(down).toContain('var(--safe-bottom)');
    expect(down).toContain('min-h-[calc(188px+var(--safe-bottom))]');
    const up = tagWith(composer({ keyboardOpen: true }), 'data-slot="phone-composer"');
    expect(up).not.toContain('safe-bottom');
    expect(up).toContain('min-h-[188px]');
  });
});
