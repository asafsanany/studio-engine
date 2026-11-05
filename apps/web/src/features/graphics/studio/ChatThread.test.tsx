import type { GraphicMessage } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeGraphicMessage } from '@/data/test-utils';
import { ChatThread } from './ChatThread';
import { chatRows, chatSignature } from './studio-logic';
import { renderStudio, tagWith, textOf } from './test-helpers';

/** The attribute a disabled button carries (its class list says `disabled:` too). */
const DISABLED = / disabled=""/;

type Props = Partial<React.ComponentProps<typeof ChatThread>>;

async function thread(messages: readonly GraphicMessage[], props: Props = {}): Promise<string> {
  return renderStudio(
    <ChatThread
      rows={chatRows(messages)}
      signature={chatSignature(messages)}
      shown={null}
      making={false}
      offline={false}
      onShow={() => {}}
      onStop={() => {}}
      onRetry={() => {}}
      onStarter={() => {}}
      {...props}
    />,
  );
}

const you = (id: string, text: string, refs: string[] = []): GraphicMessage =>
  makeGraphicMessage({
    id,
    role: 'you',
    text,
    refs,
    version: null,
    status: null,
    startedAt: null,
    endedAt: null,
  });

const done = (id: string, version: number, text: string, took = 58): GraphicMessage =>
  makeGraphicMessage({
    id,
    version,
    status: 'done',
    text,
    startedAt: '2026-10-22T10:00:00.000Z',
    endedAt: new Date(Date.parse('2026-10-22T10:00:00.000Z') + took * 1000).toISOString(),
  });

/** The opening tag of the button that says `label`. */
function buttonSaying(html: string, label: string): string {
  const at = html.indexOf(`${label}</button>`);
  expect(at, label).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<button', at);
  return html.slice(open, html.indexOf('>', open) + 1);
}

