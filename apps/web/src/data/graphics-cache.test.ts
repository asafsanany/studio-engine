import type { GraphicDetail, GraphicSummary } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyGraphicChanged,
  applyGraphicDetail,
  applyGraphicMessage,
  applyGraphicSummary,
  detailNeedsReload,
  reloadGraphics,
  removeGraphic,
  removeGraphicSummary,
  summaryOf,
  upsertGraphicMessage,
  upsertGraphicSummary,
} from './graphics-cache';
import { GRAPHIC_LIST_KEY, graphicKey } from './graphics-query';
import {
  createTestQueryClient,
  GRAPHIC_ID,
  makeGraphicDetail,
  makeGraphicMessage,
  makeGraphicSummary,
} from './test-utils';

const OTHER = makeGraphicSummary({
  id: '000000000002',
  name: 'Title',
  updatedAt: '2026-10-22T09:00:00.000Z',
});

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

const list = () => queryClient.getQueryData<GraphicSummary[]>(GRAPHIC_LIST_KEY);
const page = (id = GRAPHIC_ID) => queryClient.getQueryData<GraphicDetail>(graphicKey(id));

describe('the pure helpers', () => {
  it('puts a summary in the list by id, newest change first', () => {
    const pill = makeGraphicSummary();
    expect(upsertGraphicSummary([OTHER], pill)).toEqual([pill, OTHER]);
    const older = { ...pill, updatedAt: '2026-10-22T08:00:00.000Z' };
    expect(upsertGraphicSummary([pill, OTHER], older)).toEqual([OTHER, older]);
  });

  it('takes an empty graphic out of the list', () => {
    const pill = makeGraphicSummary();
    expect(upsertGraphicSummary([pill, OTHER], { ...pill, status: 'empty' })).toEqual([OTHER]);
    expect(removeGraphicSummary([pill, OTHER], pill.id)).toEqual([OTHER]);
  });

  it('puts a message in the chat in its place, or at the end when it is new', () => {
    const one = makeGraphicMessage({ id: 'a' });
    const two = makeGraphicMessage({ id: 'b' });
    const changed = { ...one, text: 'Changed.' };
    expect(upsertGraphicMessage([one, two], changed)).toEqual([changed, two]);
    const three = makeGraphicMessage({ id: 'c' });
    expect(upsertGraphicMessage([one, two], three)).toEqual([one, two, three]);
  });

  it('reads the summary of a page', () => {
    expect(summaryOf(makeGraphicDetail())).toEqual(makeGraphicSummary());
  });
});

