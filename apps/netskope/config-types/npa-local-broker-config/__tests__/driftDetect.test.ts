// driftDetect for npa-local-broker-config.
//
// A SINGLETON check: read the one tenant-wide hostname and compare it. The rules
// are the same as everywhere else — never write, and never report "in sync" for
// a read that did not succeed, because the platform treats that as a positive
// all-clear and resolves outstanding drift records on the strength of it.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  forbidden,
  item,
  leaksToken,
  npaData,
  recordFetch,
  routeFetch,
  serverError,
  settingsWithoutTenant,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'

const BASE_RE = /\/infrastructure\/lbrokers\/brokerconfig/
const CONFIG = item('broker config', { hostname: 'lbr.acme.test' })

test('npa-local-broker-config driftDetect: makes no call without a credential, and says it did not check', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([CONFIG], { credential: null }))

    assert.equal(calls.length, 0)
    assert.equal(result.checked, false, 'a handler that could not look must not claim it found nothing')
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('npa-local-broker-config driftDetect: makes no call without a tenant host, and says it did not check', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([CONFIG], { settings: settingsWithoutTenant() }))

    assert.equal(calls.length, 0)
    assert.equal(result.checked, false)
  } finally {
    restore()
  }
})

test('npa-local-broker-config driftDetect: reports no drift when the hostname matches', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: npaData({ hostname: 'lbr.acme.test' }) }])
  try {
    const result = await driftDetect(driftContext([CONFIG]))

    assert.equal(result.hasDrift, false, JSON.stringify(result.diffs))
    assert.deepEqual(result.diffs, [])
    assert.notEqual(result.checked, false, 'it did look')
    assert.equal(writeCalls(calls).length, 0, 'drift must never write')
  } finally {
    restore()
  }
})

test('npa-local-broker-config driftDetect: reports the hostname changed in the console', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ hostname: 'someone-elses-lbr.acme.test' }) },
  ])
  try {
    const result = await driftDetect(driftContext([CONFIG]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.length, 1)
    assert.equal(result.diffs[0].field, 'hostname')
    assert.equal(result.diffs[0].expected, 'lbr.acme.test')
    assert.equal(result.diffs[0].actual, 'someone-elses-lbr.acme.test')
    assert.equal(result.diffs[0].severity, 'warning')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('npa-local-broker-config driftDetect: reports a hostname cleared in the console', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: npaData({}) }])
  try {
    const result = await driftDetect(driftContext([CONFIG]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].actual, '')
  } finally {
    restore()
  }
})

test('npa-local-broker-config driftDetect: an unreadable endpoint is reported as unchecked', async () => {
  const { calls, restore } = routeFetch([], serverError())
  try {
    const result = await driftDetect(driftContext([CONFIG]))

    assert.equal(result.checked, false, 'a 500 is "I could not look", not "it matches"')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('npa-local-broker-config driftDetect: a rejected token is reported as unchecked', async () => {
  const { restore } = routeFetch([], forbidden())
  try {
    const result = await driftDetect(driftContext([CONFIG]))

    assert.equal(result.checked, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
