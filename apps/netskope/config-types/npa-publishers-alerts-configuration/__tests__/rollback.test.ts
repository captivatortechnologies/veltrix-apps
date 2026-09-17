// rollback for npa-publishers-alerts-configuration.
//
// A SINGLETON revert with one endpoint and no DELETE operation, which shapes the
// whole handler: a first-ever deploy cannot be un-set, only overwritten later.
// The important behaviour is that it says so and makes NO call, rather than
// PUTting an empty policy and silently turning off publisher alerting.

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

const BASE = '/infrastructure/publishers/alertsconfiguration'
const BASE_RE = /\/infrastructure\/publishers\/alertsconfiguration/
const PRIOR = { adminUsers: ['legacy@acme.test'], eventTypes: ['UPGRADE_STARTED'], selectedUsers: 'legacy@acme.test' }

test('npa-publishers-alerts-configuration rollback: refuses without a credential, without calling Netskope', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ existed: true, prior: PRIOR }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0, 'must not reach Netskope without a credential')
    assert.match(String(result.message), /No usable Netskope credential/)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: refuses when no tenant host is configured', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ existed: true, prior: PRIOR }, { settings: settingsWithoutTenant() }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: writes back the policy deploy recorded', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ existed: true, prior: PRIOR }))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PUT')
    assert.equal(writes[0].url, `${BASE_URL}${BASE}`)
    assert.deepEqual(bodyOf(writes[0]), PRIOR, 'the restore is the recorded prior and nothing else')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: makes no call when the policy had never been set', async () => {
  // There is no DELETE on this endpoint, so the only way to "undo" a first-ever
  // deploy would be to PUT an empty policy — which would turn publisher alerting
  // off rather than put it back how it was.
  const { calls, restore } = routeFetch([], ok())
  try {
    const result = await rollback(rollbackContext({ existed: false }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Nothing to restore/)
    assert.match(String(result.message), /no delete operation/)
    assert.equal(calls.length, 0, 'an un-settable policy must be left alone, not blanked')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: makes no call when deploy recorded nothing at all', async () => {
  const { calls, restore } = routeFetch([], ok())
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Nothing to restore/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: makes no call for a recording marked existing but carrying no prior', async () => {
  // Deploy said it overwrote something but never captured what. Inventing a
  // policy here would replace a real one with a guess.
  const { calls, restore } = routeFetch([], ok())
  try {
    const result = await rollback(rollbackContext({ existed: true }))

    assert.equal(calls.length, 0, 'no recorded prior means nothing safe to write')
    assert.match(String(result.message), /Nothing to restore/)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: reports a rejected write instead of throwing', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: serverError('Internal server error') }])
  try {
    const result = await rollback(rollbackContext({ existed: true, prior: PRIOR }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration rollback: reports a refused write instead of throwing', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: forbidden('not authorized') }])
  try {
    const result = await rollback(rollbackContext({ existed: true, prior: PRIOR }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not authorized/)
  } finally {
    restore()
  }
})
