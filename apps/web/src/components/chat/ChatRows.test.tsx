import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClaudeRow, FileChip, StepIcon, YourMessage } from './ChatRows';

describe('the shared chat rows', () => {
  it('puts Claude’s name above what it says', () => {
    const html = renderToStaticMarkup(
      <ClaudeRow>
        <p>Cut 1 is ready.</p>
      </ClaudeRow>,
    );
    expect(html).toContain('data-slot="claude-message"');
    expect(html.indexOf('Claude')).toBeLessThan(html.indexOf('Cut 1 is ready.'));
  });

  it('puts the owner’s files above their bubble and what goes with it under it', () => {
    const html = renderToStaticMarkup(
      <YourMessage text="Shorter hook" refs={['logo.png']}>
        <span>0:04</span>
      </YourMessage>,
    );
    expect(html.indexOf('logo.png')).toBeLessThan(html.indexOf('Shorter hook'));
    expect(html.indexOf('Shorter hook')).toBeLessThan(html.indexOf('0:04'));
  });

  it('leaves out an empty bubble', () => {
    const html = renderToStaticMarkup(<YourMessage text="  " refs={['a.mov']} />);
    expect(html).not.toContain('rounded-xl');
  });

  it('shows a file’s kind by its name and each step’s state by its icon', () => {
    expect(renderToStaticMarkup(<FileChip name="cut.mp4" />)).toContain('lucide-film');
    expect(renderToStaticMarkup(<FileChip name="brief.pdf" />)).toContain('lucide-file-text');
    expect(renderToStaticMarkup(<StepIcon state="done" />)).toContain('aria-label="Done"');
    expect(renderToStaticMarkup(<StepIcon state="running" />)).toContain('animate-spin');
    expect(renderToStaticMarkup(<StepIcon state="waiting" />)).toContain('aria-label="Waiting"');
  });
});
