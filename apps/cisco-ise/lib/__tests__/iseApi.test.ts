import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readIseSettings,
  buildAuthHeader,
  hasUsableCredential,
  buildIseUrl,
  ersBase,
  summariesFromSearchResult,
  unwrapErsResource,
  idFromLocationHeader,
  ersErrorMessage,
  parseJson,
  ndgRootFromName,
  DEFAULT_ERS_PORT,
} from '../iseApi'
import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef>): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

function component(overrides: Partial<ComponentRef> = {}): ComponentRef {
  return { id: 'comp1', hostname: 'ise-pan.example.com', port: '9060', type: ['cisco-ise'], toolId: 't1', ...overrides }
}

test('readIseSettings defaults verify_tls off and the standard timeout', () => {
  const s = readIseSettings({})
  assert.equal(s.verifyTls, false)
  assert.equal(s.timeoutMs, 30_000)
})

test('readIseSettings reads overrides', () => {
  const s = readIseSettings({ verify_tls: true, request_timeout_seconds: 10 })
  assert.equal(s.verifyTls, true)
  assert.equal(s.timeoutMs, 10_000)
})

test('readIseSettings ignores a malformed timeout', () => {
  assert.equal(readIseSettings({ request_timeout_seconds: -5 }).timeoutMs, 30_000)
  assert.equal(readIseSettings({ request_timeout_seconds: 'fast' }).timeoutMs, 30_000)
})

test('buildAuthHeader builds Basic auth from username + password', () => {
  const header = buildAuthHeader(cred({ username: 'ers-admin', password: 'ChangeMe!' }))
  const expected = `Basic ${Buffer.from('ers-admin:ChangeMe!').toString('base64')}`
  assert.equal(header.Authorization, expected)
})

test('buildAuthHeader falls back to apiToken as the password material', () => {
  const header = buildAuthHeader(cred({ username: 'ers-admin', apiToken: 'secret-token' }))
  assert.equal(header.Authorization, `Basic ${Buffer.from('ers-admin:secret-token').toString('base64')}`)
})

test('buildAuthHeader returns nothing usable without a username or secret', () => {
  assert.deepEqual(buildAuthHeader(cred({ username: '', password: 'x' })), {})
  assert.deepEqual(buildAuthHeader(cred({ username: 'x', password: '', apiToken: null })), {})
})

test('hasUsableCredential requires both a username and a secret', () => {
  assert.equal(hasUsableCredential(cred({ username: 'a', password: 'b' })), true)
  assert.equal(hasUsableCredential(cred({ username: 'a', apiToken: 'b' })), true)
  assert.equal(hasUsableCredential(cred({ username: '', password: 'b' })), false)
  assert.equal(hasUsableCredential(null), false)
})

test('buildIseUrl defaults to the fixed ERS port when the component has none', () => {
  assert.equal(buildIseUrl(component({ port: '' }), null), `https://ise-pan.example.com:${DEFAULT_ERS_PORT}`)
})

test('buildIseUrl honours an explicit component port', () => {
  assert.equal(buildIseUrl(component({ port: '9443' }), null), 'https://ise-pan.example.com:9443')
})

test('buildIseUrl prefers a managed-ZTNA tailscale address when present', () => {
  const url = buildIseUrl(component(), { id: 'conn1', status: 'connected', sshCommand: null, httpsUrl: null, tailscaleDeviceIP: '100.64.0.5' })
  assert.equal(url, `https://100.64.0.5:${DEFAULT_ERS_PORT}`)
})

test('ersBase appends the fixed ERS config path', () => {
  assert.equal(ersBase(component(), null), `https://ise-pan.example.com:9060/ers/config`)
})

test('summariesFromSearchResult unwraps the ERS SearchResult envelope', () => {
  const list = { SearchResult: { total: 2, resources: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] } }
  const parsed = summariesFromSearchResult(list)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].name, 'B')
})

test('summariesFromSearchResult tolerates a missing resources array', () => {
  assert.deepEqual(summariesFromSearchResult({ SearchResult: {} }), [])
  assert.deepEqual(summariesFromSearchResult(null), [])
})

test('unwrapErsResource unwraps a single-resource envelope by wrapper key', () => {
  const envelope = { EndPointGroup: { id: '1', name: 'Contractors', description: 'temp staff', systemDefined: false } }
  assert.equal(unwrapErsResource<{ name: string }>(envelope, 'EndPointGroup')?.name, 'Contractors')
  assert.equal(unwrapErsResource(envelope, 'NetworkDevice'), null)
  assert.equal(unwrapErsResource(null, 'EndPointGroup'), null)
})

test('ndgRootFromName derives the NDG root category from a "#"-path name', () => {
  assert.equal(ndgRootFromName('Location#All Locations#SF'), 'Location')
  assert.equal(ndgRootFromName('Device Type#All Device Types'), 'Device Type')
  assert.equal(ndgRootFromName('NoHash'), 'NoHash')
})

test('idFromLocationHeader extracts the trailing id segment', () => {
  const id = idFromLocationHeader({ location: 'https://ise-pan.example.com:9060/ers/config/endpointgroup/aabbcc11-2233' })
  assert.equal(id, 'aabbcc11-2233')
})

test('idFromLocationHeader handles a lowercase array header and a trailing slash', () => {
  assert.equal(idFromLocationHeader({ location: ['https://ise/ers/config/endpointgroup/xyz/'] }), 'xyz')
})

test('idFromLocationHeader returns null when there is no Location header', () => {
  assert.equal(idFromLocationHeader({}), null)
})

test('ersErrorMessage reads the ERSResponse messages envelope', () => {
  const body = JSON.stringify({ ERSResponse: { messages: [{ title: 'Name already exists', type: 'ERROR' }] } })
  assert.equal(ersErrorMessage({ status: 400, ok: false, headers: {}, body }), 'Name already exists')
})

test('ersErrorMessage falls back to a trimmed raw body', () => {
  assert.equal(ersErrorMessage({ status: 500, ok: false, headers: {}, body: '  boom  ' }), 'boom')
})

test('ersErrorMessage falls back to the HTTP status with an empty body', () => {
  assert.equal(ersErrorMessage({ status: 503, ok: false, headers: {}, body: '' }), 'HTTP 503')
})

test('parseJson tolerates malformed input', () => {
  assert.equal(parseJson('not json'), null)
  assert.equal(parseJson(''), null)
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 })
})
