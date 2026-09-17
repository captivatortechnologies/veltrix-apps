// rollback for npa-local-broker-config.
//
// A SINGLETON revert: there is no collection to walk, just the one tenant-wide
// hostname to put back. What matters is that the value written is the one deploy
// recorded, and that a rejected write is reported rather than thrown.
//
// NOTE: the case where deploy recorded NOTHING is deliberately not asserted. The
// handler treats a missing recording as `priorHostname: ''` and PUTs it, which
// clears the tenant-wide broker hostname — a write of an invented value where
// the only safe action is to make no call at all. See the report accompanying
// these tests.

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
