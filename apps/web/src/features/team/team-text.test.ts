import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data';
import {
  addPersonProblem,
  changeRoleLabel,
  removeTitle,
  TEAM_TEXT,
  teamErrorText,
} from './team-text';

describe('addPersonProblem', () => {
  it('asks for a name first, then a login', () => {
    expect(addPersonProblem('', '')).toBe(TEAM_TEXT.noName);
    expect(addPersonProblem('  ', 'yael@example.com')).toBe(TEAM_TEXT.noName);
    expect(addPersonProblem('Yael', ' ')).toBe(TEAM_TEXT.noEmail);
  });

  it('refuses a login with a space in it (the server would too)', () => {
    expect(addPersonProblem('Yael', 'yael @example.com')).toBe(TEAM_TEXT.badEmail);
  });

  it('lets a name and a login go; a GitHub-style login too', () => {
    expect(addPersonProblem('Yael', 'yael@example.com')).toBeNull();
    expect(addPersonProblem('יעל', 'yael@github')).toBeNull();
  });
});

describe('teamErrorText', () => {
  it('says what the server said', () => {
    expect(teamErrorText(new ApiError(409, 'yael@example.com is on the team already.'))).toBe(
      'yael@example.com is on the team already.',
    );
  });

  it('falls back to a plain line when the server said nothing', () => {
    expect(teamErrorText(new ApiError(500, ''))).toBe(TEAM_TEXT.failed);
    expect(teamErrorText(new Error('x'))).toBe(TEAM_TEXT.failed);
    expect(teamErrorText(new Error('x'), 'Nope')).toBe('Nope');
  });
});

describe('the menu words', () => {
  it('flips the role', () => {
    expect(changeRoleLabel('editor')).toBe('Make admin');
    expect(changeRoleLabel('admin')).toBe('Make editor');
  });

  it('asks before removing', () => {
    expect(removeTitle('Yael')).toBe('Remove Yael?');
  });
});
