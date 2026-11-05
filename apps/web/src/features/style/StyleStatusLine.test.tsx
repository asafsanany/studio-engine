import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StyleStatusLine } from './StyleStatusLine';
import type { StyleStatus } from './style-status';

const render = (status: StyleStatus, retrying = false) =>
  renderToStaticMarkup(<StyleStatusLine status={status} onRetry={() => {}} retrying={retrying} />);

describe('<StyleStatusLine>', () => {
  it('shows bytes on their way: a spinner, the text and a bar at that share', () => {
    const markup = render({ kind: 'uploading', text: 'Uploading 3 files… 42%', percent: 42 });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-status="uploading"');
    expect(markup).toContain('Uploading 3 files… 42%');
    expect(markup).toContain('lucide-loader-circle');
    expect(markup).toMatch(
      /role="progressbar"[^>]*aria-valuenow="42"|aria-valuenow="42"[^>]*role="progressbar"/,
    );
    expect(markup).toContain('translateX(-58%)');
    expect(markup).toContain('aria-label="Upload progress"');
  });

  it('shows the files being analysed: a spinner and no bar', () => {
    const markup = render({
      kind: 'busy',
      text: 'Analysing 3 files. style.md updates when it’s done.',
    });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Analysing 3 files. style.md updates when it’s done.');
    expect(markup).toContain('lucide-loader-circle');
    expect(markup).not.toContain('progressbar');
    expect(markup).not.toContain('Retry');
  });

  it('lets the spinner stand still for people who asked for less motion', () => {
    expect(render({ kind: 'busy', text: 'x' })).toContain('motion-reduce:animate-none');
  });

  it('puts the name of the job in its own direction, so Hebrew does not scramble the sentence', () => {
    const markup = render({
      kind: 'busy',
      text: 'Learning the style from השקת תפריט חדש.',
      job: 'השקת תפריט חדש',
    });
    expect(markup).toContain('Learning the style from <bdi>השקת תפריט חדש</bdi>.');
  });

  it('says the files were added, with a check mark', () => {
    const markup = render({ kind: 'done', text: 'Added 2 files to the style.' });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-status="done"');
    expect(markup).toContain('lucide-check');
    expect(markup).toContain('Added 2 files to the style.');
  });

  it('says "still working" calmly: a status, not an alert', () => {
    const markup = render({ kind: 'info', text: 'Still working on the last files.' });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('lucide-info');
    expect(markup).not.toContain('status-failed');
  });

  it('shows a failed run as an alert in the colour of a failed job, with Retry', () => {
    const markup = render({
      kind: 'error',
      text: 'Style stopped: the file is missing.',
      retry: true,
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Style stopped: the file is missing.');
    expect(markup).toContain('border-status-failed/40');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(markup).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('waits on Retry while it is sent', () => {
    const markup = render({ kind: 'error', text: 'x', retry: true }, true);
    expect(markup).toMatch(/<button[^>]* disabled=""[^>]*>Retry<\/button>/);
  });

  it('has no Retry for a refusal of the files', () => {
    const markup = render({ kind: 'error', text: 'The files are larger than 2 GB.', retry: false });
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('Retry');
  });

  it('lets a text in any script pick its own direction', () => {
    expect(render({ kind: 'done', text: 'x' })).toMatch(/<span dir="auto"/);
  });
});