describe('<ChatThread> · 4 · a new graphic', () => {
  it('asks what graphic is needed and offers the four starters', async () => {
    const html = await thread([]);
    expect(html).toContain('data-slot="chat-empty"');
    expect(html).toContain('What graphic do you need?');
    expect(html).toContain('Describe it in your own words.');
    expect(html).toContain('Or start from');
    const labels = [
      'A lower third for a name',
      'A big number that counts up',
      'An opening title',
      'An end card with a Follow button',
    ];
    for (const label of labels) expect(html, label).toContain(label);
    const positions = labels.map((label) => html.indexOf(label));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html.match(/data-starter="/g)).toHaveLength(4);
  });

  it('shows no empty state once there are messages', async () => {
    expect(await thread([you('a', 'A lower third')])).not.toContain('data-slot="chat-empty"');
  });
});

describe('<ChatThread> · 5 · making v1', () => {
  const messages = [
    you('a', 'A counter for hours saved.'),
    makeGraphicMessage({ id: 'c', version: 1, status: 'making', step: 1, text: '', endedAt: null }),
  ];

  it('shows the box with its three steps, the time and Stop', async () => {
    const html = await thread(messages);
    const box = html.slice(html.indexOf('data-slot="making-box"'));
    expect(tagWith(html, 'data-slot="making-box"')).toContain('data-version="1"');
    expect(textOf(box)).toContain('Making v1');
    expect(textOf(box)).toContain('About 2 min');
    expect(textOf(box)).toContain(
      'Reading your request Building the graphic Checking it at 9:16, 16:9 and 1:1',
    );
    expect(box.indexOf('Reading your request')).toBeLessThan(box.indexOf('Building the graphic'));
    expect(textOf(box)).toContain('Stop');
  });

  it('marks the first step done, the second working and the third waiting', async () => {
    const html = await thread(messages);
    expect(html.match(/data-step="(\w+)"/g)).toEqual([
      'data-step="done"',
      'data-step="running"',
      'data-step="waiting"',
    ]);
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain('aria-label="Waiting"');
  });

  it('has no reply, version chip or failure box', async () => {
    const html = await thread(messages);
    expect(html).not.toContain('title="Show v1"');
    expect(html).not.toContain('data-slot="failed-box"');
  });
});

describe('<ChatThread> · 6 · making a change', () => {
  const messages = [
    you('a', 'A lower third'),
    done('c1', 1, 'Made v1.'),
    you('b', 'Slower'),
    done('c2', 2, 'Made v2. Slower.'),
    you('d', 'Make the pill dark with white text.'),
    makeGraphicMessage({ id: 'c3', version: 3, status: 'making', step: 0, text: '' }),
  ];

  it('says Making v3 with the words of a change and about a minute', async () => {
    const html = await thread(messages);
    const box = textOf(html.slice(html.indexOf('data-slot="making-box"')));
    expect(box).toContain('Making v3');
    expect(box).toContain('About 1 min');
    expect(box).toContain('Reading your note Changing the graphic');
  });

  it('keeps the earlier versions as chips', async () => {
    const html = await thread(messages, { shown: 2 });
    expect(html).toContain('title="Show v1"');
    expect(html).toContain('title="Show v2"');
  });

  it('keeps Stop working while the engine is reachable, and waits when it is not', async () => {
    expect(buttonSaying(await thread(messages), 'Stop')).not.toMatch(DISABLED);
    expect(buttonSaying(await thread(messages, { offline: true }), 'Stop')).toMatch(DISABLED);
  });

  it('shows Stop as busy while its request is on the way', async () => {
    const html = await thread(messages, { pendingId: 'c3' });
    const stop = buttonSaying(html, 'Stop');
    expect(stop).toMatch(DISABLED);
    expect(stop).toContain('aria-busy="true"');
  });
});

describe('<ChatThread> · 7 · couldn’t finish', () => {
  const messages = [
    you('a', 'A lower third'),
    done('c2', 2, 'Made v2.'),
    you('b', 'Put the client’s logo at the start of the pill.'),
    makeGraphicMessage({
      id: 'c3',
      version: 3,
      status: 'failed',
      text: 'At 16:9 the logo pushed the role line out of the frame. v2 is unchanged, and edits keep using it.',
      error: 'Check at 16:9: the role line ends at x=1968; the frame is 1920 wide.',
    }),
  ];

  it('shows the red box with why, Retry and Copy error', async () => {
    const html = await thread(messages);
    const box = html.slice(html.indexOf('data-slot="failed-box"'));
    expect(tagWith(html, 'data-slot="failed-box"')).toContain('border-[#F87171]');
    expect(textOf(box)).toContain('Couldn’t finish v3');
    expect(textOf(box)).toContain('At 16:9 the logo pushed the role line out of the frame.');
    expect(box).toContain('Retry</button>');
    expect(box).toContain('Copy error</button>');
  });

  it('says v2 is unchanged and edits keep using it, when the reason does not', async () => {
    const html = await thread([
      you('a', 'A lower third'),
      done('c2', 2, 'Made v2.'),
      you('b', 'A logo.'),
      makeGraphicMessage({
        id: 'c3',
        version: 3,
        status: 'failed',
        text: '',
        error: 'Check at 16:9: the role line ends at x=1968; the frame is 1920 wide.',
      }),
    ]);
    const box = textOf(html.slice(html.indexOf('data-slot="failed-box"')));
    expect(box).toContain(
      'Check at 16:9: the role line ends at x=1968; the frame is 1920 wide. v2 is unchanged, and edits keep using it.',
    );
    // said once, when the reply already says it
    expect(textOf(await thread(messages)).split('v2 is unchanged').length - 1).toBe(1);
  });

  it('lets Retry work, and makes it wait while a version is being made or the engine is out of reach', async () => {
    expect(buttonSaying(await thread(messages), 'Retry')).not.toMatch(DISABLED);
    expect(buttonSaying(await thread(messages, { making: true }), 'Retry')).toMatch(DISABLED);
    expect(buttonSaying(await thread(messages, { offline: true }), 'Retry')).toMatch(DISABLED);
    expect(buttonSaying(await thread(messages, { pendingId: 'c3' }), 'Retry')).toContain(
      'disabled',
    );
  });

  it('still lists v2 as the version in use', async () => {
    expect(await thread(messages, { shown: 2 })).toContain('· showing');
  });
});

describe('<ChatThread> · stopped', () => {
  it('says which version is unchanged and offers Retry', async () => {
    const html = await thread([
      you('a', 'A lower third'),
      done('c1', 1, 'Made v1.'),
      done('c2', 2, 'Made v2.'),
      you('b', 'Bigger'),
      makeGraphicMessage({ id: 'c3', version: 3, status: 'stopped', text: '', error: null }),
    ]);
    expect(textOf(html)).toContain('Stopped. v2 is unchanged.');
    expect(html).toContain('Retry</button>');
  });

  it('says nothing was made when the first run was stopped', async () => {
    const html = await thread([
      you('a', 'A lower third'),
      makeGraphicMessage({ id: 'c1', version: 1, status: 'stopped', text: '', error: null }),
    ]);
    expect(textOf(html)).toContain('Stopped. Nothing was made yet.');
  });
});

describe('<ChatThread> · 8 · an earlier version', () => {
  const messages = [
    you('a', 'A lower third'),
    done('c1', 1, 'Made v1. A white pill.', 112),
    you('b', 'Slower'),
    done('c2', 2, 'Made v2. Slower.', 70),
  ];

  it('marks the version shown with "· showing" and presses its chip', async () => {
    const html = await thread(messages, { shown: 1 });
    const first = tagWith(html, 'title="Show v1"');
    const second = tagWith(html, 'title="Show v2"');
    expect(first).toContain('aria-pressed="true"');
    expect(second).toContain('aria-pressed="false"');
    expect(html.match(/· showing/g)).toHaveLength(1);
    expect(html.indexOf('· showing')).toBeGreaterThan(html.indexOf('title="Show v1"'));
    expect(html.indexOf('· showing')).toBeLessThan(html.indexOf('title="Show v2"'));
  });

  it('marks the newest when nothing older is picked', async () => {
    const html = await thread(messages, { shown: 2 });
    expect(tagWith(html, 'title="Show v2"')).toContain('aria-pressed="true"');
    expect(tagWith(html, 'title="Show v1"')).toContain('aria-pressed="false"');
  });

  it('says how long each version took', async () => {
    const text = textOf(await thread(messages));
    expect(text).toContain('1 min 52 s');
    expect(text).toContain('1 min 10 s');
  });

  it('shows a version brought back by "Use vN again" as a reply with its own chip', async () => {
    const html = await thread(
      [
        ...messages,
        makeGraphicMessage({
          id: 'c3',
          version: 3,
          status: 'done',
          text: 'v1 is back, as v3.',
          startedAt: null,
          endedAt: null,
        }),
      ],
      { shown: 3 },
    );
    expect(textOf(html)).toContain('v1 is back, as v3.');
    expect(tagWith(html, 'title="Show v3"')).toContain('aria-pressed="true"');
  });
});

describe('<ChatThread> · your messages', () => {
  it('right-aligns the bubble and gives it its own text direction', async () => {
    const html = await thread([you('a', 'שלום, כותרת קטנה')]);
    const tag = tagWith(html, 'data-slot="your-message"');
    expect(tag).toContain('self-end');
    expect(html).toContain('dir="auto"');
    expect(html).toContain('שלום, כותרת קטנה');
    expect(html).toContain('whitespace-pre-wrap');
  });

  it('shows each attached file as a chip above the bubble', async () => {
    const html = await thread([you('a', 'Like this one', ['lower-third-I-like.png', 'clip.mov'])]);
    expect(html.match(/data-slot="file-chip"/g)).toHaveLength(2);
    expect(html).toContain('lower-third-I-like.png');
    expect(html).toContain('clip.mov');
    expect(html.indexOf('clip.mov')).toBeLessThan(html.indexOf('Like this one'));
  });

  it('shows a message that is only files with chips and no empty bubble', async () => {
    const html = await thread([you('a', '', ['logo.png'])]);
    expect(html).toContain('logo.png');
    expect(html).not.toContain('whitespace-pre-wrap');
  });

  it('labels each of Claude’s rows', async () => {
    const html = await thread([you('a', 'x'), done('c', 1, 'Made v1.')]);
    expect(textOf(html)).toContain('Claude Made v1.');
  });
});
