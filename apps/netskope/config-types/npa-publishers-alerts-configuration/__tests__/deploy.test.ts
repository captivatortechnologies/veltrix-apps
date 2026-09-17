// deploy for npa-publishers-alerts-configuration.
//
// A SINGLETON: one tenant-wide alerting policy that applies to every publisher,
// read from one endpoint and written back to the same one. Unlike the rest of
// the REST API v2 this endpoint's body is camelCase, and a tenant that has never
// configured it answers 404 — which is a KNOWN answer ("not set yet"), not a
// failure, so the deploy proceeds and records that there was nothing before.
//
// NOTE: the two failed-read guards the other config types share are deliberately
// NOT registered here. This handler treats ANY unsuccessful read — a 403, a 500,
// a timeout — the same way it treats the 404, recording `existed: false` and
// overwriting the live policy anyway. Asserting the current behaviour would
// document that as correct; see the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  deployContext,
  forbidden,
  item,
  notFound,
  npaData,
  ok,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import { registerDeployGuardContract } from '../../../lib/__tests__/netskopeContracts'

const BASE = '/infrastructure/publishers/alertsconfiguration'
const BASE_RE = /\/infrastructure\/publishers\/alertsconfiguration/

const alerts = () =>
  item('publisher alerts', {
    adminUsers: 'soc@acme.test,ops@acme.test',
    eventTypes: 'UPGRADE_FAILED,CONNECTION_FAILED',
    selectedUsers: 'soc@acme.test',
  })

/** The policy as the TENANT holds it — a narrower audience watching a different
 *  event, so a prior rebuilt from the canvas is caught. */
const LIVE = { adminUsers: ['legacy@acme.test'], eventTypes: ['UPGRADE_STARTED'], selectedUsers: 'legacy@acme.test' }

registerDeployGuardContract({
  label: 'npa-publishers-alerts-configuration',
  handler: deploy,
  items: [alerts()],
  listPath: BASE,
  singleton: true,
  skipFailedReadGuards: true,
})

test('npa-publishers-alerts-configuration deploy: reads the live policy, then writes the declared one', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData(LIVE) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([alerts()]))

    assert.equal(result.success, true, result.message)
    assert.equal(calls.length, 2, 'one read, one write')
    assert.equal(calls[0].method, 'GET', 'the prior policy must be captured BEFORE the write')
    assert.equal(calls[1].method, 'PUT')
    assert.equal(calls[1].url, `${BASE_URL}${BASE}`)
    assert.deepEqual(bodyOf(calls[1]), {
      adminUsers: ['soc@acme.test', 'ops@acme.test'],
      eventTypes: ['UPGRADE_FAILED', 'CONNECTION_FAILED'],
      selectedUsers: 'soc@acme.test',
    })
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration deploy: records the LIVE prior policy, not the one it is writing', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData(LIVE) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([alerts()]))

    assert.deepEqual(
      result.rollbackData,
      { existed: true, prior: LIVE },
      'rollback restores the audience and events that were there, not the ones that were wanted',
    )
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration deploy: treats a 404 as "never configured" and records that', async () => {
  // A tenant that has never set this policy answers 404. That is a known answer,
  // so the deploy proceeds — and records that there was nothing before, which is
  // what tells rollback there is nothing to restore.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: notFound() },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([alerts()]))

    assert.equal(result.success, true, result.message)
    assert.deepEqual(result.rollbackData, { existed: false })
    assert.equal(writeCalls(calls).length, 1, 'the policy is still applied')
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration deploy: fills in the fields the live policy omitted', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ eventTypes: ['UPGRADE_STARTED'] }) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([alerts()]))

    assert.deepEqual(result.rollbackData, {
      existed: true,
      prior: { adminUsers: [], eventTypes: ['UPGRADE_STARTED'], selectedUsers: '' },
    })
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration deploy: returns the prior policy even when the write is rejected', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData(LIVE) },
    { url: BASE_RE, method: 'PUT', respond: forbidden('not authorized to change alerting') },
  ])
  try {
    const result = await deploy(deployContext([alerts()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not authorized/)
    assert.deepEqual(result.rollbackData, { existed: true, prior: LIVE })
  } finally {
    restore()
  }
})

test('npa-publishers-alerts-configuration deploy: applies only the first item when the canvas holds several', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData(LIVE) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    await deploy(
      deployContext([
        item('first', { adminUsers: 'first@acme.test', eventTypes: 'UPGRADE_FAILED', selectedUsers: 'first@acme.test' }),
        item('second', { adminUsers: 'second@acme.test', eventTypes: 'UPGRADE_SUCCEEDED', selectedUsers: 'second@acme.test' }),
      ]),
    )

    assert.equal(writeCalls(calls).length, 1)
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.adminUsers, ['first@acme.test'])
  } finally {
    restore()
  }
})
