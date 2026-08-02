import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readPfsenseSettings,
  resolvePfsenseCredential,
  hasUsableCredential,
  buildPfsenseUrl,
  pfsenseErrorMessage,
  DEFAULT_PORT,
  DEFAULT_API_BASE_PATH,
  type PfsenseSettings,
} from '../pfsenseApi'
import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef>): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

function component(overrides: Partial<ComponentRef> = {}): ComponentRef {
  return { id: 'comp1', hostname: 'fw.example.com', port: '443', type: ['pfsense'], toolId: 't1', ...overrides }
}

test('readPfsenseSettings defaults verify_tls off, v2 base path and the standard timeout/port', () => {
  const s = readPfsenseSettings({})
  assert.equal(s.verifyTls, false)
  assert.equal(s.port, DEFAULT_PORT)
  assert.equal(s.apiBasePath, DEFAULT_API_BASE_PATH)
  assert.equal(s.timeoutMs, 30_000)
})

test('readPfsenseSettings reads overrides', () => {
  const s = readPfsenseSettings({ verify_tls: true, port: 8443, api_base_path: '/api/v1', request_timeout_seconds: 10 })
  assert.equal(s.verifyTls, true)
  assert.equal(s.port, 8443)
  assert.equal(s.apiBasePath, '/api/v1')
  assert.equal(s.timeoutMs, 10_000)
})

test('readPfsenseSettings ignores malformed overrides', () => {
  assert.equal(readPfsenseSettings({ request_timeout_seconds: -5 }).timeoutMs, 30_000)
  assert.equal(readPfsenseSettings({ port: 'fast' }).port, DEFAULT_PORT)
  assert.equal(readPfsenseSettings({ api_base_path: '' }).apiBasePath, DEFAULT_API_BASE_PATH)
})

test('resolvePfsenseCredential prefers an API key over username/password', () => {
  const resolved = resolvePfsenseCredential(cred({ apiToken: 'my-key', username: 'admin', password: 'x' }))
  assert.deepEqual(resolved, { kind: 'api_key', apiKey: 'my-key' })
})

test('resolvePfsenseCredential falls back to username/password for JWT mode', () => {
  const resolved = resolvePfsenseCredential(cred({ username: 'admin', password: 'ChangeMe!' }))
  assert.deepEqual(resolved, { kind: 'jwt', username: 'admin', password: 'ChangeMe!' })
})

test('resolvePfsenseCredential returns null without a usable secret', () => {
  assert.equal(resolvePfsenseCredential(cred({ username: 'admin', password: '' })), null)
  assert.equal(resolvePfsenseCredential(cred({ username: '', password: 'x' })), null)
  assert.equal(resolvePfsenseCredential(null), null)
})

test('hasUsableCredential mirrors resolvePfsenseCredential', () => {
  assert.equal(hasUsableCredential(cred({ apiToken: 'k' })), true)
  assert.equal(hasUsableCredential(cred({ username: 'a', password: 'b' })), true)
  assert.equal(hasUsableCredential(cred({})), false)
  assert.equal(hasUsableCredential(null), false)
})

const settings: PfsenseSettings = { port: DEFAULT_PORT, verifyTls: false, apiBasePath: DEFAULT_API_BASE_PATH, timeoutMs: 30_000 }

test('buildPfsenseUrl uses the component hostname + port + configured base path', () => {
  assert.equal(buildPfsenseUrl(component(), null, settings), 'https://fw.example.com:443/api/v2')
})

test('buildPfsenseUrl honours an explicit component port over the settings default', () => {
  assert.equal(buildPfsenseUrl(component({ port: '8443' }), null, settings), 'https://fw.example.com:8443/api/v2')
})

test('buildPfsenseUrl falls back to the settings port when the component has none', () => {
  assert.equal(buildPfsenseUrl(component({ port: '' }), null, settings), `https://fw.example.com:${DEFAULT_PORT}/api/v2`)
})

test('buildPfsenseUrl prefers a managed-ZTNA tailscale address when present', () => {
  const url = buildPfsenseUrl(component(), { id: 'conn1', status: 'connected', sshCommand: null, httpsUrl: null, tailscaleDeviceIP: '100.64.0.5' }, settings)
  assert.equal(url, 'https://100.64.0.5:443/api/v2')
})

test('pfsenseErrorMessage reads the envelope message + response_id', () => {
  const message = pfsenseErrorMessage({
    status: 400,
    ok: false,
    raw: '',
    transportError: null,
    envelope: { code: 400, status: 'bad request', response_id: 'INVALID_HOST_ALIAS_ADDRESS', message: 'not a valid host', data: null },
  })
  assert.equal(message, 'not a valid host (INVALID_HOST_ALIAS_ADDRESS)')
})

test('pfsenseErrorMessage prefers a transport error', () => {
  assert.equal(pfsenseErrorMessage({ status: 0, ok: false, raw: '', envelope: null, transportError: 'ECONNREFUSED' }), 'ECONNREFUSED')
})

test('pfsenseErrorMessage falls back to the HTTP status with nothing else to go on', () => {
  assert.equal(pfsenseErrorMessage({ status: 503, ok: false, raw: '', envelope: null, transportError: null }), 'HTTP 503')
})
