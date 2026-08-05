import { parseCredentialBundle, resolveTeleportCredentials, readTeleportSettings } from '../teleport'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function credential(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'Test',
    username: 'automation',
    password: '',
    apiToken: null,
    certificate: null,
    ...overrides,
  }
}

describe('parseCredentialBundle', () => {
  it('treats a plain string as a bare password with no TOTP', () => {
    expect(parseCredentialBundle('SuperSecret123')).toEqual({ password: 'SuperSecret123', totpSecret: null })
  })

  it('parses a JSON bundle with password + totpSecret', () => {
    const raw = JSON.stringify({ password: 'SuperSecret123', totpSecret: 'JBSWY3DPEHPK3PXP' })
    expect(parseCredentialBundle(raw)).toEqual({ password: 'SuperSecret123', totpSecret: 'JBSWY3DPEHPK3PXP' })
  })

  it('falls back to the raw string when JSON is malformed', () => {
    expect(parseCredentialBundle('{not valid json')).toEqual({ password: '{not valid json', totpSecret: null })
  })

  it('returns an empty password for blank input', () => {
    expect(parseCredentialBundle('   ')).toEqual({ password: '', totpSecret: null })
  })

  it('treats a JSON bundle missing password as invalid and falls back to the raw string', () => {
    const raw = JSON.stringify({ totpSecret: 'JBSWY3DPEHPK3PXP' })
    expect(parseCredentialBundle(raw).password).toBe(raw)
  })
})

describe('resolveTeleportCredentials', () => {
  it('returns null when there is no credential', () => {
    expect(resolveTeleportCredentials(null)).toBeNull()
  })

  it('returns null when username is blank', () => {
    expect(resolveTeleportCredentials(credential({ username: '', apiToken: 'pw' }))).toBeNull()
  })

  it('prefers apiToken over password as the bundle source', () => {
    const raw = JSON.stringify({ password: 'from-token', totpSecret: 'SEED' })
    const resolved = resolveTeleportCredentials(credential({ apiToken: raw, password: 'ignored' }))
    expect(resolved).toEqual({ username: 'automation', password: 'from-token', totpSecret: 'SEED' })
  })

  it('falls back to the password field when apiToken is unset', () => {
    const resolved = resolveTeleportCredentials(credential({ password: 'plain-password', apiToken: null }))
    expect(resolved).toEqual({ username: 'automation', password: 'plain-password', totpSecret: null })
  })

  it('returns null when neither field yields a usable password', () => {
    expect(resolveTeleportCredentials(credential({ password: '', apiToken: null }))).toBeNull()
  })
})

describe('readTeleportSettings', () => {
  it('defaults clusterName to null and timeout to 30s', () => {
    expect(readTeleportSettings({})).toEqual({ clusterName: null, timeoutMs: 30_000 })
  })

  it('trims a configured cluster name', () => {
    expect(readTeleportSettings({ cluster_name: '  teleport.example.com  ' }).clusterName).toBe(
      'teleport.example.com',
    )
  })

  it('converts request_timeout_seconds to milliseconds', () => {
    expect(readTeleportSettings({ request_timeout_seconds: 45 }).timeoutMs).toBe(45_000)
  })

  it('ignores an invalid timeout and falls back to the default', () => {
    expect(readTeleportSettings({ request_timeout_seconds: -5 }).timeoutMs).toBe(30_000)
  })
})
