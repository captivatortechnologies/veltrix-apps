import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'
import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  edgeGridTimestamp,
  makeContentHash,
  canonicalizeHeaders,
  makeDataToSign,
  makeAuthorizationHeader,
  buildAkamaiBaseUrl,
  resolveEdgeGridCredentials,
  type EdgeGridCredentials,
  type SignRequestParams,
} from '../akamaiApi'

// =============================================================================
// EdgeGrid (EG1-HMAC-SHA256) signer tests.
//
// The algorithm is fully specified by Akamai's reference implementations
// (AkamaiOPEN-edgegrid-python / -ruby), so these are deterministic. The
// load-bearing assertion is the EXACT tab-separated data-to-sign string (a
// non-circular check of the canonical assembly + field order); the signing-key
// and signature checks re-derive the documented HMAC formulas independently.
//
// NOTE: a real-Akamai known-answer vector is not embedded — the client_secret
// and tokens below are fixtures, not credentials. Verify end-to-end against a
// live Akamai tenant.
// =============================================================================

const CREDS: EdgeGridCredentials = {
  clientToken: 'akab-client-token-xxx-xxxxxxxxxxxxxxxx',
  clientSecret: 'SOMEclientSECRETfixtureNOTaREALsecret=',
  accessToken: 'akab-access-token-xxx-xxxxxxxxxxxxxxxx',
}
const TIMESTAMP = '20240101T00:00:00+0000'
const NONCE = 'ec9d20ee-1e9b-4c1f-9d3a-000000000000'

function b64HmacSha256(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64')
}

test('edgeGridTimestamp formats UTC as yyyyMMddTHH:mm:ss+0000', () => {
  const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5))
  assert.equal(edgeGridTimestamp(d), '20240102T03:04:05+0000')
})

test('content hash is computed only for POST bodies', () => {
  const body = '{"name":"x","type":"IP","list":["203.0.113.0/24"]}'
  const expected = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')
  assert.equal(makeContentHash('POST', body), expected)
  assert.equal(makeContentHash('PUT', body), '')
  assert.equal(makeContentHash('GET', body), '')
  assert.equal(makeContentHash('POST', undefined), '')
  assert.equal(makeContentHash('POST', ''), '')
})

test('canonicalizeHeaders is empty when no headers are signed', () => {
  assert.equal(canonicalizeHeaders(), '')
  assert.equal(canonicalizeHeaders({}), '')
  assert.equal(canonicalizeHeaders({ 'X-Foo': '  a   b ' }), 'x-foo:a b')
})

test('makeDataToSign assembles the 7 tab-separated fields in order (GET, no body)', () => {
  const params: SignRequestParams = {
    method: 'GET',
    url: 'https://akab-host.luna.akamaiapis.net/network-list/v2/network-lists?listType=IP&includeElements=false',
    credentials: CREDS,
    timestamp: TIMESTAMP,
    nonce: NONCE,
  }
  const authData =
    `EG1-HMAC-SHA256 client_token=${CREDS.clientToken};access_token=${CREDS.accessToken};` +
    `timestamp=${TIMESTAMP};nonce=${NONCE};`

  const expected = [
    'GET',
    'https',
    'akab-host.luna.akamaiapis.net',
    '/network-list/v2/network-lists?listType=IP&includeElements=false',
    '', // canonicalized headers (none)
    '', // content hash (GET → none)
    authData,
  ].join('\t')

  assert.equal(makeDataToSign(params, authData), expected)
})

test('makeDataToSign includes the POST content hash field', () => {
  const body = '{"name":"Block list","type":"IP","list":["198.51.100.7"]}'
  const params: SignRequestParams = {
    method: 'POST',
    url: 'https://akab-host.luna.akamaiapis.net/network-list/v2/network-lists',
    credentials: CREDS,
    timestamp: TIMESTAMP,
    nonce: NONCE,
    body,
  }
  const authData = 'EG1-HMAC-SHA256 test;'
  const contentHash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')
  const fields = makeDataToSign(params, authData).split('\t')

  assert.equal(fields.length, 7)
  assert.equal(fields[0], 'POST')
  assert.equal(fields[3], '/network-list/v2/network-lists')
  assert.equal(fields[5], contentHash)
  assert.equal(fields[6], authData)
})

test('makeAuthorizationHeader matches the independently derived EG1-HMAC-SHA256 signature', () => {
  const params: SignRequestParams = {
    method: 'GET',
    url: 'https://akab-host.luna.akamaiapis.net/network-list/v2/network-lists?listType=IP&includeElements=false',
    credentials: CREDS,
    timestamp: TIMESTAMP,
    nonce: NONCE,
  }

  const authData =
    `EG1-HMAC-SHA256 client_token=${CREDS.clientToken};access_token=${CREDS.accessToken};` +
    `timestamp=${TIMESTAMP};nonce=${NONCE};`
  const signingKey = b64HmacSha256(CREDS.clientSecret, TIMESTAMP) // base64(HMAC(client_secret, timestamp))
  const dataToSign = makeDataToSign(params, authData)
  const signature = b64HmacSha256(signingKey, dataToSign) // signingKey is used as the HMAC key STRING
  const expected = `${authData}signature=${signature}`

  assert.equal(makeAuthorizationHeader(params), expected)
  // Signature must be non-empty base64 and appended after the auth data.
  assert.match(makeAuthorizationHeader(params), /;signature=[A-Za-z0-9+/]+=*$/)
})

test('the signature changes when the request path changes (canonical binding)', () => {
  const base: SignRequestParams = {
    method: 'GET',
    url: 'https://akab-host.luna.akamaiapis.net/network-list/v2/network-lists',
    credentials: CREDS,
    timestamp: TIMESTAMP,
    nonce: NONCE,
  }
  const other = { ...base, url: 'https://akab-host.luna.akamaiapis.net/network-list/v2/network-lists/12345_LIST' }
  assert.notEqual(makeAuthorizationHeader(base), makeAuthorizationHeader(other))
})

test('buildAkamaiBaseUrl normalizes bare host / URL / trailing slash', () => {
  assert.equal(buildAkamaiBaseUrl('akab-host.luna.akamaiapis.net'), 'https://akab-host.luna.akamaiapis.net')
  assert.equal(buildAkamaiBaseUrl('https://akab-host.luna.akamaiapis.net/'), 'https://akab-host.luna.akamaiapis.net')
  assert.equal(buildAkamaiBaseUrl('  akab-host.luna.akamaiapis.net/foo  '), 'https://akab-host.luna.akamaiapis.net')
})

test('resolveEdgeGridCredentials maps username/apiToken/password → the three EdgeGrid values', () => {
  const credential = {
    id: 'c1',
    name: 'akamai',
    username: 'akab-client-token',
    password: 'the-client-secret',
    apiToken: 'akab-access-token',
    certificate: null,
  } as CredentialRef

  assert.deepEqual(resolveEdgeGridCredentials(credential), {
    clientToken: 'akab-client-token',
    clientSecret: 'the-client-secret',
    accessToken: 'akab-access-token',
  })

  assert.equal(resolveEdgeGridCredentials(null), null)
  assert.equal(resolveEdgeGridCredentials({ ...credential, password: '' } as CredentialRef), null)
  assert.equal(resolveEdgeGridCredentials({ ...credential, apiToken: null } as CredentialRef), null)
})
