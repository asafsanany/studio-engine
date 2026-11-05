import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { jobSheetJobs } from '@/features/job-sheet/test-fixtures';
import { renderAt } from '@/lib/test-router';
import { SentItCard, ShareIconButton, ShareVideoButton, ShareVideoView } from './PhoneShareVideo';
import type { ShareFlow, ShareTarget } from './share-video';

// The share flow as the sheet draws it (boards MJobSheet "approved" and MJobSheetSent): the button
// in each state of the flow, and "Sent it to <client>?". The flow's states are share-video.test.ts.

const TARGET: ShareTarget = {
  url: '/api/jobs/1e62273e8dba/download',
  fileName: 'טורניר בחירות שש בש.mp4',
  sizeBytes: 27_000_000,
};
const file = new File([new Uint8Array(3)], TARGET.fileName, { type: 'video/mp4' });
const LINE = 'Mark it delivered, and ₪40 counts in October.';

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The opening tag of the first element whose attributes contain `needle`. */
const tag = (markup: string, needle: string) =>
  markup.match(new RegExp(`<[^>]*${needle}[^>]*>`))?.[0] ?? '';

const buttonOf = (flow: ShareFlow) =>
  renderAt('/jobs', <ShareVideoButton flow={flow} target={TARGET} onShare={() => {}} />);

function actionsOf(overrides: Partial<{ busy: boolean; refusal: string | null }> = {}) {
  return { run: vi.fn(), busy: false, refusal: null, dismissRefusal: vi.fn(), ...overrides };
}

type ViewProps = Parameters<typeof ShareVideoView>[0];

function propsOf(
  flow: ShareFlow,
  overrides: Partial<ViewProps['share']> = {},
  actions = actionsOf(),
) {
  return {
    job: jobSheetJobs.approved,
    share: { flow, target: TARGET, share: vi.fn(), notYet: vi.fn(), ...overrides },
    line: LINE,
    actions,
  } satisfies ViewProps;
}

const viewOf = (flow: ShareFlow) => <ShareVideoView {...propsOf(flow)} />;

/** The first element in `node`'s tree (props.children, depth first) whose type is `type`. */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  const children = node.props.children as ReactNode;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, type);
    if (found !== null) return found;
  }
  return null;
}

/** The `name` callback of the first `type` element in `node`'s tree; throws when there is none. */
function handler(node: ReactNode, type: unknown, name: string): () => void {
  const callback = find(node, type)?.props[name];
  if (typeof callback !== 'function') throw new Error(`no ${name}`);
  return callback as () => void;
}

describe('<ShareVideoButton>: the big button of an Approved job', () => {
  it('getting: "Getting the video · 12 of 27 MB", the fill at the percent, 48 px', async () => {
    const markup = await buttonOf({ phase: 'getting', loaded: 12_000_000, total: 27_000_000 });
    const bar = tag(markup, 'data-slot="share-getting"');
    expect(bar).toContain('role="status"');
    expect(bar).toMatch(/\bh-12\b/);
    expect(bar).toContain('bg-primary/25');
    expect(text(markup)).toBe('Getting the video · 12 of 27 MB');
    expect(tag(markup, 'data-slot="share-getting-fill"')).toContain('width:44%');
    expect(markup).not.toContain('data-sheet-action');
  });

  it('idle: the bar at nothing, as the fetch starts when the sheet opens', async () => {
    const markup = await buttonOf({ phase: 'idle' });
    expect(text(markup)).toBe('Getting the video · 0 of 27 MB');
    expect(tag(markup, 'data-slot="share-getting-fill"')).toContain('width:0%');
  });

  it('ready: Share video, with lucide Share, 48 px and the whole width', async () => {
    const markup = await buttonOf({ phase: 'ready', file });
    const button = tag(markup, 'data-sheet-action="share"');
    expect(button).toMatch(/^<button/);
    expect(button).toMatch(/\bh-12\b/);
    expect(button).toMatch(/\bw-full\b/);
    expect(button).not.toContain('aria-disabled');
    expect(markup).toContain('lucide-share');
    expect(text(markup)).toBe('Share video');
  });

  it('sharing: still Share video, but a second tap does nothing', async () => {
    const markup = await buttonOf({ phase: 'sharing', file });
    expect(tag(markup, 'data-sheet-action="share"')).toContain('aria-disabled="true"');
  });

  it('unsupported: Download MP4, the Mac’s link, as the button', async () => {
    const markup = await buttonOf({ phase: 'unsupported' });
    const link = tag(markup, 'data-sheet-action="download"');
    expect(link).toMatch(/^<a/);
    expect(link).toContain(`href="${TARGET.url}"`);
    expect(link).toContain('download=""');
    expect(link).toMatch(/\bh-12\b/);
    expect(text(markup)).toBe(
      'Download MP4 This browser can’t share files, so it downloads instead.',
    );
    expect(markup).not.toContain('data-slot="share-failed"');
  });

  it('failed: Download MP4, and why the video could not be fetched', async () => {
    const markup = await buttonOf({ phase: 'failed', message: 'The export file is missing.' });
    expect(tag(markup, 'data-sheet-action="download"')).toContain(`href="${TARGET.url}"`);
    expect(text(markup)).toContain('Couldn’t get the video to share: The export file is missing.');
  });
});

