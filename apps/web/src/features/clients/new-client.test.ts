import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data';
import {
  NEW_CLIENT_TEXT,
  newClientErrorText,
  newClientInstagramFailure,
  newClientNameProblem,
} from './new-client';

describe('the words of the dialog', () => {
  it('are the work item’s', () => {
    expect(NEW_CLIENT_TEXT.title).toBe('New client');
    expect(NEW_CLIENT_TEXT.open).toBe('New client');
    expect(NEW_CLIENT_TEXT.nameLabel).toBe('Name');
    expect(NEW_CLIENT_TEXT.cancel).toBe('Cancel');
    expect(NEW_CLIENT_TEXT.create).toBe('Create');
    expect(NEW_CLIENT_TEXT.taken).toBe('A client with that name already exists.');
  });
});

describe('newClientNameProblem', () => {
  it('lets a name through, Hebrew and spaces inside included', () => {
    expect(newClientNameProblem('Brightside')).toBeNull();
    expect(newClientNameProblem('Kova Coffee')).toBeNull();
    expect(newClientNameProblem('מאפיית הצפון')).toBeNull();
    expect(newClientNameProblem('  Padded  ')).toBeNull();
  });

  it('asks for a name when there is none, or only spaces', () => {
    expect(newClientNameProblem('')).toBe('Give the client a name.');
    expect(newClientNameProblem('   ')).toBe('Give the client a name.');
  });

  it('refuses what the server refuses: / or :, a leading . or _, more than 80 characters', () => {
    expect(newClientNameProblem('a/b')).not.toBeNull();
    expect(newClientNameProblem('a:b')).not.toBeNull();
    expect(newClientNameProblem('.hidden')).not.toBeNull();
    expect(newClientNameProblem('_Style')).not.toBeNull();
    expect(newClientNameProblem('x'.repeat(80))).toBeNull();
    expect(newClientNameProblem('x'.repeat(81))).not.toBeNull();
  });
});

describe('newClientErrorText', () => {
  it('says what the server said about a name it can’t use (400)', () => {
    expect(newClientErrorText(new ApiError(400, 'A client name can’t contain / or :.'))).toBe(
      'A client name can’t contain / or :.',
    );
  });

  it('says the name is taken for a 409, whatever the server wrote', () => {
    expect(newClientErrorText(new ApiError(409, 'Conflict'))).toBe(
      'A client with that name already exists.',
    );
    expect(newClientErrorText(new ApiError(409, 'A client with that name already exists.'))).toBe(
      'A client with that name already exists.',
    );
  });

  it('says the server could not be reached when it could not', () => {
    expect(newClientErrorText(new ApiError(0, 'Cannot reach the Studio Engine server.'))).toBe(
      'Cannot reach the Studio Engine server.',
    );
  });

  it('has words for a failure that has none of its own', () => {
    expect(newClientErrorText(new ApiError(500, ''))).toBe('Couldn’t create the client.');
    expect(newClientErrorText(new Error('boom'))).toBe('Couldn’t create the client.');
    expect(newClientErrorText('boom')).toBe('Couldn’t create the client.');
  });
});

describe('newClientInstagramFailure', () => {
  it('says the client was created, what the server said, and where to add it again', () => {
    expect(
      newClientInstagramFailure(
        new ApiError(501, 'That part of Clients × Instagram is not built yet.'),
      ),
    ).toBe(
      'The client was created, but its Instagram was not saved. That part of Clients × Instagram is not built yet. Add it from the client’s menu.',
    );
  });

  it('still says it for a failure with no words of its own', () => {
    expect(newClientInstagramFailure(null)).toBe(
      'The client was created, but its Instagram was not saved. Add it from the client’s menu.',
    );
    expect(newClientInstagramFailure(new ApiError(500, ''))).toBe(
      'The client was created, but its Instagram was not saved. Add it from the client’s menu.',
    );
  });
});
