// driftDetect for npa-publishers-alerts-configuration.
//
// A SINGLETON check: read the one tenant-wide alerting policy and compare its
// three fields. The stakes are that an audience quietly removed here is an
// outage nobody gets paged about, so the audience comparison is the one that
// matters most. The usual rules hold: never write, and never report "in sync"
// for a read that did not succeed.

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

const BASE_RE = /\/infrastructure\/publishers\/alertsconfiguration/
const ALERTS = item('publisher alerts', {
  adminUsers: 'soc@acme.test,ops@acme.test',
  eventTypes: 'UPGRADE_FAILED,CONNECTION_FAILED',
  selectedUsers: 'soc@acme.test',
})
const IN_SYNC = {
  adminUsers: ['soc@acme.test', 'ops@acme.test'],
  eventTypes: ['UPGRADE_FAILED', 'CONNECTION_FAILED'],
  selectedUsers: 'soc@acme.test',
}

test('npa-publishers-alerts-configuration driftDetect: makes no call without a credential, and says it did not check', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([ALERTS], { credential: null }))

    assert.equal(calls.length, 0)
    assert.equal(result.checked, false)
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: makes no call without a tenant host, and says it did not check', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([ALERTS], { settings: settingsWithoutTenant() }))

    assert.equal(calls.length, 0)
    assert.equal(result.checked, false)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: reports no drift when the policy matches', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: npaData(IN_SYNC) }])
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    assert.equal(result.hasDrift, false, JSON.stringify(result.diffs))
    assert.deepEqual(result.diffs, [])
    assert.notEqual(result.checked, false, 'it did look')
    assert.equal(writeCalls(calls).length, 0, 'drift must never write')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: reports an admin removed from the alert audience', async () => {
  // Someone taken off the list stops being paged, and nothing else says so.
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ ...IN_SYNC, adminUsers: ['soc@acme.test'] }) },
  ])
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'adminUsers')
    assert.ok(diff, `expected an adminUsers diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ops@acme.test,soc@acme.test')
    assert.equal(diff.actual, 'soc@acme.test')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: reports an event type no longer being alerted on', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ ...IN_SYNC, eventTypes: ['UPGRADE_FAILED'] }) },
  ])
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    const diff = result.diffs.find((d) => d.field === 'eventTypes')
    assert.ok(diff, `expected an eventTypes diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'UPGRADE_FAILED')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: reports the selected users changed', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ ...IN_SYNC, selectedUsers: 'someone-else@acme.test' }) },
  ])
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    const diff = result.diffs.find((d) => d.field === 'selectedUsers')
    assert.ok(diff, `expected a selectedUsers diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'someone-else@acme.test')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: treats a reordered audience as unchanged', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ ...IN_SYNC, adminUsers: ['ops@acme.test', 'soc@acme.test'] }) },
  ])
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    assert.equal(result.hasDrift, false, `order is not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: reports a policy that has been un-set as critical drift', async () => {
  // The endpoint answered, and answered with nothing — the alerting policy this
  // app deployed is no longer configured at all.
  const { restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: { status: 200, body: 'null' } }])
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.length, 1)
    assert.equal(result.diffs[0].field, 'alertsConfiguration')
    assert.equal(result.diffs[0].actual, 'not configured')
    assert.equal(result.diffs[0].severity, 'critical')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: an unreadable endpoint is reported as unchecked', async () => {
  const { calls, restore } = routeFetch([], serverError())
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    assert.equal(result.checked, false, 'a 500 is "I could not look", not "it matches"')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration driftDetect: a rejected token is reported as unchecked', async () => {
  const { restore } = routeFetch([], forbidden())
  try {
    const result = await driftDetect(driftContext([ALERTS]))

    assert.equal(result.checked, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
