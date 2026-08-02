import { isValidIpv4, isValidIpv6, liveTagNames, objectKey, sameStringSet, strList } from '../checkpointShared'

describe('strList', () => {
  it('handles arrays, comma strings and blanks', () => {
    expect(strList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(strList('a, b ,')).toEqual(['a', 'b'])
    expect(strList(undefined)).toEqual([])
  })
})

describe('objectKey', () => {
  it('trims and lowercases', () => {
    expect(objectKey('  Web-01 ')).toBe('web-01')
  })
})

describe('isValidIpv4', () => {
  it('accepts valid addresses', () => {
    expect(isValidIpv4('10.0.0.1')).toBe(true)
    expect(isValidIpv4('255.255.255.255')).toBe(true)
  })

  it('rejects invalid addresses', () => {
    expect(isValidIpv4('256.0.0.1')).toBe(false)
    expect(isValidIpv4('not-an-ip')).toBe(false)
  })
})

describe('isValidIpv6', () => {
  it('accepts common forms', () => {
    expect(isValidIpv6('2001:db8::1')).toBe(true)
    expect(isValidIpv6('::1')).toBe(true)
  })

  it('rejects invalid forms', () => {
    expect(isValidIpv6('not-an-ip')).toBe(false)
  })
})

describe('liveTagNames', () => {
  it('flattens string and object-summary tags', () => {
    expect(liveTagNames(['prod', { name: 'dmz' }])).toEqual(['prod', 'dmz'])
  })

  it('tolerates a missing tags array', () => {
    expect(liveTagNames(undefined)).toEqual([])
  })
})

describe('sameStringSet', () => {
  it('is order- and case-insensitive', () => {
    expect(sameStringSet(['Prod', 'dmz'], ['dmz', 'prod'])).toBe(true)
    expect(sameStringSet(['prod'], ['prod', 'dmz'])).toBe(false)
  })
})
