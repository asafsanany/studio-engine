import type { GraphicDetail } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { graphicKey } from '@/data/graphics-query';
import { createTestQueryClient, makeGraphicDetail, makeGraphicMessage } from '@/data/test-utils';
import type { GraphicPreviewProps } from './preview-props';
import type { StudioActions } from './studio-actions';
import { ABOUT_COLUMN_WIDTH, CHAT_COLUMN_WIDTH } from './studio-columns';
import { clientWithGraphics, renderStudio, tagWith, textOf } from './test-helpers';

// GraphicPreview is GR3's. Here it only records what the studio gives it.
const previews: GraphicPreviewProps[] = [];
vi.mock('./GraphicPreview', () => ({
  GraphicPreview: (props: GraphicPreviewProps) => {
    previews.push(props);
    return <section data-slot="graphic-preview" data-version={props.shownVersion ?? undefined} />;
  },
}));

const { GraphicStudio, StudioLayout } = await import('./GraphicStudio');

const ID = '3f9a1c2b7d4e';
const DISABLED = / disabled=""/;

beforeEach(() => {
  previews.length = 0;
});

function you(id: string, text: string, refs: string[] = []) {
  return makeGraphicMessage({
    id,
    role: 'you',
    text,
    refs,
    version: null,
    status: null,
    startedAt: null,
    endedAt: null,
  });
}

/** The page of graphic `detail` in a fresh cache. */
async function open(detail: GraphicDetail, queryClient: QueryClient = clientWithGraphics()) {
  queryClient.setQueryData(graphicKey(detail.id), detail);
  return renderStudio(<GraphicStudio id={detail.id} />, queryClient, `/graphics/${detail.id}`);
}

