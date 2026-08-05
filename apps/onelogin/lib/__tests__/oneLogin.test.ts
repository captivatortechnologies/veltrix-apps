import {
  parseLinkHeaderNext,
  reconcileOrder,
  resolveOneLoginCredentials,
  resolveOneLoginDomain,
  stableStringify,
} from '../oneLogin'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

describe('resolveOneLoginDomain', () => {
  it('appends .onelogin.com to a bare subdomain', () => {
    expect(resolveOneLoginDomain('acme')).toBe('acme.onelogin.com')
  })
  it('leaves a full domain untouched', () => {
    expect(resolveOneLoginDomain('acme.onelogin.com')).toBe('acme.onelogin.com')
  })
  it('strips a leading https:// scheme', () => {
    expect(resolveOneLoginDomain('https://acme.onelogin.com')).toBe('acme.onelogin.com')
  })
  it('strips a trailing slash', () => {
    expect(resolveOneLoginDomain('acme.onelogin.com/')).toBe('acme.onelogin.com')
  })
  it('returns null for blank input', () => {
    expect(resolveOneLoginDomain('')).toBeNull()
    expect(resolveOneLoginDomain(undefined)).toBeNull()
    expect(resolveOneLoginDomain(null)).toBeNull()
    expect(resolveOneLoginDomain('   ')).toBeNull()
  })
})

describe('resolveOneLoginCredentials', () => {
  const cred = (over: Partial<CredentialRef>): CredentialRef => ({
    id: 'c1',
    name: 'cred',
    username: '',
    password: '',
    apiToken: null,
    certificate: null,
    ...over,
  })

  it('prefers apiToken over password for the client secret', () => {
    const result = resolveOneLoginCredentials(cred({ username: 'client-id', apiToken: 'secret-1', password: 'secret-2' }))
    expect(result).toEqual({ clientId: 'client-id', clientSecret: 'secret-1' })
  })
  it('falls back to password when apiToken is absent', () => {
    const result = resolveOneLoginCredentials(cred({ username: 'client-id', apiToken: null, password: 'secret-2' }))
    expect(result).toEqual({ clientId: 'client-id', clientSecret: 'secret-2' })
  })
  it('returns null when username is blank', () => {
    expect(resolveOneLoginCredentials(cred({ username: '  ', apiToken: 'secret' }))).toBeNull()
  })
  it('returns null when no secret is available', () => {
    expect(resolveOneLoginCredentials(cred({ username: 'client-id', apiToken: null, password: '' }))).toBeNull()
  })
  it('returns null for a null credential', () => {
    expect(resolveOneLoginCredentials(null)).toBeNull()
  })
})

describe('parseLinkHeaderNext', () => {
  it('extracts the rel="next" URL', () => {
    const header = '<https://acme.onelogin.com/api/2/apps?limit=5&page=2>; rel="next"'
    expect(parseLinkHeaderNext(header)).toBe('https://acme.onelogin.com/api/2/apps?limit=5&page=2')
  })
  it('picks next out of multiple comma-separated links', () => {
    const header =
      '<https://acme.onelogin.com/api/2/apps?page=1>; rel="prev", <https://acme.onelogin.com/api/2/apps?page=3>; rel="next"'
    expect(parseLinkHeaderNext(header)).toBe('https://acme.onelogin.com/api/2/apps?page=3')
  })
  it('returns null when there is no next link', () => {
    const header = '<https://acme.onelogin.com/api/2/apps?page=1>; rel="prev"'
    expect(parseLinkHeaderNext(header)).toBeNull()
  })
  it('returns null for a null header', () => {
    expect(parseLinkHeaderNext(null)).toBeNull()
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

describe('reconcileOrder', () => {
  it('appends managed ids at the end when none pre-existed', () => {
    expect(reconcileOrder(['u1', 'u2'], ['m1', 'm2'])).toEqual(['u1', 'u2', 'm1', 'm2'])
  })

  it('re-inserts managed ids at the position of the first pre-existing managed id', () => {
    // live order: u1, m1, u2, m2, u3 -- managed = [m1, m2], declared order [m2, m1]
    const live = ['u1', 'm1', 'u2', 'm2', 'u3']
    expect(reconcileOrder(live, ['m2', 'm1'])).toEqual(['u1', 'm2', 'm1', 'u2', 'u3'])
  })

  it('leaves unmanaged ids in their original relative order', () => {
    const live = ['u1', 'u2', 'u3']
    const result = reconcileOrder(live, [])
    expect(result).toEqual(['u1', 'u2', 'u3'])
  })

  it('handles a mix of pre-existing and brand-new managed ids', () => {
    // m1 pre-exists at index 1; m2 is brand new (not in live)
    const live = ['u1', 'm1', 'u2']
    expect(reconcileOrder(live, ['m1', 'm2'])).toEqual(['u1', 'm1', 'm2', 'u2'])
  })

  it('is a no-op when every id is already in its managed-declared relative order at the front', () => {
    const live = ['m1', 'm2', 'u1']
    expect(reconcileOrder(live, ['m1', 'm2'])).toEqual(['m1', 'm2', 'u1'])
  })

  it('handles an empty live order with new managed ids', () => {
    expect(reconcileOrder([], ['m1', 'm2'])).toEqual(['m1', 'm2'])
  })
})
