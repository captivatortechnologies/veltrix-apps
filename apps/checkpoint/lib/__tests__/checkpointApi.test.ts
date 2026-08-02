import {
  readCheckpointSettings,
  resolveCheckpointCredential,
  isNotFoundError,
  checkpointErrorMessage,
  buildCheckpointClient,
  DEFAULT_PORT,
  type CheckpointResult,
} from '../checkpointApi'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef>): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

describe('readCheckpointSettings', () => {
  it('defaults port 443, verifyTls off, no domain, and the standard timeout', () => {
    const s = readCheckpointSettings({})
    expect(s.port).toBe(DEFAULT_PORT)
    expect(s.verifyTls).toBe(false)
    expect(s.domain).toBeNull()
    expect(s.timeoutMs).toBe(30_000)
  })

  it('reads overrides', () => {
    const s = readCheckpointSettings({ port: 4434, verify_tls: true, domain: 'cma-1', request_timeout_seconds: 10 })
    expect(s.port).toBe(4434)
    expect(s.verifyTls).toBe(true)
    expect(s.domain).toBe('cma-1')
    expect(s.timeoutMs).toBe(10_000)
  })

  it('ignores a malformed port, timeout or blank domain', () => {
    expect(readCheckpointSettings({ port: -1 }).port).toBe(DEFAULT_PORT)
    expect(readCheckpointSettings({ port: 'https' }).port).toBe(DEFAULT_PORT)
    expect(readCheckpointSettings({ request_timeout_seconds: -5 }).timeoutMs).toBe(30_000)
    expect(readCheckpointSettings({ domain: '   ' }).domain).toBeNull()
  })
})

describe('resolveCheckpointCredential', () => {
  it('prefers an API key when present', () => {
    const result = resolveCheckpointCredential(cred({ username: 'admin', password: 'pw', apiToken: 'key-123' }))
    expect(result).toEqual({ apiKey: 'key-123' })
  })

  it('falls back to username + password', () => {
    const result = resolveCheckpointCredential(cred({ username: 'admin', password: 'pw' }))
    expect(result).toEqual({ user: 'admin', password: 'pw' })
  })

  it('returns null without a usable credential', () => {
    expect(resolveCheckpointCredential(cred({ username: 'admin', password: '' }))).toBeNull()
    expect(resolveCheckpointCredential(cred({ username: '', password: 'pw' }))).toBeNull()
    expect(resolveCheckpointCredential(null)).toBeNull()
  })
})

describe('buildCheckpointClient', () => {
  it('errors without a usable credential', () => {
    const result = buildCheckpointClient('mgmt.example.com', null, {})
    expect('error' in result).toBe(true)
  })

  it('errors without a host', () => {
    const result = buildCheckpointClient(undefined, cred({ apiToken: 'key' }), {})
    expect('error' in result).toBe(true)
  })

  it('builds a client given a host and credential', () => {
    const result = buildCheckpointClient('mgmt.example.com', cred({ apiToken: 'key' }), {})
    expect('client' in result).toBe(true)
    if ('client' in result) expect(result.host).toBe('mgmt.example.com')
  })
})

function result(overrides: Partial<CheckpointResult>): CheckpointResult {
  return { ok: false, status: 400, data: null, message: 'OK', transportError: null, ...overrides }
}

describe('isNotFoundError', () => {
  it('treats HTTP 404 as not-found', () => {
    expect(isNotFoundError(result({ status: 404 }))).toBe(true)
  })

  it('treats a "does not exist" message as not-found', () => {
    expect(isNotFoundError(result({ status: 400, message: 'Requested object [foo] does not exist' }))).toBe(true)
  })

  it('does not treat an unrelated failure as not-found', () => {
    expect(isNotFoundError(result({ status: 400, message: 'Invalid IPv4 address format' }))).toBe(false)
  })
})

describe('checkpointErrorMessage', () => {
  it('prefers the transport error', () => {
    expect(checkpointErrorMessage(result({ transportError: 'ECONNREFUSED', message: 'OK' }))).toBe('ECONNREFUSED')
  })

  it('falls back to the parsed message', () => {
    expect(checkpointErrorMessage(result({ message: 'generic_err_invalid_parameter' }))).toBe(
      'generic_err_invalid_parameter',
    )
  })
})
