import {
  buildXrayClient,
  MISSING_CREDENTIAL_MESSAGE,
  MISSING_ENDPOINT_MESSAGE,
  normalizeHost,
  parseJson,
  readXraySettings,
  resolveXrayToken,
  xrayErrorMessage,
} from '../xrayApi'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function credential(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return { id: 'cred-1', name: 'Test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

describe('lib/xrayApi', () => {
  it('resolveXrayToken reads apiToken, falls back to password, else null', () => {
    expect(resolveXrayToken(credential({ apiToken: 'tok-123' }))).toBe('tok-123')
    expect(resolveXrayToken(credential({ apiToken: null, password: 'legacy-tok' }))).toBe('legacy-tok')
    expect(resolveXrayToken(credential({ apiToken: '  ' }))).toBeNull()
    expect(resolveXrayToken(null)).toBeNull()
  })

  it('normalizeHost strips scheme, path and trailing slash', () => {
    expect(normalizeHost('https://mycompany.jfrog.io/')).toBe('mycompany.jfrog.io')
    expect(normalizeHost('mycompany.jfrog.io/artifactory')).toBe('mycompany.jfrog.io')
    expect(normalizeHost('  MyCompany.jfrog.io  ')).toBe('mycompany.jfrog.io')
    expect(normalizeHost(undefined)).toBeNull()
    expect(normalizeHost('')).toBeNull()
  })

  it('readXraySettings applies a default timeout and honors an override', () => {
    expect(readXraySettings({}).timeoutMs).toBe(30_000)
    expect(readXraySettings({ request_timeout_seconds: 5 }).timeoutMs).toBe(5_000)
    expect(readXraySettings({ request_timeout_seconds: -1 }).timeoutMs).toBe(30_000)
    expect(readXraySettings({ request_timeout_seconds: 'nope' }).timeoutMs).toBe(30_000)
  })

  it('buildXrayClient reports a missing-credential error before a missing-endpoint error', () => {
    const result = buildXrayClient('mycompany.jfrog.io', null, {})
    expect('error' in result && result.error).toBe(MISSING_CREDENTIAL_MESSAGE)
  })

  it('buildXrayClient reports a missing-endpoint error when the credential is present', () => {
    const result = buildXrayClient(undefined, credential({ apiToken: 'tok' }), {})
    expect('error' in result && result.error).toBe(MISSING_ENDPOINT_MESSAGE)
  })

  it('buildXrayClient succeeds with a token and a hostname', () => {
    const result = buildXrayClient('mycompany.jfrog.io', credential({ apiToken: 'tok' }), {})
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.host).toBe('mycompany.jfrog.io')
      expect(result.client.baseUrl).toBe('https://mycompany.jfrog.io/xray')
    }
  })

  it('parseJson returns null instead of throwing on malformed content', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson('')).toBeNull()
    expect(parseJson('{bad')).toBeNull()
  })

  it('xrayErrorMessage prefers the {error} envelope, then {message}, then the raw body', () => {
    expect(xrayErrorMessage({ status: 400, ok: false, body: '{"error":"Policy is assigned to 2 watches"}' })).toBe('Policy is assigned to 2 watches')
    expect(xrayErrorMessage({ status: 500, ok: false, body: '{"message":"internal error"}' })).toBe('internal error')
    expect(xrayErrorMessage({ status: 502, ok: false, body: 'Bad Gateway' })).toBe('Bad Gateway')
    expect(xrayErrorMessage({ status: 502, ok: false, body: '' })).toBe('HTTP 502')
  })
})
