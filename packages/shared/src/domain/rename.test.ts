import { describe, expect, it } from 'vitest';
import {
  canRename,
  JOB_NAME_MAX_LENGTH,
  jobNameProblem,
  normalizeJobName,
  RENAME_BLOCKED_STATES,
  renameBlockedReason,
  renameJobRequestSchema,
} from './rename.ts';
import { JOB_STATES } from './status.ts';

describe('canRename', () => {
  it('is false while the engine works in the folder, and true in every other state', () => {
    for (const state of JOB_STATES) {
      expect(canRename({ state }), state).toBe(!RENAME_BLOCKED_STATES.some((s) => s === state));
    }
    expect(RENAME_BLOCKED_STATES).toEqual(['arriving', 'queued', 'editing']);
  });

  it('gives a reason in words for each blocked state', () => {
    expect(renameBlockedReason({ state: 'arriving' })).toBe(
      'Wait until the files have arrived to rename this video.',
    );
    expect(renameBlockedReason({ state: 'queued' })).toBe(
      'Wait until the edit is done to rename this video.',
    );
    expect(renameBlockedReason({ state: 'editing' })).toBe(
      'Wait until the edit is done to rename this video.',
    );
  });
});

describe('normalizeJobName', () => {
  it('trims and writes the name in Unicode NFC', () => {
    expect(normalizeJobName('  Spring menu \n')).toBe('Spring menu');
    expect(normalizeJobName('Café')).toBe('Café');
  });
});

describe('jobNameProblem', () => {
  it('accepts the names folders have, Hebrew and emoji included', () => {
    for (const name of ['Spring menu', 'מיתוס או אמת 7', 'Ad 6 ✨', "Dana's cut (v2)", 'a.b']) {
      expect(jobNameProblem(name), name).toBeNull();
    }
    expect(jobNameProblem('x'.repeat(JOB_NAME_MAX_LENGTH))).toBeNull();
  });

  it('refuses an empty name, whitespace and a name that is too long', () => {
    expect(jobNameProblem('')).toBe('Type a name.');
    expect(jobNameProblem('  \t ')).toBe('Type a name.');
    expect(jobNameProblem('x'.repeat(JOB_NAME_MAX_LENGTH + 1))).toBe(
      `Use ${JOB_NAME_MAX_LENGTH} characters or fewer.`,
    );
  });

  it('refuses slashes, colons, control characters and a leading dot', () => {
    expect(jobNameProblem('a/b')).toBe('A name cannot have a slash or a colon.');
    expect(jobNameProblem('a\\b')).toBe('A name cannot have a slash or a colon.');
    expect(jobNameProblem('a:b')).toBe('A name cannot have a slash or a colon.');
    expect(jobNameProblem('a\nb')).toBe('A name cannot have a line break or a control character.');
    expect(jobNameProblem('a\u0000b')).toBe(
      'A name cannot have a line break or a control character.',
    );
    expect(jobNameProblem('.hidden')).toBe('A name cannot start with a dot.');
  });
});

describe('renameJobRequestSchema', () => {
  it('wants a name that is a string', () => {
    expect(renameJobRequestSchema.safeParse({ name: 'Summer menu' }).success).toBe(true);
    expect(renameJobRequestSchema.safeParse({ name: 7 }).success).toBe(false);
    expect(renameJobRequestSchema.safeParse({}).success).toBe(false);
  });
});
