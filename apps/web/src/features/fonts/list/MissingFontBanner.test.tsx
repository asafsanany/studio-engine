import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { makeFontRequest, makeJob } from '@/data/test-utils';
import { bannerRequest, moreText, newestFirst, requestRunning } from './font-requests';
import { MissingFontBanner, type MissingFontBannerProps } from './MissingFontBanner';

// The banner on top of the Fonts page when a note asked for a font the library does not have
// (FN16; board FOPage `start=missing`, FOStates 9).

const noop = () => {};
function banner(props: Partial<MissingFontBannerProps> = {}): string {
  return renderToStaticMarkup(<MissingFontBanner requests={[]} onImport={noop} {...props} />);
}

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const GOTHAM = makeFontRequest({
  id: 'a3c19e0b7d44',
  name: 'Gotham Bold',
  jobName: 'Demo · Horizon FPV',
  at: '2026-10-25T09:30:00.000Z',
});
const AVENIR = makeFontRequest({
  id: 'b4d20f1c8e55',
  name: 'Avenir Next',
  jobName: 'Kova Coffee · Spring Sale',
  at: '2026-10-25T08:00:00.000Z',
});
const PROXIMA = makeFontRequest({
  id: 'c5e31a2d9f66',
  name: 'Proxima Nova Bold',
  jobName: 'Arc Fitness · Launch',
  at: '2026-10-24T22:10:00.000Z',
});

describe('the missing font banner', () => {
  it('with no request is nothing at all', () => {
    expect(banner({ requests: [] })).toBe('');
  });

  it('with one request: an amber dot, the sentence of the board, and Import fonts', () => {
    const html = banner({ requests: [GOTHAM] });

    expect(text(html)).toBe(
      'Demo · Horizon FPV asked for Gotham Bold in a note. It isn’t in your library, so the edit used the closest font it has.Import fonts',
    );
    expect(html).toContain('<b class="font-semibold">Demo · Horizon FPV</b>');
    expect(html).toContain('<b class="font-semibold">Gotham Bold</b>');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-slot="missing-font-banner"');
    expect(html).toContain('bg-status-held');
    expect(html).toContain('>Import fonts</button>');
    expect(html).not.toContain('more)');
    expect(html).not.toMatch(/<button[^>]* disabled=/);
  });

  // C51: the sentence is about the run that asked, so it follows that job's state.
  describe('while the job that asked is still editing', () => {
    const ASKED = makeFontRequest({ ...GOTHAM, jobId: 'job-asking' });
    const JOB = { id: 'job-asking', state: 'editing' } as const;

    it('says the edit is using the closest font; the rest of the bar is as it was', () => {
      const html = banner({ requests: [ASKED], jobs: [makeJob(JOB)] });
      expect(text(html)).toBe(
        'Demo · Horizon FPV asked for Gotham Bold in a note. It isn’t in your library, so the edit is using the closest font it has.Import fonts',
      );
      expect(html).toContain('data-slot="missing-font-banner"');
      expect(html).toContain('>Import fonts</button>');
    });

    it('says "used" again once the run has finished, whatever the way it ended', () => {
      for (const state of ['review', 'ready', 'failed', 'cancelled'] as const) {
        const html = banner({ requests: [ASKED], jobs: [makeJob({ ...JOB, state })] });
        expect(text(html)).toContain('so the edit used the closest font it has.');
        expect(text(html)).not.toContain('is using');
      }
    });

    it('does not say "is using" for a job that has not started (queued, held, arriving)', () => {
      for (const state of ['queued', 'held', 'arriving'] as const) {
        const html = banner({ requests: [ASKED], jobs: [makeJob({ ...JOB, state })] });
        expect(text(html)).toContain('so the edit used the closest font it has.');
      }
    });

    it('keeps the sentence as it was when the state is not known: no job list, or not that job', () => {
      const was =
        'Demo · Horizon FPV asked for Gotham Bold in a note. It isn’t in your library, so the edit used the closest font it has.Import fonts';
      expect(text(banner({ requests: [ASKED] }))).toBe(was);
      expect(text(banner({ requests: [ASKED], jobs: [] }))).toBe(was);
      expect(
        text(
          banner({ requests: [ASKED], jobs: [makeJob({ id: 'someone-else', state: 'editing' })] }),
        ),
      ).toBe(was);
    });

    it('follows the job of the request the bar shows (the newest), not another open one', () => {
      const other = makeFontRequest({ ...AVENIR, jobId: 'job-other' });
      const jobs = [makeJob(JOB), makeJob({ id: 'job-other', state: 'review' })];
      // Gotham (job-asking, editing) is the newest: "is using", with the other one counted.
      const html = banner({ requests: [other, ASKED], jobs });
      expect(text(html)).toContain('so the edit is using the closest font it has. (+1 more)');
      // The other one is the newest: its job has finished, so "used", whatever the first one does.
      const newer = makeFontRequest({ ...other, at: '2026-10-25T10:00:00.000Z' });
      expect(text(banner({ requests: [newer, ASKED], jobs }))).toContain(
        'so the edit used the closest font it has. (+1 more)',
      );
    });
  });

  it('with three requests: the newest, and “(+2 more)” after the sentence', () => {
    // Given out of order: the newest is shown whatever the order they come in.
    const html = banner({ requests: [AVENIR, PROXIMA, GOTHAM] });

    expect(text(html)).toBe(
      'Demo · Horizon FPV asked for Gotham Bold in a note. It isn’t in your library, so the edit used the closest font it has. (+2 more)Import fonts',
    );
    expect(html).toContain('data-slot="missing-font-more"');
    expect(html).not.toContain('Avenir Next');
    expect(html).not.toContain('Proxima Nova Bold');
  });

  it('with two requests: “(+1 more)”', () => {
    expect(text(banner({ requests: [GOTHAM, AVENIR] }))).toContain('(+1 more)');
  });

  it('waits with the engine: Import fonts is disabled while it can’t be reached', () => {
    const html = banner({ requests: [GOTHAM], offline: true });
    expect(html).toMatch(/<button[^>]* disabled=[^>]*>Import fonts<\/button>/);
  });

  it('does not read a name as markup', () => {
    const html = banner({
      requests: [makeFontRequest({ name: '<b>Gotham</b>', jobName: 'A & B' })],
    });
    expect(html).toContain('&lt;b&gt;Gotham&lt;/b&gt;');
    expect(html).toContain('A &amp; B');
  });
});

