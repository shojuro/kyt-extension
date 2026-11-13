/**
 * JSON extraction from model replies (supabase/functions/_shared/json-extract.ts).
 *
 * Regression for 2026-11-13: Haiku replies began as valid JSON and then carried
 * trailing text, so JSON.parse failed with "Unexpected non-whitespace character
 * after JSON" and every entity extraction was thrown away (and re-billed).
 */
import { describe, it, expect } from 'vitest';
import { extractFirstJson, JsonExtractionError } from '../../supabase/functions/_shared/json-extract.ts';

const reasonOf = (text, opts) => {
  try {
    extractFirstJson(text, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(JsonExtractionError);
    return e.reason;
  }
  throw new Error('expected extractFirstJson to throw');
};

describe('extractFirstJson', () => {
  it('parses clean JSON', () => {
    expect(extractFirstJson('{"a":1,"b":[1,2]}')).toEqual({ a: 1, b: [1, 2] });
    expect(extractFirstJson('  \n{"a":1}\n  ')).toEqual({ a: 1 });
  });

  it('takes the object and drops prose after it (the production failure)', () => {
    const reply = '{\n  "content_category": "technical",\n  "entities": []\n}\n\nI found no entities because the turn is short.';
    expect(() => JSON.parse(reply)).toThrow(); // what the old code did
    expect(extractFirstJson(reply)).toEqual({ content_category: 'technical', entities: [] });
  });

  it('tolerates prose before the JSON', () => {
    expect(extractFirstJson('Here is the result:\n{"ok":true}')).toEqual({ ok: true });
  });

  it('reads JSON inside a code fence', () => {
    expect(extractFirstJson('```json\n{"a":{"b":2}}\n```')).toEqual({ a: { b: 2 } });
    expect(extractFirstJson('Sure.\n```\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
  });

  it('takes the first of two objects back to back', () => {
    expect(extractFirstJson('{"first":1}{"second":2}')).toEqual({ first: 1 });
    expect(extractFirstJson('{"first":1}\n{"second":2}')).toEqual({ first: 1 });
  });

  it('ignores braces, brackets and escaped quotes inside strings', () => {
    const value = { text: 'a } b { c ] [ "quoted" \\ end', next: '}' };
    expect(extractFirstJson(JSON.stringify(value) + ' trailing }')).toEqual(value);
  });

  it('returns a top-level array, unless only an object is wanted', () => {
    expect(extractFirstJson('[1,{"a":2}] and more')).toEqual([1, { a: 2 }]);
    expect(extractFirstJson('See [1]: {"a":2}', { objectOnly: true })).toEqual({ a: 2 });
  });

  it('skips a balanced non-JSON brace group in the prose', () => {
    expect(extractFirstJson('Using {placeholders} here: {"a":1}')).toEqual({ a: 1 });
  });

  it('fails cleanly on truncated JSON instead of returning an inner fragment', () => {
    expect(reasonOf('{"entities":[{"entity_text":"Ann"},{"entity_te')).toBe('truncated');
    expect(reasonOf('{"a":{"b":1}')).toBe('truncated');
    expect(reasonOf('{"a":"unterminated')).toBe('truncated');
  });

  it('fails cleanly when there is no JSON at all', () => {
    expect(reasonOf('')).toBe('empty');
    expect(reasonOf('   ')).toBe('empty');
    expect(reasonOf(undefined)).toBe('empty');
    expect(reasonOf('I cannot help with that.')).toBe('no_json');
    expect(reasonOf('{not json}')).toBe('no_json');
  });
});