describe('the caches', () => {
  it('leave a list and a page nobody loaded alone', () => {
    applyGraphicSummary(queryClient, makeGraphicSummary());
    applyGraphicMessage(queryClient, GRAPHIC_ID, makeGraphicMessage());
    expect(list()).toBeUndefined();
    expect(page()).toBeUndefined();
  });

  it('take a changed summary into the list and over the page, keeping its chat', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [OTHER]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const making = makeGraphicSummary({
      status: 'making',
      makingVersion: 3,
      updatedAt: '2026-10-22T11:00:00.000Z',
    });

    applyGraphicSummary(queryClient, making);

    expect(list()).toEqual([making, OTHER]);
    expect(page()).toMatchObject({ status: 'making', makingVersion: 3 });
    expect(page()?.messages).toEqual(makeGraphicDetail().messages);
  });

  it('take graphic.changed with its message into the page', () => {
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const step = makeGraphicMessage({
      id: 'm3',
      version: 3,
      status: 'making',
      step: 1,
      text: '',
      endedAt: null,
    });

    applyGraphicChanged(queryClient, {
      type: 'graphic.changed',
      graphic: makeGraphicSummary({ status: 'making', makingVersion: 3 }),
      message: step,
    });
    expect(page()?.messages.at(-1)).toEqual(step);

    applyGraphicChanged(queryClient, {
      type: 'graphic.changed',
      graphic: makeGraphicSummary({ status: 'making', makingVersion: 3 }),
      message: { ...step, step: 2 },
    });
    expect(page()?.messages.filter((message) => message.id === 'm3')).toEqual([
      { ...step, step: 2 },
    ]);
  });

  it('take how many videos used the graphic from graphic.changed into the page, without asking again', () => {
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail({ usedIn: 0 }));
    const graphic = makeGraphicSummary();

    applyGraphicChanged(queryClient, { type: 'graphic.changed', graphic, usedIn: 1 });
    expect(page()?.usedIn).toBe(1);
    applyGraphicChanged(queryClient, { type: 'graphic.changed', graphic, usedIn: 2 });
    expect(page()?.usedIn).toBe(2);
    // an event without a count (a run moved on) leaves it as it is
    applyGraphicChanged(queryClient, { type: 'graphic.changed', graphic });
    expect(page()?.usedIn).toBe(2);
    expect(queryClient.getQueryState(graphicKey(GRAPHIC_ID))?.isInvalidated).toBe(false);
  });

  it('ask for the page again when an event shows a new version, a finished or failed run, or a new name', () => {
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const state = () => queryClient.getQueryState(graphicKey(GRAPHIC_ID))?.isInvalidated;
    const done = makeGraphicMessage({ id: 'm3', version: 3, status: 'done', text: 'Made v3.' });

    // a step of a run on its way: nothing the event does not carry
    applyGraphicChanged(queryClient, {
      type: 'graphic.changed',
      graphic: makeGraphicSummary({ status: 'making', makingVersion: 3 }),
      message: { ...done, status: 'making', step: 1 },
    });
    expect(state()).toBe(false);

    // the run finished: a new version, new text in the variables and a new "when"
    applyGraphicChanged(queryClient, {
      type: 'graphic.changed',
      graphic: makeGraphicSummary({ version: 3 }),
      message: done,
    });
    expect(state()).toBe(true);
  });

  it('ask for the page again for a failed run and for a new name, not for a message it already has', () => {
    const failed = makeGraphicMessage({ id: 'm3', version: 3, status: 'failed', error: 'No.' });
    const summary = makeGraphicSummary({ status: 'failed', failedVersion: 3 });
    const detail = makeGraphicDetail();
    const event = (graphic: GraphicSummary, message = failed) =>
      ({ type: 'graphic.changed', graphic, message }) as const;

    expect(detailNeedsReload(detail, event(summary))).toBe(true);
    expect(detailNeedsReload(detail, event({ ...makeGraphicSummary(), name: 'Renamed' }))).toBe(
      true,
    );
    // the same failed row twice: the page has it already
    const withIt = { ...detail, messages: [...detail.messages, failed] };
    expect(detailNeedsReload(withIt, event(summary))).toBe(false);
    // a stopped row has nothing more to tell
    expect(detailNeedsReload(detail, event(summary, { ...failed, status: 'stopped' }))).toBe(false);
    // no page cached: nothing to refresh, the page asks when it opens
    expect(detailNeedsReload(undefined, event(summary))).toBe(false);
  });

  it('take an action’s answer as the page, and its summary into the list', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [OTHER]);
    const detail = makeGraphicDetail({ name: 'Renamed' });

    applyGraphicDetail(queryClient, detail);

    expect(page()).toEqual(detail);
    expect(list()?.map((graphic) => graphic.name)).toEqual(['Renamed', 'Title']);
  });

  it('drop a removed graphic from the list and reset its page', async () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary(), OTHER]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());

    removeGraphic(queryClient, GRAPHIC_ID);

    expect(list()).toEqual([OTHER]);
    expect(page()).toBeUndefined();
  });

  it('mark every graphics query stale on hello', async () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [OTHER]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    await reloadGraphics(queryClient);
    expect(queryClient.getQueryState(GRAPHIC_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(graphicKey(GRAPHIC_ID))?.isInvalidated).toBe(true);
  });
});
