import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readOpnsenseSettings,
  resolveOpnsenseCredential,
  buildOpnsenseClient,
  opnsenseErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
  MISSING_HOST_MESSAGE,
  DEFAULT_PORT,
  ALIAS_MODULE,
  FIRMWARE_STATUS_MODULE,
  OpnsenseClient,
} from '../opnsenseApi'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef>): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

test('readOpnsenseSettings defaults verify_tls off and the standard timeout', () => {
  const s = readOpnsenseSettings({})
  assert.equal(s.verifyTls, false)
  assert.equal(s.timeoutMs, 30_000)
})

test('readOpnsenseSettings reads overrides', () => {
  const s = readOpnsenseSettings({ verify_tls: true, request_timeout_seconds: 10 })
  assert.equal(s.verifyTls, true)
  assert.equal(s.timeoutMs, 10_000)
})

test('readOpnsenseSettings ignores a malformed timeout', () => {
  assert.equal(readOpnsenseSettings({ request_timeout_seconds: -5 }).timeoutMs, 30_000)
  assert.equal(readOpnsenseSettings({ request_timeout_seconds: 'fast' }).timeoutMs, 30_000)
})

test('resolveOpnsenseCredential reads the key from username and the secret from password', () => {
  const c = resolveOpnsenseCredential(cred({ username: 'api-key-123', password: 'api-secret-456' }))
  assert.deepEqual(c, { key: 'api-key-123', secret: 'api-secret-456' })
})

test('resolveOpnsenseCredential falls back to apiToken as the secret', () => {
  const c = resolveOpnsenseCredential(cred({ username: 'api-key-123', apiToken: 'api-secret-789' }))
  assert.deepEqual(c, { key: 'api-key-123', secret: 'api-secret-789' })
})

test('resolveOpnsenseCredential requires both a key and a secret', () => {
  assert.equal(resolveOpnsenseCredential(cred({ username: '', password: 'x' })), null)
  assert.equal(resolveOpnsenseCredential(cred({ username: 'x', password: '', apiToken: null })), null)
  assert.equal(resolveOpnsenseCredential(null), null)
})

test('buildOpnsenseClient reports a missing credential', () => {
  const result = buildOpnsenseClient('opnsense.example.com', '443', null, {})
  assert.deepEqual(result, { error: MISSING_CREDENTIAL_MESSAGE })
})

test('buildOpnsenseClient reports a missing host', () => {
  const result = buildOpnsenseClient('', '443', cred({ username: 'k', password: 's' }), {})
  assert.deepEqual(result, { error: MISSING_HOST_MESSAGE })
})

test('buildOpnsenseClient builds a client when host + credential are present', () => {
  const result = buildOpnsenseClient('opnsense.example.com', '443', cred({ username: 'k', password: 's' }), {})
  assert.equal('error' in result, false)
  if (!('error' in result)) {
    assert.equal(result.host, 'opnsense.example.com')
    assert.ok(result.client instanceof OpnsenseClient)
  }
})

test('buildOpnsenseClient falls back to the default port for a non-numeric/zero port', () => {
  assert.equal(DEFAULT_PORT, 443)
  const result = buildOpnsenseClient('opnsense.example.com', undefined, cred({ username: 'k', password: 's' }), {})
  assert.equal('error' in result, false)
})

test('opnsenseErrorMessage prefers a transport error over the parsed message', () => {
  assert.equal(
    opnsenseErrorMessage({ ok: false, status: 0, data: null, message: 'HTTP 500', transportError: 'ECONNREFUSED' }),
    'ECONNREFUSED',
  )
  assert.equal(
    opnsenseErrorMessage({ ok: false, status: 500, data: null, message: 'boom', transportError: null }),
    'boom',
  )
})

test('the firewall alias and firmware status module path segments are as documented', () => {
  assert.deepEqual(ALIAS_MODULE, ['firewall', 'alias'])
  assert.deepEqual(FIRMWARE_STATUS_MODULE, ['core', 'firmware', 'status'])
})
