import {
  looksLikeEmail,
  parseJsonArray,
  parseJsonObject,
  readBool,
  readOptionalNumber,
  readOptionalString,
  readString,
  readStringArray,
  stringSetsEqual,
} from '../fields'

describe('lib/fields', () => {
  it('readString trims and defaults to ""', () => {
    expect(readString('  hi  ')).toBe('hi')
    expect(readString(undefined)).toBe('')
    expect(readString(42)).toBe('')
  })

  it('readOptionalString returns undefined for blank / non-string values', () => {
    expect(readOptionalString('  hi  ')).toBe('hi')
    expect(readOptionalString('   ')).toBeUndefined()
    expect(readOptionalString(undefined)).toBeUndefined()
  })

  it('readBool tolerates booleans and string forms, else falls back', () => {
    expect(readBool(true)).toBe(true)
    expect(readBool('true')).toBe(true)
    expect(readBool('false')).toBe(false)
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool(undefined)).toBe(false)
  })

  it('readOptionalNumber parses numeric strings and rejects garbage', () => {
    expect(readOptionalNumber(7)).toBe(7)
    expect(readOptionalNumber('7.5')).toBe(7.5)
    expect(readOptionalNumber('')).toBeUndefined()
    expect(readOptionalNumber('not-a-number')).toBeUndefined()
    expect(readOptionalNumber(undefined)).toBeUndefined()
  })

  it('readStringArray accepts an array, a comma list, or a newline list, de-duped', () => {
    expect(readStringArray(['a', ' b ', 'a'])).toEqual(['a', 'b'])
    expect(readStringArray('a,b, a')).toEqual(['a', 'b'])
    expect(readStringArray('a\nb\n')).toEqual(['a', 'b'])
    expect(readStringArray(undefined)).toEqual([])
  })

  it('parseJsonObject accepts blank, an object, or a JSON string; rejects arrays/invalid JSON', () => {
    expect(parseJsonObject(undefined)).toEqual({ ok: true, value: {} })
    expect(parseJsonObject('')).toEqual({ ok: true, value: {} })
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonObject({ a: 1 })).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonObject('[1,2]').ok).toBe(false)
    expect(parseJsonObject('{bad').ok).toBe(false)
  })

  it('parseJsonArray accepts blank, an array, or a JSON array string; rejects non-arrays', () => {
    expect(parseJsonArray(undefined)).toEqual({ ok: true, value: [] })
    expect(parseJsonArray('')).toEqual({ ok: true, value: [] })
    expect(parseJsonArray('[1,2]')).toEqual({ ok: true, value: [1, 2] })
    expect(parseJsonArray([1, 2])).toEqual({ ok: true, value: [1, 2] })
    expect(parseJsonArray('{"a":1}').ok).toBe(false)
    expect(parseJsonArray('[bad').ok).toBe(false)
  })

  it('stringSetsEqual compares order-insensitively', () => {
    expect(stringSetsEqual(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(stringSetsEqual(['a'], ['a', 'b'])).toBe(false)
  })

  it('looksLikeEmail is a loose but useful shape check', () => {
    expect(looksLikeEmail('secops@example.com')).toBe(true)
    expect(looksLikeEmail('not-an-email')).toBe(false)
    expect(looksLikeEmail('missing-domain@')).toBe(false)
  })
})
