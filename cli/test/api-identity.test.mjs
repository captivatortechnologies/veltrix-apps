// ============================================================================
// Identity helpers used by `veltrix login` and `veltrix whoami`: the key
// self-status check, the best-effort tenant lookup, and expiry formatting.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, KEY_STATUS_PATH, checkAuth, describeExpiry, getOrganization } from '../src/lib/api.mjs'

const PROFILE = { url: 'https://veltrix.example.com', apiKey: 'vltx_test' }

function stubFetch(t, handler) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: new URL(String(url)), init })
    const { status, body } = handler(new URL(String(url)))
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => JSON.stringify(body) }
  })
  return calls
}

test('checkAuth verifies the key against the self-status route', async (t) => {
  const calls = stubFetch(t, () => ({ status: 200, body: { valid: true, expiresAt: null } }))

  assert.deepEqual(await checkAuth(PROFILE), { valid: true, expiresAt: null })
  assert.equal(KEY_STATUS_PATH, 'api/api-keys/self')
  assert.equal(calls[0].url.pathname, '/api/api-keys/self')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, 'ApiKey vltx_test')
})

test('checkAuth surfaces a rejected key as an ApiError with the status', async (t) => {
  stubFetch(t, () => ({ status: 401, body: { error: 'Invalid API key' } }))

  await assert.rejects(checkAuth(PROFILE), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 401)
    assert.equal(error.message, 'Invalid API key')
    return true
  })
})

test('getOrganization returns only the id and name', async (t) => {
  stubFetch(t, () => ({ status: 200, body: { id: 'cust-1', name: 'Acme', billingEmail: 'x@acme.test' } }))

  assert.deepEqual(await getOrganization(PROFILE), { id: 'cust-1', name: 'Acme' })
})

test('getOrganization is null when the key cannot read the organization', async (t) => {
  stubFetch(t, () => ({ status: 403, body: { error: 'Forbidden' } }))

  assert.equal(await getOrganization(PROFILE), null)
})

test('describeExpiry formats a date and names a non-expiring key', () => {
  assert.equal(describeExpiry('2027-01-02T03:04:05.000Z'), '2027-01-02T03:04:05.000Z')
  assert.equal(describeExpiry(null), 'never')
  assert.equal(describeExpiry(undefined), 'never')
})
