import { describe, expect, expectTypeOf, it } from 'vitest';
import { CLIENT_STYLE_STATES, type ClientStyle, noClientStyle } from './client.ts';
import { type ServerEvent, serverEventSchema } from './events.ts';
import type { Job } from './job.ts';
import { FIX_STATUSES } from './quick-fixes.ts';
import type { ReviewNote } from './review-note.ts';
import {
  GRAPHIC_ID,
  jobsByState,
  makeClientStyle,
  makeFontFamilySummary,
  makeGenerateState,
  makeGraphicMessage,
  makeGraphicSummary,
  makeJob,
  makeLutSummary,
  makeMusicView,
  makeQuickFix,
  makeReviewNote,
  makeSeries,
  SERIES_CLIENT,
  SERIES_ID,
  seriesByState,
} from './test-fixtures.ts';

describe('ServerEvent', () => {
  it('parses hello', () => {
    expect(serverEventSchema.parse({ type: 'hello' })).toEqual({ type: 'hello' });
  });

  it('parses job.upsert for every kind of job', () => {
    for (const job of Object.values(jobsByState)) {
      const event = { type: 'job.upsert', job };
      expect(serverEventSchema.parse(event)).toEqual(event);
    }
  });

  it('parses job.remove', () => {
    expect(serverEventSchema.parse({ type: 'job.remove', id: 'a1b2c3d4e5f6' })).toEqual({
      type: 'job.remove',
      id: 'a1b2c3d4e5f6',
    });
  });

  it('parses client.upsert for a client in every style state', () => {
    for (const state of CLIENT_STYLE_STATES) {
      const event = { type: 'client.upsert', style: makeClientStyle({ state }) };
      expect(serverEventSchema.parse(event)).toEqual(event);
    }
  });

  it('parses client.upsert for a client that has no style yet', () => {
    const event = {
      type: 'client.upsert',
      style: noClientStyle('1c9823704bf5', 'Northwind Bakery'),
    };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('strips the markdown from client.upsert instead of carrying it', () => {
    const event = {
      type: 'client.upsert',
      style: { ...makeClientStyle(), markdown: '# Style: Northwind Bakery' },
    };
    expect(serverEventSchema.parse(event)).toEqual({
      type: 'client.upsert',
      style: makeClientStyle(),
    });
  });

  it('parses client.added and client.removed, Hebrew names included', () => {
    for (const type of ['client.added', 'client.removed']) {
      for (const client of ['Northwind Bakery', 'מאפיית הצפון']) {
        const event = { type, clientId: '1c9823704bf5', client };
        expect(serverEventSchema.parse(event)).toEqual(event);
      }
    }
  });

  it('parses note.upsert, Hebrew text included', () => {
    const event = {
      type: 'note.upsert',
      note: makeReviewNote({ text: 'הכותרת יורדת מהר מדי.' }),
    };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses note.remove', () => {
    const event = { type: 'note.remove', jobId: 'a1b2c3d4e5f6', noteId: 'n1' };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses money.changed, which carries nothing', () => {
    const event = { type: 'money.changed' };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses access.changed, which carries nothing', () => {
    const event = { type: 'access.changed' };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it.each(Object.values(seriesByState))('parses series.changed for a $state series', (series) => {
    const event = { type: 'series.changed', series };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses series.removed', () => {
    const event = { type: 'series.removed', seriesId: SERIES_ID, clientId: SERIES_CLIENT.clientId };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses graphic.changed, with a chat message or without', () => {
    const bare = { type: 'graphic.changed', graphic: makeGraphicSummary() };
    expect(serverEventSchema.parse(bare)).toEqual(bare);
    const withMessage = {
      type: 'graphic.changed',
      graphic: makeGraphicSummary({ status: 'making', makingVersion: 3 }),
      message: makeGraphicMessage({ id: 'm3', version: 3, status: 'making', step: 1, text: '' }),
    };
    expect(serverEventSchema.parse(withMessage)).toEqual(withMessage);
  });

  it('parses graphic.changed with how many videos used the graphic', () => {
    const event = { type: 'graphic.changed', graphic: makeGraphicSummary(), usedIn: 3 };
    expect(serverEventSchema.parse(event)).toEqual(event);
    expect(() => serverEventSchema.parse({ ...event, usedIn: -1 })).toThrow();
    expect(() => serverEventSchema.parse({ ...event, usedIn: 1.5 })).toThrow();
  });

  it('parses graphic.removed', () => {
    const event = { type: 'graphic.removed', id: GRAPHIC_ID };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses lut.changed and lut.removed', () => {
    const changed = { type: 'lut.changed', lut: makeLutSummary({ isNew: true }) };
    expect(serverEventSchema.parse(changed)).toEqual(changed);
    const removed = { type: 'lut.removed', slug: 'golden-hour-warm' };
    expect(serverEventSchema.parse(removed)).toEqual(removed);
    expect(() => serverEventSchema.parse({ type: 'lut.changed' })).toThrow();
    expect(() => serverEventSchema.parse({ type: 'lut.removed', slug: '' })).toThrow();
  });

  it('parses font.changed and font.removed', () => {
    const changed = { type: 'font.changed', family: makeFontFamilySummary({ isNew: true }) };
    expect(serverEventSchema.parse(changed)).toEqual(changed);
    const removed = { type: 'font.removed', slug: 'heebo' };
    expect(serverEventSchema.parse(removed)).toEqual(removed);
    expect(() => serverEventSchema.parse({ type: 'font.changed' })).toThrow();
    expect(() => serverEventSchema.parse({ type: 'font.removed', slug: '' })).toThrow();
  });

  it('parses font.requested: the name a note wrote, and nothing else', () => {
    const requested = { type: 'font.requested', name: 'Gotham Bold' };
    expect(serverEventSchema.parse(requested)).toEqual(requested);
    expect(() => serverEventSchema.parse({ type: 'font.requested' })).toThrow();
    expect(() => serverEventSchema.parse({ type: 'font.requested', name: '' })).toThrow();
  });

  it('parses font.request.dismissed: the id of the request, and nothing else', () => {
    const dismissed = { type: 'font.request.dismissed', id: 'a3c19e0b7d44' };
    expect(serverEventSchema.parse(dismissed)).toEqual(dismissed);
    expect(() => serverEventSchema.parse({ type: 'font.request.dismissed' })).toThrow();
    expect(() => serverEventSchema.parse({ type: 'font.request.dismissed', id: '' })).toThrow();
  });

  it('parses job.music with the job’s music, or null when it has none', () => {
    const event = { type: 'job.music', jobId: 'a1b2c3d4e5f6', music: makeMusicView() };
    expect(serverEventSchema.parse(event)).toEqual(event);
    const none = { type: 'job.music', jobId: 'a1b2c3d4e5f6', music: null };
    expect(serverEventSchema.parse(none)).toEqual(none);
  });

  it('parses job.fix for a fix in every status', () => {
    for (const status of FIX_STATUSES) {
      const event = { type: 'job.fix', jobId: 'a1b2c3d4e5f6', fix: makeQuickFix({ status }) };
      expect(serverEventSchema.parse(event)).toEqual(event);
    }
  });

  it('parses job.generate with the job’s Generate state', () => {
    const event = {
      type: 'job.generate',
      jobId: 'a1b2c3d4e5f6',
      generate: makeGenerateState(),
    };
    expect(serverEventSchema.parse(event)).toEqual(event);
  });

  it('parses client-instagram: the client whose Instagram changed, and nothing else', () => {
    const event = { type: 'client-instagram', clientId: SERIES_CLIENT.clientId };
    expect(serverEventSchema.parse(event)).toEqual(event);
    expect(() => serverEventSchema.parse({ type: 'client-instagram' })).toThrow();
    expect(() => serverEventSchema.parse({ type: 'client-instagram', clientId: '' })).toThrow();
  });

  it('parses an SSE data line (JSON text) back to the event', () => {
    const event = { type: 'job.upsert', job: makeJob() };
    expect(serverEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it.each([
    ['unknown type', { type: 'job.delete', id: 'x' }],
    ['no type', { id: 'x' }],
    ['job.upsert without a job', { type: 'job.upsert' }],
    [
      'job.upsert with an invalid job',
      { type: 'job.upsert', job: { ...makeJob(), state: 'paused' } },
    ],
    ['job.upsert with the id instead of a job', { type: 'job.upsert', id: 'x' }],
    ['job.remove without an id', { type: 'job.remove' }],
    ['job.remove with an empty id', { type: 'job.remove', id: '' }],
    ['job.remove with a job instead of an id', { type: 'job.remove', job: makeJob() }],
    ['client.upsert without a style', { type: 'client.upsert' }],
    [
      'client.upsert with an unknown state',
      { type: 'client.upsert', style: { ...makeClientStyle(), state: 'learning' } },
    ],
    [
      'client.upsert with the style fields at the top level',
      { type: 'client.upsert', ...makeClientStyle() },
    ],
    ['client.added without a client', { type: 'client.added', clientId: '1c9823704bf5' }],
    ['client.added without a clientId', { type: 'client.added', client: 'Acme' }],
    [
      'client.added with an empty name',
      { type: 'client.added', clientId: '1c9823704bf5', client: '' },
    ],
    ['client.removed without a clientId', { type: 'client.removed', client: 'Acme' }],
    [
      'client.removed with an empty clientId',
      { type: 'client.removed', clientId: '', client: 'Acme' },
    ],
    ['note.upsert without a note', { type: 'note.upsert' }],
    [
      'note.upsert with a bad note',
      { type: 'note.upsert', note: { ...makeReviewNote(), round: 0 } },
    ],
    [
      'note.upsert with the note fields at the top level',
      { type: 'note.upsert', ...makeReviewNote() },
    ],
    ['note.remove without a jobId', { type: 'note.remove', noteId: 'n1' }],
    ['note.remove with an empty jobId', { type: 'note.remove', jobId: '', noteId: 'n1' }],
    ['note.remove without a noteId', { type: 'note.remove', jobId: 'a1b2c3d4e5f6' }],
    [
      'note.remove with an empty noteId',
      { type: 'note.remove', jobId: 'a1b2c3d4e5f6', noteId: '' },
    ],
    ['series.changed without a series', { type: 'series.changed' }],
    [
      'series.changed with an unknown state',
      { type: 'series.changed', series: { ...makeSeries(), state: 'analysing' } },
    ],
    ['series.removed without a clientId', { type: 'series.removed', seriesId: SERIES_ID }],
    [
      'series.removed with an empty seriesId',
      { type: 'series.removed', seriesId: '', clientId: SERIES_CLIENT.clientId },
    ],
    ['graphic.changed without a graphic', { type: 'graphic.changed' }],
    [
      'graphic.changed with an unknown status',
      { type: 'graphic.changed', graphic: { ...makeGraphicSummary(), status: 'learning' } },
    ],
    [
      'graphic.changed with a step out of range',
      {
        type: 'graphic.changed',
        graphic: makeGraphicSummary(),
        message: { ...makeGraphicMessage({ status: 'making' }), step: 3 },
      },
    ],
    ['graphic.removed with an empty id', { type: 'graphic.removed', id: '' }],
    ['job.music without a jobId', { type: 'job.music', music: null }],
    ['job.music without music', { type: 'job.music', jobId: 'a1b2c3d4e5f6' }],
    [
      'job.music with a record but no rev',
      { type: 'job.music', jobId: 'a1b2c3d4e5f6', music: { ...makeMusicView(), rev: undefined } },
    ],
    ['job.fix without a jobId', { type: 'job.fix', fix: makeQuickFix() }],
    ['job.fix without a fix', { type: 'job.fix', jobId: 'a1b2c3d4e5f6' }],
    [
      'job.fix with an unknown status',
      { type: 'job.fix', jobId: 'a1b2c3d4e5f6', fix: { ...makeQuickFix(), status: 'stuck' } },
    ],
    ['job.generate without a jobId', { type: 'job.generate', generate: makeGenerateState() }],
    ['job.generate without a state', { type: 'job.generate', jobId: 'a1b2c3d4e5f6' }],
    [
      'job.generate with an unknown phase',
      {
        type: 'job.generate',
        jobId: 'a1b2c3d4e5f6',
        generate: { ...makeGenerateState(), phase: 'dreaming' },
      },
    ],
    ['a plain string', 'hello'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(serverEventSchema.safeParse(value).success).toBe(false);
  });

  it('narrows on type', () => {
    const event: ServerEvent = serverEventSchema.parse({ type: 'job.remove', id: 'x' });
    if (event.type === 'job.remove') expectTypeOf(event.id).toEqualTypeOf<string>();
    if (event.type === 'job.upsert') expectTypeOf(event.job).toEqualTypeOf<Job>();
    if (event.type === 'client.upsert') expectTypeOf(event.style).toEqualTypeOf<ClientStyle>();
    if (event.type === 'client.added') expectTypeOf(event.clientId).toEqualTypeOf<string>();
    if (event.type === 'client.removed') expectTypeOf(event.client).toEqualTypeOf<string>();
    if (event.type === 'note.upsert') expectTypeOf(event.note).toEqualTypeOf<ReviewNote>();
    if (event.type === 'note.remove') expectTypeOf(event.noteId).toEqualTypeOf<string>();
    expectTypeOf<ServerEvent['type']>().toEqualTypeOf<
      | 'hello'
      | 'job.upsert'
      | 'job.remove'
      | 'client.upsert'
      | 'client.added'
      | 'client.removed'
      | 'note.upsert'
      | 'note.remove'
      | 'money.changed'
      | 'series.changed'
      | 'series.removed'
      | 'graphic.changed'
      | 'graphic.removed'
      | 'lut.changed'
      | 'lut.removed'
      | 'font.changed'
      | 'font.removed'
      | 'font.requested'
      | 'font.request.dismissed'
      | 'job.music'
      | 'job.fix'
      | 'job.generate'
      | 'client-instagram'
      | 'access.changed'
    >();
  });
});
