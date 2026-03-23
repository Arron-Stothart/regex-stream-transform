import { describe, it, expect } from 'vitest';
import { compile } from './compile';
import { start, step, Program } from './vm';

/** Run the VM and check if the pattern matches the input */
function matches(prog: Program, input: string): boolean {
  let threads = start(prog, 0);

  for (let i = 0; i < input.length; i++) {
    // Check for match before consuming (handles zero-width)
    if (threads.some((t) => prog.insts[t.pc]?.op === 'match')) return true;
    threads = step(prog, threads, input[i], i);
  }

  // Check for match at end
  return threads.some((t) => prog.insts[t.pc]?.op === 'match');
}

/** Compile and match in one step */
function test(pattern: string, input: string): boolean {
  return matches(compile(pattern), input);
}

describe('compile', () => {
  describe('literals', () => {
    it('matches exact string', () => {
      expect(test('abc', 'abc')).toBe(true);
      expect(test('abc', 'ab')).toBe(false);
      expect(test('abc', 'abcd')).toBe(true); // prefix match
    });
  });

  describe('alternation', () => {
    it('matches simple alternation', () => {
      expect(test('a|b', 'a')).toBe(true);
      expect(test('a|b', 'b')).toBe(true);
      expect(test('a|b', 'c')).toBe(false);
    });

    it('matches multi-way alternation', () => {
      expect(test('a|b|c', 'a')).toBe(true);
      expect(test('a|b|c', 'b')).toBe(true);
      expect(test('a|b|c', 'c')).toBe(true);
      expect(test('a|b|c', 'd')).toBe(false);
    });

    it('matches alternation of longer strings', () => {
      expect(test('foo|bar', 'foo')).toBe(true);
      expect(test('foo|bar', 'bar')).toBe(true);
      expect(test('foo|bar', 'baz')).toBe(false);
    });

    it('handles empty alternatives', () => {
      expect(test('a|', 'a')).toBe(true);
      expect(test('a|', '')).toBe(true); // empty matches
      expect(test('|b', 'b')).toBe(true);
      expect(test('|b', '')).toBe(true);
    });

    it('works with groups', () => {
      expect(test('(a|b)', 'a')).toBe(true);
      expect(test('(a|b)', 'b')).toBe(true);
      expect(test('(a|b)', 'c')).toBe(false);
    });

    it('works with quantifiers on groups', () => {
      expect(test('(a|b)+', 'aaa')).toBe(true);
      expect(test('(a|b)+', 'bbb')).toBe(true);
      expect(test('(a|b)+', 'aba')).toBe(true);
      expect(test('(a|b)+', 'c')).toBe(false);
    });

    it('works with alternation of quantified terms', () => {
      expect(test('a+|b+', 'aaa')).toBe(true);
      expect(test('a+|b+', 'bbb')).toBe(true);
      expect(test('a+|b+', 'ab')).toBe(true); // 'a' matches a+
    });

    it('handles complex nested alternation', () => {
      expect(test('(a|b)|(c|d)', 'a')).toBe(true);
      expect(test('(a|b)|(c|d)', 'c')).toBe(true);
      expect(test('((a|b)+|(c|d)+)', 'abab')).toBe(true);
      expect(test('((a|b)+|(c|d)+)', 'cdcd')).toBe(true);
    });
  });

  describe('character classes', () => {
    it('matches character class', () => {
      expect(test('[abc]', 'a')).toBe(true);
      expect(test('[abc]', 'b')).toBe(true);
      expect(test('[abc]', 'd')).toBe(false);
    });

    it('matches ranges', () => {
      expect(test('[a-z]', 'm')).toBe(true);
      expect(test('[0-9]', '5')).toBe(true);
      expect(test('[0-9]', 'a')).toBe(false);
    });
  });

  describe('quantifiers', () => {
    it('matches star', () => {
      expect(test('a*', '')).toBe(true);
      expect(test('a*', 'aaa')).toBe(true);
    });

    it('matches plus', () => {
      expect(test('a+', '')).toBe(false);
      expect(test('a+', 'a')).toBe(true);
      expect(test('a+', 'aaa')).toBe(true);
    });

    it('matches optional', () => {
      expect(test('a?', '')).toBe(true);
      expect(test('a?', 'a')).toBe(true);
    });
  });

  describe('any', () => {
    it('matches any character', () => {
      expect(test('.', 'x')).toBe(true);
      expect(test('...', 'abc')).toBe(true);
      expect(test('...', 'ab')).toBe(false);
    });

    it('does not match newline', () => {
      expect(test('.', '\n')).toBe(false);
    });

    it('still matches regular characters', () => {
      expect(test('.', 'a')).toBe(true);
      expect(test('.', '1')).toBe(true);
      expect(test('.', ' ')).toBe(true);
    });

    it('.* stops at newline', () => {
      expect(test('.*', 'abc')).toBe(true);
      expect(test('.*', 'abc\ndef')).toBe(true); // matches 'abc' before \n
      expect(test('.*\n', 'abc\n')).toBe(true);
    });

    it('.+ does not match a string that is just a newline', () => {
      expect(test('.+', '\n')).toBe(false);
    });
  });

  describe('escapes', () => {
    it('escapes metacharacters', () => {
      expect(test('\\|', '|')).toBe(true);
      expect(test('\\*', '*')).toBe(true);
      expect(test('\\(', '(')).toBe(true);
    });

    it('special escapes match control characters', () => {
      expect(test('\\t', '\t')).toBe(true);
      expect(test('\\t', 't')).toBe(false);
      expect(test('\\n', '\n')).toBe(true);
      expect(test('\\n', 'n')).toBe(false);
      expect(test('\\r', '\r')).toBe(true);
      expect(test('\\0', '\0')).toBe(true);
      expect(test('\\0', '0')).toBe(false);
    });

    it('special escapes work inside character classes', () => {
      expect(test('[\\t\\n]', '\t')).toBe(true);
      expect(test('[\\t\\n]', '\n')).toBe(true);
      expect(test('[\\t\\n]', 'a')).toBe(false);
    });

    it('special escape in range', () => {
      expect(test('[\\t-\\r]', '\t')).toBe(true);
      expect(test('[\\t-\\r]', '\n')).toBe(true);
      expect(test('[\\t-\\r]', '\v')).toBe(true);
      expect(test('[\\t-\\r]', '\f')).toBe(true);
      expect(test('[\\t-\\r]', '\r')).toBe(true);
      expect(test('[\\t-\\r]', ' ')).toBe(false);
    });

    it('rejects unknown escapes', () => {
      expect(() => compile('\\q')).toThrow('Invalid escape \\q');
    });
  });

  describe('shorthand classes', () => {
    it('\\d matches digits, not letters', () => {
      expect(test('\\d', '0')).toBe(true);
      expect(test('\\d', '5')).toBe(true);
      expect(test('\\d', '9')).toBe(true);
      expect(test('\\d', 'a')).toBe(false);
      expect(test('\\d', 'Z')).toBe(false);
    });

    it('\\D matches letters, not digits', () => {
      expect(test('\\D', 'a')).toBe(true);
      expect(test('\\D', 'Z')).toBe(true);
      expect(test('\\D', '!')).toBe(true);
      expect(test('\\D', '0')).toBe(false);
      expect(test('\\D', '9')).toBe(false);
    });

    it('\\w matches word chars, not punctuation', () => {
      expect(test('\\w', 'a')).toBe(true);
      expect(test('\\w', 'Z')).toBe(true);
      expect(test('\\w', '0')).toBe(true);
      expect(test('\\w', '_')).toBe(true);
      expect(test('\\w', '!')).toBe(false);
      expect(test('\\w', ' ')).toBe(false);
    });

    it('\\W matches punctuation, not word chars', () => {
      expect(test('\\W', '!')).toBe(true);
      expect(test('\\W', ' ')).toBe(true);
      expect(test('\\W', 'a')).toBe(false);
      expect(test('\\W', '0')).toBe(false);
      expect(test('\\W', '_')).toBe(false);
    });

    it('\\s matches whitespace, not letters', () => {
      expect(test('\\s', ' ')).toBe(true);
      expect(test('\\s', '\t')).toBe(true);
      expect(test('\\s', '\n')).toBe(true);
      expect(test('\\s', '\r')).toBe(true);
      expect(test('\\s', '\f')).toBe(true);
      expect(test('\\s', '\v')).toBe(true);
      expect(test('\\s', 'a')).toBe(false);
    });

    it('\\S matches letters, not whitespace', () => {
      expect(test('\\S', 'a')).toBe(true);
      expect(test('\\S', '0')).toBe(true);
      expect(test('\\S', ' ')).toBe(false);
      expect(test('\\S', '\t')).toBe(false);
      expect(test('\\S', '\n')).toBe(false);
    });

    it('\\d+ works with quantifiers', () => {
      expect(test('\\d+', '12345')).toBe(true);
      expect(test('\\d+', '')).toBe(false);
      expect(test('\\d+', 'abc')).toBe(false);
    });

    it('[\\d.] works inside character classes', () => {
      expect(test('[\\d.]', '0')).toBe(true);
      expect(test('[\\d.]', '9')).toBe(true);
      expect(test('[\\d.]', '.')).toBe(true);
      expect(test('[\\d.]', 'a')).toBe(false);
    });
  });
});
