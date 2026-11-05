import { describe, expect, it } from 'vitest';
import { createAssignDialogStore } from './assign-dialog';
import { editorsToSend, tickedAfter } from './assign-selection';

describe('tickedAfter', () => {
  it('adds and removes a login without touching the set it was given', () => {
    const before = new Set(['yael@example.com']);
    const both = tickedAfter(before, 'amit@example.com', true);
    expect([...both].sort()).toEqual(['amit@example.com', 'yael@example.com']);
    expect([...tickedAfter(both, 'yael@example.com', false)]).toEqual(['amit@example.com']);
    expect([...before]).toEqual(['yael@example.com']);
  });
});

describe('editorsToSend', () => {
  const team = [{ email: 'yael@example.com' }, { email: 'amit@example.com' }];

  it('sends the ticked editors in the team’s order', () => {
    expect(editorsToSend(team, new Set(['amit@example.com', 'yael@example.com']))).toEqual([
      'yael@example.com',
      'amit@example.com',
    ]);
  });

  it('sends an empty list when nothing is ticked: the client is the admin’s alone', () => {
    expect(editorsToSend(team, new Set())).toEqual([]);
  });

  it('drops a login that is no longer an editor on the team', () => {
    expect(editorsToSend(team, new Set(['gone@example.com', 'yael@example.com']))).toEqual([
      'yael@example.com',
    ]);
  });
});

describe('the Assign to… dialog store', () => {
  it('opens for the client a row asked about and closes', () => {
    const store = createAssignDialogStore();
    expect(store.getState().client).toBeNull();
    store.getState().ask({ clientId: 'aaaaaaaaaaaa', name: 'Arc Fitness' });
    expect(store.getState().client).toEqual({ clientId: 'aaaaaaaaaaaa', name: 'Arc Fitness' });
    store.getState().dismiss();
    expect(store.getState().client).toBeNull();
  });
});
