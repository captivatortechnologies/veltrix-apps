// rollback for npa-local-broker-config.
//
// A SINGLETON revert: there is no collection to walk, just the one tenant-wide
// hostname to put back. What matters is that the value written is the one deploy
// recorded, and that a rejected write is reported rather than thrown.
//
// The distinction that matters most here is between a hostname that was
// genuinely empty before the deploy — a real prior state, correctly restored by
// writing '' — and NOTHING having been recorded at all, where the only safe
// action is to make no call. The handler used to collapse both to `?? ''` and
// PUT it, clearing the tenant-wide broker hostname in the name of an undo.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  BASE_URL,
  bodyOf,
  forbidden,
  ok,
  recordFetch,
  rollbackContext,
  routeFetch,
  serverError,
  settingsWithoutTenant,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'

const BASE = '/infrastructure/lbrokers/brokerconfig'
const BASE_RE = /\/infrastructure\/lbrokers\/brokerconfig/

test('npa-local-broker-config rollback: refuses without a credential, without calling Netskope', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ priorHostname: 'legacy-lbr.acme.test' }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0, 'must not reach Netskope without a credential')
    assert.match(String(result.message), /No usable Netskope credential/)
  } finally {
    restore()
  }
})

test('npa-local-broker-config rollback: refuses when no tenant host is configured', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ priorHostname: 'legacy-lbr.acme.test' }, { settings: settingsWithoutTenant() }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('npa-local-broker-config rollback: writes back the hostname deploy recorded', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ priorHostname: 'legacy-lbr.acme.test' }))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PUT')
    assert.equal(writes[0].url, `${BASE_URL}${BASE}`)
    assert.deepEqual(bodyOf(writes[0]), { hostname: 'legacy-lbr.acme.test' })
  } finally {
    restore()
  }
})

test('npa-local-broker-config rollback: restores a hostname that was genuinely empty before the deploy', async () => {
  // A tenant that had no broker hostname set is a real prior state, and the
  // deploy recorded it as such — clearing it again is the correct revert.
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ priorHostname: '' }))

    assert.equal(result.success, true, result.message)
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { hostname: '' })
    assert.match(String(result.message), /none/)
  } finally {
    restore()
  }
})

test('npa-local-broker-config rollback: writes nothing when the deploy recorded no hostname', async () => {
  // Not the same as a recorded empty string above. Nothing was captured, so
  // there is nothing to put back — and writing '' would clear a tenant-wide
  // setting rather than undo the deploy.
  for (const data of [undefined, {}, { priorHostname: null }, { priorHostname: 42 }]) {
    const { calls, restore } = recordFetch([])
    try {
      const result = await rollback(rollbackContext(data))

      assert.equal(result.success, false)
      assert.match(String(result.message), /No prior local broker hostname was recorded/)
      assert.equal(calls.length, 0, 'an invented hostname is a change, not a rollback')
    } finally {
      restore()
    }
  }
})

test('npa-local-broker-config rollback: reports a rejected write instead of throwing', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: serverError('Internal server error') }])
  try {
    const result = await rollback(rollbackContext({ priorHostname: 'legacy-lbr.acme.test' }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('npa-local-broker-config rollback: reports a refused write instead of throwing', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: forbidden('not authorized') }])
  try {
    const result = await rollback(rollbackContext({ priorHostname: 'legacy-lbr.acme.test' }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not authorized/)
  } finally {
    restore()
  }
})
