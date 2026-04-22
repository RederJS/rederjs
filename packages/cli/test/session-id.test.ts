import { describe, it, expect } from 'vitest';
import { sanitizeSessionId, validateSessionId, prettifyDisplayName } from '../src/session-id.js';

describe('sanitizeSessionId', () => {
  it.each([
    ['My Project', 'my-project'],
    ['foo@bar', 'foo-bar'],
    ['--leading', 'leading'],
    ['__underscore__', 'underscore'],
    ['book_nerds', 'book_nerds'],
    ['Foo Bar Baz', 'foo-bar-baz'],
    ['  spaced  ', 'spaced'],
    ['a/b/c', 'a-b-c'],
    ['UPPER', 'upper'],
    ['9startsok', '9startsok'],
    ['-mixed_-_chars-', 'mixed_-_chars'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeSessionId(input)).toBe(expected);
  });

  it('truncates at 63 chars', () => {
    const out = sanitizeSessionId('a'.repeat(100));
    expect(out.length).toBeLessThanOrEqual(63);
  });
});

describe('validateSessionId', () => {
  it.each(['a1', 'book-nerds', 'book_nerds', '9abc', 'x'.repeat(63)])('accepts %s', (id) => {
    expect(validateSessionId(id)).toBe(true);
  });

  it.each(['', 'A', '-abc', '_abc', 'a', 'x'.repeat(64), 'foo bar', 'foo@bar'])(
    'rejects %s',
    (id) => {
      expect(validateSessionId(id)).not.toBe(true);
    },
  );
});

describe('prettifyDisplayName', () => {
  it.each([
    ['book-nerds', 'Book nerds'],
    ['my_project', 'My project'],
    ['foo', 'Foo'],
    ['a-b-c', 'A b c'],
  ])('%s → %s', (input, expected) => {
    expect(prettifyDisplayName(input)).toBe(expected);
  });
});
