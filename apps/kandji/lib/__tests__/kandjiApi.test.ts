import {
  readKandjiSettings,
  resolveKandjiToken,
  buildKandjiClient,
  kandjiErrorMessage,
  parseJson,
  MISSING_CREDENTIAL_MESSAGE,
  MISSING_ENDPOINT_MESSAGE,
} from '../kandjiApi'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

describe('Kandji API client helpers', () => {
  it('readKandjiSettings defaults timeout and page size', () => {
    const s = readKandjiSettings({})
    expect(s.timeoutMs).toBe(30_000)
    expect(s.pageSize).toBe(100)
  })

  it('readKandjiSettings reads overrides', () => {
    const s = readKandjiSettings({ request_timeout_seconds: 10, page_size: 50 })
    expect(s.timeoutMs).toBe(10_000)
    expect(s.pageSize).toBe(50)
  })

  it('readKandjiSettings ignores malformed values', () => {
    expect(readKandjiSettings({ request_timeout_seconds: -5, page_size: 'lots' }).timeoutMs).toBe(30_000)
    expect(readKandjiSettings({ page_size: -1 }).pageSize).toBe(100)
  })

  it('resolveKandjiToken prefers apiToken over password', () => {
    expect(resolveKandjiToken(cred({ apiToken: 'tok-1', password: 'pw-1' }))).toBe('tok-1')
  })

  it('resolveKandjiToken falls back to password when apiToken is absent', () => {
    expect(resolveKandjiToken(cred({ apiToken: null, password: 'pw-1' }))).toBe('pw-1')
  })

  it('resolveKandjiToken returns null with no usable secret', () => {
    expect(resolveKandjiToken(cred({ apiToken: null, password: '' }))).toBeNull()
    expect(resolveKandjiToken(null)).toBeNull()
  })

  it('buildKandjiClient errors without a credential', () => {
    const result = buildKandjiClient('acme.api.kandji.io', null, {})
    expect('error' in result && result.error).toBe(MISSING_CREDENTIAL_MESSAGE)
  })

  it('buildKandjiClient errors without an endpoint', () => {
    const result = buildKandjiClient(undefined, cred({ apiToken: 'tok' }), {})
    expect('error' in result && result.error).toBe(MISSING_ENDPOINT_MESSAGE)
  })

  it('buildKandjiClient strips a scheme and trailing slash from the hostname', () => {
    const result = buildKandjiClient('https://acme.api.kandji.io/', cred({ apiToken: 'tok' }), {})
    expect('client' in result && result.baseUrl).toBe('https://acme.api.kandji.io')
  })

  it('buildKandjiClient supports an EU-region hostname verbatim', () => {
    const result = buildKandjiClient('acme.api.eu.kandji.io', cred({ apiToken: 'tok' }), {})
    expect('client' in result && result.baseUrl).toBe('https://acme.api.eu.kandji.io')
  })

  it('parseJson tolerates malformed or empty input', () => {
    expect(parseJson('not json')).toBeNull()
    expect(parseJson('')).toBeNull()
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('kandjiErrorMessage reads a DRF "detail" envelope', () => {
    expect(kandjiErrorMessage(404, JSON.stringify({ detail: 'Not found.' }))).toBe('HTTP 404: Not found.')
  })

  it('kandjiErrorMessage reads field-level validation errors', () => {
    const body = JSON.stringify({ name: ['This field is required.'], execution_frequency: ['Invalid choice.'] })
    expect(kandjiErrorMessage(400, body)).toBe(
      'HTTP 400: name: This field is required. | execution_frequency: Invalid choice.',
    )
  })

  it('kandjiErrorMessage falls back to a trimmed raw body', () => {
    expect(kandjiErrorMessage(500, '  boom  ')).toBe('HTTP 500: boom')
  })

  it('kandjiErrorMessage falls back to the bare status with an empty body', () => {
    expect(kandjiErrorMessage(503, '')).toBe('HTTP 503')
  })
})
