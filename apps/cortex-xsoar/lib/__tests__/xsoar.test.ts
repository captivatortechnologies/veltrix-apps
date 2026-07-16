import {
  buildXsoarClient,
  parseJsonValue,
  readXsoarSettings,
  resolveXsoarApiKey,
  xsoarErrorMessage,
} from '../xsoar'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

const cred = (over: Partial<CredentialRef> = {}): CredentialRef => ({ apiToken: 'KEY123', ...over }) as CredentialRef

describe('buildXsoarClient', () => {
  it('errors when no credential is present', () => {
    const built = buildXsoarClient('xsoar.acme.com', null, {})
    expect('error' in built).toBe(true)
  })

  it('errors when no host is present', () => {
    const built = buildXsoarClient('', cred(), {})
    expect('error' in built).toBe(true)
  })

  it('builds a Cortex XSOAR 6 client (no auth id) not in XSOAR-8 mode', () => {
    const built = buildXsoarClient('xsoar.acme.com', cred(), {})
    if ('error' in built) throw new Error(built.error)
    expect(built.client.isXsoar8).toBe(false)
    expect(built.serverUrl).toBe('https://xsoar.acme.com')
  })

  it('builds a Cortex XSOAR 8 client when auth_id is set', () => {
    const built = buildXsoarClient('https://api-acme.xdr.us.paloaltonetworks.com/', cred(), { auth_id: '42' })
    if ('error' in built) throw new Error(built.error)
    expect(built.client.isXsoar8).toBe(true)
    expect(built.serverUrl).toBe('https://api-acme.xdr.us.paloaltonetworks.com')
  })
})

describe('resolveXsoarApiKey', () => {
  it('reads the key from apiToken or password', () => {
    expect(resolveXsoarApiKey(cred({ apiToken: 'A' }))).toBe('A')
    expect(resolveXsoarApiKey(cred({ apiToken: undefined, password: 'B' }))).toBe('B')
    expect(resolveXsoarApiKey(null)).toBeNull()
  })
})

describe('readXsoarSettings', () => {
  it('reads auth id from a string or number and defaults the timeout', () => {
    expect(readXsoarSettings({ auth_id: '7' }).authId).toBe('7')
    expect(readXsoarSettings({ auth_id: 7 }).authId).toBe('7')
    expect(readXsoarSettings({}).authId).toBeNull()
    expect(readXsoarSettings({}).timeoutMs).toBe(30_000)
    expect(readXsoarSettings({ request_timeout_seconds: 10 }).timeoutMs).toBe(10_000)
  })

  it('normalizes an explicit base path and leaves it null when unset', () => {
    expect(readXsoarSettings({ api_base_path: 'xsoar/' }).apiBasePath).toBe('/xsoar')
    expect(readXsoarSettings({}).apiBasePath).toBeNull()
  })
})

describe('parse + error helpers', () => {
  it('parseJsonValue returns value on valid JSON and an error on invalid', () => {
    expect(parseJsonValue<{ a: number }>('{"a":1}')).toEqual({ value: { a: 1 }, error: null })
    expect(parseJsonValue('{bad').value).toBeNull()
    expect(parseJsonValue('{bad').error).toBeTruthy()
    expect(parseJsonValue('')).toEqual({ value: null, error: null })
  })

  it('xsoarErrorMessage prefers detail, falls back to body then status', () => {
    expect(xsoarErrorMessage({ status: 400, ok: false, body: '{"detail":"bad key"}' })).toBe('bad key')
    expect(xsoarErrorMessage({ status: 500, ok: false, body: 'boom' })).toBe('boom')
    expect(xsoarErrorMessage({ status: 503, ok: false, body: '' })).toBe('HTTP 503')
  })
})
