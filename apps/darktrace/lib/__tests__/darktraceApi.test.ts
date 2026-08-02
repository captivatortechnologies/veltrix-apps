import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  darktraceDate,
  stringToSign,
  signRequest,
  buildQuery,
  requestUri,
  darktraceAuthFrom,
} from '../darktraceApi'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

// The DSA signing assembly is the load-bearing, error-prone part of this app, so
// it is isolated and pinned to golden vectors here. A silent switch to SHA256 or a
// reordered string-to-sign would fail these outright.

test('darktraceDate is compact ISO8601 basic UTC (YYYYMMDDTHHMMSS)', () => {
  const d = new Date(Date.UTC(2025, 0, 15, 14, 30, 22)) // 2025-01-15T14:30:22Z
  assert.equal(darktraceDate(d), '20250115T143022')
})

test('darktraceDate zero-pads every field', () => {
  const d = new Date(Date.UTC(2020, 2, 4, 5, 6, 7)) // 2020-03-04T05:06:07Z
  assert.equal(darktraceDate(d), '20200304T050607')
})

test('stringToSign joins uri, public token and date with newlines in order', () => {
  assert.equal(
    stringToSign('/intelfeed?fulldetails=true', 'PUBLICKEY', '20250115T143022'),
    '/intelfeed?fulldetails=true\nPUBLICKEY\n20250115T143022',
  )
})

test('signRequest produces the golden HMAC-SHA1 hex (NOT SHA256)', () => {
  const headers = signRequest(
    '/intelfeed?fulldetails=true',
    { publicToken: 'PUBLICKEY', privateToken: 'PRIVATEKEY' },
    '20250115T143022',
  )
  assert.equal(headers['DTAPI-Signature'], '2ec9adbe03effd697bcd7cbe7fbfa3f1a21aea4b')
  // Guard: this must never equal the SHA256 digest of the same input.
  assert.notEqual(
    headers['DTAPI-Signature'],
    '21cb46836005a98642f530f4eeb9f9db5f96e5991555bf30091dfdc38827ef79',
  )
})

test('signRequest emits exactly the three DTAPI headers', () => {
  const headers = signRequest('/intelfeed', { publicToken: 'p', privateToken: 's' }, '20200101T000000')
  assert.deepEqual(Object.keys(headers).sort(), ['DTAPI-Date', 'DTAPI-Signature', 'DTAPI-Token'])
  assert.equal(headers['DTAPI-Token'], 'p')
  assert.equal(headers['DTAPI-Date'], '20200101T000000')
})

test('buildQuery sorts keys alphabetically and drops empty values', () => {
  assert.equal(
    buildQuery({ sources: true, fulldetails: true, source: undefined, blank: '' }),
    'fulldetails=true&sources=true',
  )
})

test('buildQuery percent-encodes keys and values', () => {
  assert.equal(buildQuery({ source: 'My Feed', a: 'x/y' }), 'a=x%2Fy&source=My%20Feed')
})

test('requestUri omits the ? when the query is empty', () => {
  assert.equal(requestUri('/intelfeed', ''), '/intelfeed')
  assert.equal(requestUri('/intelfeed', 'a=1'), '/intelfeed?a=1')
})

test('sorted-query round-trip signs the exact wire string (golden vector)', () => {
  const uri = requestUri('/intelfeed', buildQuery({ sources: true, fulldetails: true }))
  assert.equal(uri, '/intelfeed?fulldetails=true&sources=true')
  const headers = signRequest(uri, { publicToken: 'PUB', privateToken: 'secret' }, '20200101T000000')
  assert.equal(headers['DTAPI-Signature'], 'af118f95ff65f58d97e4493cf6632ed3d3a66a3a')
})

test('darktraceAuthFrom maps username→public and apiToken→private', () => {
  const cred = { username: 'pub-token', apiToken: 'priv-token', password: '' } as unknown as CredentialRef
  assert.deepEqual(darktraceAuthFrom(cred), { publicToken: 'pub-token', privateToken: 'priv-token' })
})

test('darktraceAuthFrom falls back to password for the private token', () => {
  const cred = { username: 'pub', apiToken: null, password: 'priv' } as unknown as CredentialRef
  assert.deepEqual(darktraceAuthFrom(cred), { publicToken: 'pub', privateToken: 'priv' })
})

test('darktraceAuthFrom returns null when a token is missing', () => {
  assert.equal(darktraceAuthFrom({ username: 'pub', apiToken: null, password: '' } as unknown as CredentialRef), null)
  assert.equal(darktraceAuthFrom({ username: '', apiToken: 'priv', password: '' } as unknown as CredentialRef), null)
  assert.equal(darktraceAuthFrom(null), null)
})