describe('<ShareIconButton>: the Review header’s icon for the preview video', () => {
  const PREVIEW: ShareTarget = {
    url: '/api/jobs/1e62273e8dba/preview-video.mp4?r=1',
    fileName: 'טורניר בחירות שש בש (preview).mp4',
    sizeBytes: null,
  };
  const iconOf = (flow: ShareFlow) =>
    renderAt('/jobs', <ShareIconButton flow={flow} target={PREVIEW} onShare={() => {}} />);

  it('ready: a Share icon button, 44 px, that shares the preview video', async () => {
    const markup = await iconOf({ phase: 'ready', file });
    const button = tag(markup, 'data-sheet-action="share"');
    expect(button).toMatch(/^<button/);
    expect(button).toContain('aria-label="Share the preview video"');
    expect(button).toMatch(/\bsize-11\b/);
    expect(button).not.toContain('aria-disabled');
    expect(markup).toContain('lucide-share');
    expect(markup).not.toContain('download=""');
  });

  it('sharing: a second tap does nothing', async () => {
    const markup = await iconOf({ phase: 'sharing', file });
    expect(tag(markup, 'data-sheet-action="share"')).toContain('aria-disabled="true"');
  });

  it('while the small MP4 comes in: a spinner, busy, no link', async () => {
    for (const flow of [{ phase: 'idle' }, { phase: 'getting', loaded: 1, total: null }] as const) {
      const markup = await iconOf(flow);
      const button = tag(markup, 'data-sheet-action="share-getting"');
      expect(button).toContain('aria-busy="true"');
      expect(button).toContain('aria-label="Getting the preview video…"');
      expect(markup).toContain('animate-spin');
      expect(markup).not.toContain('download=""');
    }
  });

  it('unsupported or failed: the download link, with the reason as its tooltip', async () => {
    const unsupported = tag(await iconOf({ phase: 'unsupported' }), 'data-sheet-action="download"');
    expect(unsupported).toMatch(/^<a/);
    expect(unsupported).toContain(`href="${PREVIEW.url}"`);
    expect(unsupported).toContain('download=""');
    expect(unsupported).toContain('aria-label="Download the preview video"');
    expect(unsupported).toContain(
      'title="This browser can’t share files, so it downloads instead."',
    );
    const failed = tag(
      await iconOf({ phase: 'failed', message: 'Offline' }),
      'data-sheet-action="download"',
    );
    expect(failed).toContain('title="Couldn’t get the video to share: Offline"');
  });
});

describe('<SentItCard>: "Sent it to <client>?"', () => {
  const card = (busy = false) =>
    renderAt(
      '/jobs',
      <SentItCard client="RGM" line={LINE} busy={busy} onNotYet={() => {}} onDeliver={() => {}} />,
    );

  it('asks, with the price and month, and offers Not yet and Mark delivered (board MJobSheetSent)', async () => {
    const markup = await card();
    expect(tag(markup, 'data-slot="share-sent"')).toContain('role="status"');
    expect(tag(markup, 'data-slot="share-sent"')).toContain('border-status-delivered/35');
    expect(text(markup)).toBe(`Sent it to RGM ? ${LINE} Not yet Mark delivered`);
    expect(markup).toContain('<bdi>RGM</bdi>');
    expect(tag(markup, 'data-share-answer="not-yet"')).toContain('data-variant="outline"');
    expect(tag(markup, 'data-share-answer="not-yet"')).toMatch(/\bh-11\b/);
    expect(tag(markup, 'data-share-answer="deliver"')).toContain('data-variant="default"');
    expect(markup).toContain('lucide-send');
  });

  it('waits while a request for the job is on its way', async () => {
    const markup = await card(true);
    expect(tag(markup, 'data-share-answer="not-yet"')).toContain('disabled=""');
    expect(tag(markup, 'data-share-answer="deliver"')).toContain('disabled=""');
  });
});

describe('<ShareVideoView>', () => {
  it('shows the button until the video is shared, then the question in its place', async () => {
    const ready = await renderAt('/jobs', viewOf({ phase: 'ready', file }));
    expect(ready).toContain('data-sheet-action="share"');
    expect(ready).not.toContain('data-slot="share-sent"');

    const asking = await renderAt('/jobs', viewOf({ phase: 'asking', file }));
    expect(asking).toContain('data-slot="share-sent"');
    expect(asking).not.toContain('data-sheet-action');
    expect(text(asking)).toContain(`Sent it to ${jobSheetJobs.approved.client} ?`);
  });

  it('Mark delivered sends the Mac’s deliver (its route, then its message with Undo)', () => {
    const props = propsOf({ phase: 'asking', file });
    handler(ShareVideoView(props), SentItCard, 'onDeliver')();
    expect(props.actions.run).toHaveBeenCalledWith({ kind: 'deliver', label: 'Mark delivered' });
  });

  it('Not yet goes back to Share video', () => {
    const props = propsOf({ phase: 'asking', file });
    handler(ShareVideoView(props), SentItCard, 'onNotYet')();
    expect(props.share.notYet).toHaveBeenCalledTimes(1);
    expect(props.actions.run).not.toHaveBeenCalled();
  });

  it('the button calls share from the tap itself', () => {
    const props = propsOf({ phase: 'ready', file });
    handler(ShareVideoView(props), ShareVideoButton, 'onShare')();
    expect(props.share.share).toHaveBeenCalledTimes(1);
  });

  it('explains a refused Mark delivered under the flow, as under the other big buttons', async () => {
    const props = propsOf(
      { phase: 'asking', file },
      {},
      actionsOf({ refusal: 'Already delivered.' }),
    );
    const tree = ShareVideoView(props);
    expect(tree.props).toMatchObject({ message: 'Already delivered.' });
  });
});