describe('<GraphicStudio> · the layout', () => {
  it('has the chat (400 px), the preview and About (300 px) under the page’s own bar, both sized from the row', async () => {
    const html = await open(makeGraphicDetail({ id: ID }));
    expect(tagWith(html, 'data-slot="graphic-studio"')).toContain(`data-graphic-id="${ID}"`);
    expect(tagWith(html, 'aria-label="Chat"')).toContain(CHAT_COLUMN_WIDTH);
    expect(tagWith(html, 'aria-label="About this graphic"')).toContain(ABOUT_COLUMN_WIDTH);
    expect(CHAT_COLUMN_WIDTH).toContain('400px');
    expect(ABOUT_COLUMN_WIDTH).toContain('300px');
    expect(html).toContain('data-slot="graphic-preview"');
    const order = [
      'data-slot="studio-header"',
      'aria-label="Chat"',
      'data-slot="graphic-preview"',
      'aria-label="About this graphic"',
    ];
    const at = order.map((part) => html.indexOf(part));
    expect(at.every((position) => position > -1)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('fills the window under the app’s header, cancelling the page’s padding', async () => {
    const tag = tagWith(await open(makeGraphicDetail({ id: ID })), 'data-slot="graphic-studio"');
    for (const className of ['-mx-6', '-mt-6', '-mb-10', 'h-[calc(100svh-3.5rem)]']) {
      expect(tag).toContain(className);
    }
  });
});

describe('<GraphicStudio> · 4 · a new graphic', () => {
  it('is the empty studio: the starters, the composer and nothing made yet', async () => {
    const html = await renderStudio(<GraphicStudio id={undefined} />);
    expect(html).toContain('New graphic');
    expect(textOf(html)).toContain('Not made yet');
    expect(textOf(html)).toContain('What graphic do you need?');
    expect(html.match(/data-starter="/g)).toHaveLength(4);
    expect(tagWith(html, '<textarea')).toContain('placeholder="Describe the graphic you need…"');
    expect(textOf(html)).toContain(
      'Its text, when edits use it, and its details show here once v1 is ready.',
    );
    expect(html).toContain('data-slot="graphic-preview"');
    expect(previews.at(-1)).toMatchObject({
      graphic: undefined,
      shownVersion: null,
      newestVersion: null,
      making: null,
    });
  });
});

describe('<GraphicStudio> · 5 · making v1', () => {
  const detail = makeGraphicDetail({
    id: ID,
    name: 'Hours saved counter',
    kind: null,
    lengthSec: null,
    version: null,
    status: 'making',
    makingVersion: 1,
    variables: [],
    messages: [
      you('a', 'A counter for hours saved: it counts up to the number.'),
      makeGraphicMessage({
        id: 'c1',
        version: 1,
        status: 'making',
        step: 1,
        text: '',
        endedAt: null,
      }),
    ],
  });

  it('shows "Making v1…" beside the name, the box with its steps and Stop', async () => {
    const html = await open(detail);
    expect(textOf(html)).toContain('Hours saved counter');
    expect(textOf(html)).toContain('Making v1…');
    expect(textOf(html)).toContain('Making v1 About 2 min');
    expect(html).toContain('Stop</button>');
    expect(html).not.toContain('data-slot="chat-empty"');
  });

  it('makes Send wait while the version is made, and keeps the box writable', async () => {
    const html = await open(detail);
    const at = html.indexOf('Send</button>');
    expect(html.slice(html.lastIndexOf('<button', at), at)).toMatch(DISABLED);
    expect(tagWith(html, '<textarea')).not.toMatch(DISABLED);
    expect(tagWith(html, '<textarea')).toContain('placeholder="Ask for a change…"');
  });

  it('keeps About to its "once v1 is ready" line and the name from being renamed', async () => {
    const html = await open(detail);
    expect(textOf(html)).toContain('show here once v1 is ready.');
    const heading = html.slice(html.indexOf('<h1'));
    expect(tagWith(heading, 'dir="auto"')).toMatch(DISABLED);
    expect(previews.at(-1)).toMatchObject({
      shownVersion: null,
      newestVersion: null,
      making: 1,
    });
  });
});

describe('<GraphicStudio> · 6 · making a change', () => {
  const detail = makeGraphicDetail({
    id: ID,
    status: 'making',
    makingVersion: 3,
    messages: [
      you('a', 'A lower third'),
      makeGraphicMessage({ id: 'c1', version: 1, status: 'done', text: 'Made v1.' }),
      you('b', 'Slower'),
      makeGraphicMessage({ id: 'c2', version: 2, status: 'done', text: 'Made v2.' }),
      you('d', 'Make the pill dark with white text.'),
      makeGraphicMessage({
        id: 'c3',
        version: 3,
        status: 'making',
        step: 0,
        text: '',
        endedAt: null,
      }),
    ],
  });

  it('keeps v2 playing and in the status while v3 is made', async () => {
    const html = await open(detail);
    expect(textOf(html)).toContain('v2');
    expect(textOf(html)).toContain('Making v3 About 1 min');
    expect(previews.at(-1)).toMatchObject({ shownVersion: 2, newestVersion: 2, making: 3 });
  });

  it('keeps About, with its text, its When line and its details', async () => {
    const html = await open(detail);
    expect(textOf(html)).toContain('Text in it');
    expect(textOf(html)).toContain('When edits use it');
    expect(textOf(html)).toContain('Details');
  });
});

describe('<GraphicStudio> · 7 · couldn’t finish', () => {
  const detail = makeGraphicDetail({
    id: ID,
    status: 'failed',
    failedVersion: 3,
    messages: [
      you('a', 'A lower third'),
      makeGraphicMessage({ id: 'c2', version: 2, status: 'done', text: 'Made v2.' }),
      you('b', 'Put the client’s logo at the start of the pill.'),
      makeGraphicMessage({
        id: 'c3',
        version: 3,
        status: 'failed',
        text: 'At 16:9 the logo pushed the role line out of the frame. v2 is unchanged, and edits keep using it.',
        error: 'Check at 16:9: the role line ends at x=1968; the frame is 1920 wide.',
      }),
    ],
  });

  it('says it in red beside the name, and in the chat with Retry and Copy error', async () => {
    const html = await open(detail);
    expect(textOf(html)).toContain('v2 · couldn’t finish v3');
    expect(tagWith(html, 'data-tone="failed"')).toContain('text-red-300');
    expect(tagWith(html, 'data-slot="failed-box"')).toBeTruthy();
    expect(html).toContain('Retry</button>');
    expect(html).toContain('Copy error</button>');
  });

  it('keeps v2 as the version in the player and in use', async () => {
    await open(detail);
    expect(previews.at(-1)).toMatchObject({ shownVersion: 2, newestVersion: 2, making: null });
  });
});

describe('<GraphicStudio> · 8 · looking at an earlier version', () => {
  const detail = makeGraphicDetail({
    id: ID,
    version: 2,
    messages: [
      you('a', 'A lower third'),
      makeGraphicMessage({ id: 'c1', version: 1, status: 'done', text: 'Made v1.' }),
      you('b', 'Slower'),
      makeGraphicMessage({ id: 'c2', version: 2, status: 'done', text: 'Made v2.' }),
    ],
  });

  function actionsStub(): StudioActions {
    return {
      stop: vi.fn(async () => true),
      retry: vi.fn(async () => true),
      restore: vi.fn(async () => true),
      rename: vi.fn(async () => true),
      setUses: vi.fn(async () => true),
      saveWhen: vi.fn(async () => true),
      reveal: vi.fn(async () => true),
      duplicate: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
  }

  it('shows the newest version by default, and gives the preview its bar’s two actions', async () => {
    const html = await open(detail);
    expect(tagWith(html, 'title="Show v2"')).toContain('aria-pressed="true"');
    const props = previews.at(-1);
    expect(props).toMatchObject({ shownVersion: 2, newestVersion: 2, making: null });
    expect(typeof props?.onBackToNewest).toBe('function');
    expect(typeof props?.onUseOld).toBe('function');
  });

  it('shows the picked version in the chat and in the player while edits keep using the newest', async () => {
    const html = await renderStudio(
      <StudioLayout
        graphic={detail}
        actions={actionsStub()}
        deleting={false}
        initialPin={{ version: 1, newest: 2 }}
      />,
    );
    expect(tagWith(html, 'title="Show v1"')).toContain('aria-pressed="true"');
    expect(tagWith(html, 'title="Show v2"')).toContain('aria-pressed="false"');
    expect(textOf(html)).toContain('v2');
    expect(previews.at(-1)).toMatchObject({ shownVersion: 1, newestVersion: 2 });
  });

  it('"Use v1 again" asks the engine to bring the version shown back', async () => {
    const actions = actionsStub();
    await renderStudio(
      <StudioLayout
        graphic={detail}
        actions={actions}
        deleting={false}
        initialPin={{ version: 1, newest: 2 }}
      />,
    );
    previews.at(-1)?.onUseOld();
    await vi.waitFor(() => expect(actions.restore).toHaveBeenCalledWith(1));
  });

  it('asks for nothing when the newest is the one shown: edits use it already', async () => {
    const actions = actionsStub();
    await renderStudio(<StudioLayout graphic={detail} actions={actions} deleting={false} />);
    previews.at(-1)?.onUseOld();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(actions.restore).not.toHaveBeenCalled();
  });

  it('follows the newest again when the pin is stale (a newer version arrived)', async () => {
    await renderStudio(
      <StudioLayout
        graphic={detail}
        actions={actionsStub()}
        deleting={false}
        initialPin={{ version: 1, newest: 1 }}
      />,
    );
    expect(previews.at(-1)).toMatchObject({ shownVersion: 2, newestVersion: 2 });
  });

  it('gives the preview the graphic and the text of each field (the defaults until typed)', async () => {
    await open(detail);
    const props = previews.at(-1);
    expect(props?.graphic?.id).toBe(ID);
    expect(props?.values).toEqual({ name: 'דנה לוי' });
  });
});

describe('<GraphicStudio> · when the graphic is not there', () => {
  it('says "This graphic is gone" for a graphic the engine does not know', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['health'], undefined);
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: graphicKey(ID),
      queryFn: async () => makeGraphicDetail(),
    });
    query.setState({
      ...query.state,
      status: 'error',
      error: new ApiError(404, 'There is no such graphic.'),
      fetchStatus: 'idle',
      errorUpdateCount: 1,
    });
    const html = await renderStudio(<GraphicStudio id={ID} />, queryClient, `/graphics/${ID}`);
    expect(tagWith(html, 'data-slot="graphic-studio"')).toContain('data-state="gone"');
    expect(textOf(html)).toContain('This graphic is gone');
    expect(tagWith(html, 'href="/graphics"')).toBeTruthy();
    expect(textOf(html)).toContain('Back to Graphics');
    expect(html).not.toContain('data-slot="studio-composer"');
  });

  it('says "Can’t reach the engine." with Try again when the first load failed', async () => {
    const queryClient = createTestQueryClient();
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: graphicKey(ID),
      queryFn: async () => makeGraphicDetail(),
    });
    query.setState({
      ...query.state,
      status: 'error',
      error: new ApiError(0, 'Cannot reach the Studio Engine server.'),
      fetchStatus: 'idle',
      errorUpdateCount: 1,
    });
    const html = await renderStudio(<GraphicStudio id={ID} />, queryClient, `/graphics/${ID}`);
    expect(tagWith(html, 'data-slot="graphic-studio"')).toContain('data-state="unreachable"');
    expect(textOf(html)).toContain("Can't reach the engine.");
    expect(html).toContain('Try again</button>');
  });

  it('draws the three columns’ outline while the first load is on its way, with no grey blocks before a quarter of a second', async () => {
    const queryClient = clientWithGraphics();
    const html = await renderStudio(<GraphicStudio id={ID} />, queryClient, `/graphics/${ID}`);
    expect(tagWith(html, 'data-slot="graphic-studio"')).toContain('data-state="loading"');
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('data-slot="studio-composer"');
  });
});
