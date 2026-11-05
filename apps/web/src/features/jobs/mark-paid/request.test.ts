import { beforeEach, describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import {
  askToMarkPaid,
  createMarkPaidRequestStore,
  type MarkPaidRequestState,
  markPaidRequestStore,
} from './request';

const delivered = makeJob({
  id: 'job-d6',
  clientId: 'client-rgm',
  client: 'RGM',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery(),
});

beforeEach(() => markPaidRequestStore.getState().close());

describe('askToMarkPaid', () => {
  it('starts with no request: no dialog is wanted', () => {
    expect(createMarkPaidRequestStore().getState().request).toBeNull();
  });

  it('sets the request: the job that was clicked, and its client', () => {
    const store = createMarkPaidRequestStore();
    askToMarkPaid(delivered, store);
    expect(store.getState().request).toEqual({
      jobId: 'job-d6',
      clientId: 'client-rgm',
      client: 'RGM',
    });
  });

  it('keeps the client’s name as it is, Hebrew included', () => {
    const store = createMarkPaidRequestStore();
    askToMarkPaid({ ...delivered, client: 'עו״ד דוד לוי' }, store);
    expect(store.getState().request?.client).toBe('עו״ד דוד לוי');
  });

  it('asks again for another job: the newest request replaces the one before', () => {
    const store = createMarkPaidRequestStore();
    askToMarkPaid(delivered, store);
    askToMarkPaid({ ...delivered, id: 'job-d7', clientId: 'client-t', client: 'Levi' }, store);
    expect(store.getState().request).toEqual({
      jobId: 'job-d7',
      clientId: 'client-t',
      client: 'Levi',
    });
  });

  it('uses the app-wide store when none is given', () => {
    askToMarkPaid(delivered);
    expect(markPaidRequestStore.getState().request?.jobId).toBe('job-d6');
  });

  it('does not carry the whole job: nothing else for the dialog to go stale on', () => {
    const store = createMarkPaidRequestStore();
    askToMarkPaid(delivered, store);
    expect(Object.keys(store.getState().request ?? {}).sort()).toEqual([
      'client',
      'clientId',
      'jobId',
    ]);
  });
});

describe('close', () => {
  it('clears the request: the dialog is done with', () => {
    const store = createMarkPaidRequestStore();
    askToMarkPaid(delivered, store);
    store.getState().close();
    expect(store.getState().request).toBeNull();
  });

  it('is fine when nothing was asked', () => {
    const store = createMarkPaidRequestStore();
    store.getState().close();
    expect(store.getState().request).toBeNull();
  });
});

describe('what the dialog’s host reads', () => {
  it('is { request, close } from the store state', () => {
    const store = createMarkPaidRequestStore();
    askToMarkPaid(delivered, store);
    const { request, close }: Pick<MarkPaidRequestState, 'request' | 'close'> = store.getState();
    expect(request?.client).toBe('RGM');
    close();
    expect(store.getState().request).toBeNull();
  });

  it('starts a store already asked, for a test that renders the host on a server', () => {
    const store = createMarkPaidRequestStore({ jobId: 'j', clientId: 'c', client: 'C' });
    expect(store.getState().request).toEqual({ jobId: 'j', clientId: 'c', client: 'C' });
  });
});