/** The first element in a rendered tree whose own text is `label` (the component is called, not mounted). */
function findByText(node: ReactNode, label: string): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  const children = Children.toArray(node.props.children as ReactNode);
  if (children.length === 1 && children[0] === label) return node;
  for (const child of children) {
    const found = findByText(child, label);
    if (found !== null) return found;
  }
  return null;
}

// C52: "Not a font" next to Import fonts, for a word after an @ that nobody meant as a font.
describe('the “Not a font” button', () => {
  it('is not there unless the bar is given what to do', () => {
    const html = banner({ requests: [GOTHAM] });
    expect(html).not.toContain('Not a font');
  });

  it('sits before Import fonts, as a quiet button with a hint saying what it does', () => {
    const html = banner({ requests: [GOTHAM], onDismiss: () => {} });

    expect(text(html)).toBe(
      'Demo · Horizon FPV asked for Gotham Bold in a note. It isn’t in your library, so the edit used the closest font it has.Not a fontImport fonts',
    );
    expect(html.indexOf('>Not a font</button>')).toBeLessThan(
      html.indexOf('>Import fonts</button>'),
    );
    expect(html).toContain(
      'title="That word was not a font. This bar will not ask about it again for this job."',
    );
    expect(html).not.toMatch(/<button[^>]* disabled=/);
  });

  it('dismisses the request the bar shows (the newest), not another open one', () => {
    const onDismiss = vi.fn();
    const tree = MissingFontBanner({
      requests: [AVENIR, GOTHAM, PROXIMA],
      onImport: noop,
      onDismiss,
    });

    const press = findByText(tree, 'Not a font')?.props.onClick;
    expect(press).toBeTypeOf('function');
    (press as () => void)();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(GOTHAM);
  });

  it('waits while the dismissal is on its way, and while the engine can’t be reached', () => {
    for (const props of [{ dismissing: true }, { offline: true }]) {
      const html = banner({ requests: [GOTHAM], onDismiss: () => {}, ...props });
      expect(html).toMatch(/<button[^>]* disabled=[^>]*>Not a font<\/button>/);
    }
  });

  it('leaves the next request on the bar once the first is gone from the list', () => {
    const html = banner({ requests: [AVENIR, PROXIMA], onDismiss: () => {} });
    expect(text(html)).toContain('Kova Coffee · Spring Sale asked for Avenir Next');
    expect(text(html)).toContain('(+1 more)');
    expect(banner({ requests: [PROXIMA], onDismiss: () => {} })).not.toContain('more)');
  });
});

describe('whether the run that asked is going', () => {
  const request = makeFontRequest({ jobId: 'job-1' });

  it('is yes only for a job that is editing', () => {
    expect(requestRunning(request, [makeJob({ id: 'job-1', state: 'editing' })])).toBe(true);
    expect(requestRunning(request, [makeJob({ id: 'job-1', state: 'review' })])).toBe(false);
    expect(requestRunning(request, [makeJob({ id: 'job-1', state: 'ready' })])).toBe(false);
  });

  it('is no when the jobs are not in yet, or the job is not among them', () => {
    expect(requestRunning(request, undefined)).toBe(false);
    expect(requestRunning(request, [])).toBe(false);
    expect(requestRunning(request, [makeJob({ id: 'job-2', state: 'editing' })])).toBe(false);
  });
});

describe('the pick of the request', () => {
  it('puts the newest first and keeps the order of requests made at the same moment', () => {
    const same = makeFontRequest({ id: 'd6f42b3e0a77', name: 'Gotham Black', at: GOTHAM.at });
    expect(newestFirst([PROXIMA, AVENIR, GOTHAM, same]).map((r) => r.name)).toEqual([
      'Gotham Bold',
      'Gotham Black',
      'Avenir Next',
      'Proxima Nova Bold',
    ]);
  });

  it('does not change the list it is given', () => {
    const given = [PROXIMA, GOTHAM];
    newestFirst(given);
    expect(given.map((r) => r.name)).toEqual(['Proxima Nova Bold', 'Gotham Bold']);
  });

  it('shows the newest and counts the others; nothing for none', () => {
    expect(bannerRequest([])).toBeNull();
    expect(bannerRequest([GOTHAM])).toEqual({ request: GOTHAM, others: 0 });
    expect(bannerRequest([PROXIMA, GOTHAM, AVENIR])).toEqual({ request: GOTHAM, others: 2 });
  });

  it('writes the count the way the board does', () => {
    expect(moreText(2)).toBe('(+2 more)');
  });
});
