import {
  boolFlag,
  compactBody,
  resolveAkeylessBaseUrl,
  resolveAkeylessCredentials,
  sameStringSet,
  stableStringify,
  toStringList,
} from '../akeyless'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

describe('resolveAkeylessBaseUrl', () => {
  it('defaults to the public SaaS control plane for blank input', () => {
    expect(resolveAkeylessBaseUrl('')).toBe('https://api.akeyless.io')
    expect(resolveAkeylessBaseUrl(undefined)).toBe('https://api.akeyless.io')
    expect(resolveAkeylessBaseUrl(null)).toBe('https://api.akeyless.io')
  })
  it('adds an https:// scheme to a bare host', () => {
    expect(resolveAkeylessBaseUrl('api.akeyless.io')).toBe('https://api.akeyless.io')
  })
  it('leaves a full URL with a scheme untouched (minus a trailing slash)', () => {
    expect(resolveAkeylessBaseUrl('https://gw.example.com/')).toBe('https://gw.example.com')
  })
  it('preserves an explicit http:// scheme for a private gateway', () => {
    expect(resolveAkeylessBaseUrl('http://gw.internal:8080')).toBe('http://gw.internal:8080')
  })
})

describe('resolveAkeylessCredentials', () => {
  const cred = (over: Partial<CredentialRef>): CredentialRef => ({
    id: 'c1',
    name: 'cred',
    username: '',
    password: '',
    apiToken: null,
    certificate: null,
    ...over,
  })

  it('prefers apiToken over password for the access key', () => {
    const result = resolveAkeylessCredentials(cred({ username: 'p-abc123', apiToken: 'key-1', password: 'key-2' }))
    expect(result).toEqual({ accessId: 'p-abc123', accessKey: 'key-1' })
  })
  it('falls back to password when apiToken is absent', () => {
    const result = resolveAkeylessCredentials(cred({ username: 'p-abc123', apiToken: null, password: 'key-2' }))
    expect(result).toEqual({ accessId: 'p-abc123', accessKey: 'key-2' })
  })
  it('returns null when username is blank', () => {
    expect(resolveAkeylessCredentials(cred({ username: '  ', apiToken: 'key' }))).toBeNull()
  })
  it('returns null when no secret is available', () => {
    expect(resolveAkeylessCredentials(cred({ username: 'p-abc123', apiToken: null, password: '' }))).toBeNull()
  })
  it('returns null for a null credential', () => {
    expect(resolveAkeylessCredentials(null)).toBeNull()
  })
})

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
  it('handles nested arrays and objects', () => {
    expect(stableStringify({ b: [{ y: 1, x: 2 }], a: 1 })).toBe('{"a":1,"b":[{"x":2,"y":1}]}')
  })
  it('produces the same string regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })
})

describe('boolFlag', () => {
  it('returns "true" for boolean true and string "true"', () => {
    expect(boolFlag(true)).toBe('true')
    expect(boolFlag('true')).toBe('true')
  })
  it('returns "false" for everything else', () => {
    expect(boolFlag(false)).toBe('false')
    expect(boolFlag('false')).toBe('false')
    expect(boolFlag(undefined)).toBe('false')
    expect(boolFlag(null)).toBe('false')
    expect(boolFlag(0)).toBe('false')
  })
})

describe('toStringList', () => {
  it('trims and dedupes array entries', () => {
    expect(toStringList([' a ', '', 'b', 'a'])).toEqual(['a', 'b'])
  })
  it('splits comma/newline separated strings', () => {
    expect(toStringList('a, b\nc')).toEqual(['a', 'b', 'c'])
  })
  it('returns an empty array for undefined/null', () => {
    expect(toStringList(undefined)).toEqual([])
    expect(toStringList(null)).toEqual([])
  })
})

describe('compactBody', () => {
  it('strips undefined, null, empty-string and empty-array values', () => {
    expect(compactBody({ a: 'x', b: undefined, c: null, d: '', e: [], f: 0, g: false, h: ['x'] })).toEqual({
      a: 'x',
      f: 0,
      g: false,
      h: ['x'],
    })
  })
})

describe('sameStringSet', () => {
  it('is order-insensitive', () => {
    expect(sameStringSet(['a', 'b'], ['b', 'a'])).toBe(true)
  })
  it('detects a size mismatch', () => {
    expect(sameStringSet(['a'], ['a', 'b'])).toBe(false)
  })
  it('detects a content mismatch of the same size', () => {
    expect(sameStringSet(['a', 'b'], ['a', 'c'])).toBe(false)
  })
})
