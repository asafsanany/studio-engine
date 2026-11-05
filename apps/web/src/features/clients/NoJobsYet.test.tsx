import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_JOBS_TEXT, NoJobsYet } from './NoJobsYet';

const text = (markup: string) =>
  markup
    .replace(/<\/p>/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

describe('<NoJobsYet>', () => {
  it('says "No jobs yet." and where a job folder goes, and that the style can come first', () => {
    expect(text(renderToStaticMarkup(<NoJobsYet />))).toBe(
      'No jobs yet. Drop a job folder into Studio Inbox/<client>/<job>. You can set up the style first.',
    );
    expect(NO_JOBS_TEXT.title).toBe('No jobs yet.');
  });

  it('writes the folder path as code, and the title in the medium weight of the other empty states', () => {
    const markup = renderToStaticMarkup(<NoJobsYet />);
    expect(markup).toContain('<code');
    expect(markup).toContain('Studio Inbox/&lt;client&gt;/&lt;job&gt;');
    expect(markup).toMatch(/<p class="font-medium">No jobs yet\.<\/p>/);
  });

  it('is a bordered, centred box like "No such client."', () => {
    const markup = renderToStaticMarkup(<NoJobsYet />);
    expect(markup).toContain('rounded-md border');
    expect(markup).toContain('items-center justify-center');
    expect(markup).toContain('text-center');
  });
});
