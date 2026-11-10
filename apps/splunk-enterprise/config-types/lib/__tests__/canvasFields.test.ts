import { asStringList, isUnreadableList } from '../canvasFields'

describe('asStringList', () => {
  it('treats the legacy empty-string multiselect value as an empty list', () => {
    expect(asStringList('')).toEqual([])
  })

  it('treats null and undefined as an empty list', () => {
    expect(asStringList(null)).toEqual([])
    expect(asStringList(undefined)).toEqual([])
  })

  it('keeps string arrays and drops empty or non-string entries', () => {
    expect(asStringList(['main', '', 'security', 3, null])).toEqual(['main', 'security'])
  })

  it('wraps a scalar string', () => {
    expect(asStringList('main')).toEqual(['main'])
  })

  it('returns an empty list for values that are not list-like', () => {
    expect(asStringList({ a: 1 })).toEqual([])
    expect(asStringList(42)).toEqual([])
  })
})

describe('isUnreadableList', () => {
  it('accepts empty markers, strings and arrays', () => {
    expect(isUnreadableList('')).toBe(false)
    expect(isUnreadableList(null)).toBe(false)
    expect(isUnreadableList(undefined)).toBe(false)
    expect(isUnreadableList('main')).toBe(false)
    expect(isUnreadableList(['main'])).toBe(false)
  })

  it('flags objects, numbers and booleans', () => {
    expect(isUnreadableList({})).toBe(true)
    expect(isUnreadableList(7)).toBe(true)
    expect(isUnreadableList(true)).toBe(true)
  })
})
