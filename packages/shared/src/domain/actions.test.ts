import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  JOB_ACTION_PATHS,
  JOB_ACTIONS,
  type JobAction,
  jobActionPath,
  jobActionSchema,
} from './actions.ts';

describe('JobAction', () => {
  it('lists the nine actions: the row buttons in order, then the review dialog, then Unapprove', () => {
    expect(JOB_ACTIONS).toEqual([
      'start',
      'hold',
      'release',
      'cancel',
      'resume',
      'retry',
      'send_notes',
      'approve',
      'unapprove',
    ]);
  });

  it('accepts every action', () => {
    for (const action of JOB_ACTIONS) expect(jobActionSchema.parse(action)).toBe(action);
  });

  it.each(['pause', 'Hold', 'download', 'copy-error', '', null, undefined, 1])(
    'rejects %j',
    (value) => {
      expect(jobActionSchema.safeParse(value).success).toBe(false);
    },
  );

  it('infers the union', () => {
    expectTypeOf<JobAction>().toEqualTypeOf<
      | 'start'
      | 'hold'
      | 'release'
      | 'cancel'
      | 'resume'
      | 'retry'
      | 'send_notes'
      | 'approve'
      | 'unapprove'
    >();
  });
});

describe('jobActionPath', () => {
  it.each(JOB_ACTIONS.filter((action) => action !== 'send_notes'))(
    'is the action name for %s',
    (action) => {
      expect(jobActionPath(action)).toBe(action);
    },
  );

  it('spells send_notes with a hyphen in the URL', () => {
    expect(jobActionPath('send_notes')).toBe('send-notes');
  });

  it('has one entry per action', () => {
    expect(Object.keys(JOB_ACTION_PATHS)).toEqual([...JOB_ACTIONS]);
  });
});
