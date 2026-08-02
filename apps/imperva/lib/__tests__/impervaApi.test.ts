import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  DEFAULT_IMPERVA_BASE_URL,
  buildImpervaBaseUrl,
  resolveImpervaCredentials,
  readTimeoutMs,
  isApiSuccess,
  isAclApiSuccess,
  apiMessage,
  parseJson,
} from '../impervaApi'

/**
 * The ImpervaClient issues real form-POST requests via fetch, which is impractical
 * to mock here. Tests cover the pure, network-free helpers: credential mapping,
 * base-URL normalization, the v1 `res` envelope and JSON parsing.
 */
const cred = (over: Partial<CredentialRef> = {}): CredentialRef =>
  ({ username: 'my-api-id', apiToken: 'my-api-key', ...over }) as CredentialRef

test('resolveImpervaCredentials maps username→api_id and apiToken→api_key', () => {
  assert.deepEqual(resolveImpervaCredentials(cred()), { apiId: 'my-api-id', apiKey: 'my-api-key' })
})

test('resolveImpervaCredentials returns null when either value is missing', () => {
  assert.equal(resolveImpervaCredentials(null), null)
  assert.equal(resolveImpervaCredentials(cred({ username: '' })), null)
  assert.equal(resolveImpervaCredentials(cred({ apiToken: undefined })), null)
})

test('buildImpervaBaseUrl defaults to the fixed v1 base URL', () => {
  assert.equal(buildImpervaBaseUrl(undefined), DEFAULT_IMPERVA_BASE_URL)
  assert.equal(buildImpervaBaseUrl(''), DEFAULT_IMPERVA_BASE_URL)
  assert.equal(buildImpervaBaseUrl('   '), DEFAULT_IMPERVA_BASE_URL)
})

test('buildImpervaBaseUrl keeps an explicit /api/prov URL and strips trailing slashes', () => {
  assert.equal(buildImpervaBaseUrl('https://my.imperva.com/api/prov/v1/'), 'https://my.imperva.com/api/prov/v1')
  assert.equal(buildImpervaBaseUrl('https://eu.imperva.com/api/prov/v2'), 'https://eu.imperva.com/api/prov/v2')
})

test('buildImpervaBaseUrl turns a bare host into an https v1 base URL', () => {
  assert.equal(buildImpervaBaseUrl('my.imperva.com'), 'https://my.imperva.com/api/prov/v1')
  assert.equal(buildImpervaBaseUrl('https://gateway.example.com'), 'https://gateway.example.com/api/prov/v1')
})

test('readTimeoutMs reads seconds→ms, defaulting to 30s', () => {
  assert.equal(readTimeoutMs({ request_timeout_seconds: 10 }), 10_000)
  assert.equal(readTimeoutMs({}), 30_000)
  assert.equal(readTimeoutMs({ request_timeout_seconds: 0 }), 30_000)
  assert.equal(readTimeoutMs({ request_timeout_seconds: -5 }), 30_000)
})

test('isApiSuccess is true only for res === 0 (number or string)', () => {
  assert.equal(isApiSuccess({ res: 0 }), true)
  assert.equal(isApiSuccess({ res: '0' }), true)
  assert.equal(isApiSuccess({ res: 1, res_message: 'bad' }), false)
  assert.equal(isApiSuccess({ res: '9403' }), false)
  assert.equal(isApiSuccess(null), false)
})

test('isAclApiSuccess accepts res 0 or 2 (the ACL configure endpoint convention)', () => {
  assert.equal(isAclApiSuccess({ res: 0 }), true)
  assert.equal(isAclApiSuccess({ res: '0' }), true)
  assert.equal(isAclApiSuccess({ res: 2 }), true)
  assert.equal(isAclApiSuccess({ res: '2' }), true)
  assert.equal(isAclApiSuccess({ res: 1, res_message: 'bad' }), false)
  assert.equal(isAclApiSuccess(null), false)
})

test('apiMessage surfaces res_message + res code', () => {
  assert.equal(apiMessage({ res: 2, res_message: 'Invalid input' }), 'Invalid input (res=2)')
  assert.equal(apiMessage({ res: 0 }), 'res=0')
  assert.equal(apiMessage(null), 'no/invalid response body')
})

test('parseJson returns null on malformed content', () => {
  assert.deepEqual(parseJson('{"res":0}'), { res: 0 })
  assert.equal(parseJson('not json'), null)
})
