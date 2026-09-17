// deploy for zia-locations.
//
// What is specific to this type:
//   * the payload is assembled from three sources — the first-class `name`,
//     `country` and `tz` fields, then the `location_json` escape hatch spread
//     over them, then `name` forced back from the name field so JSON can never
//     rename a location;
//   * on an UPDATE the live id is echoed INTO the body, so ZIA treats the PUT as
//     an in-place edit rather than a rename;
//   * the prior state captured is the WHOLE live object, not a field subset —
//     a location carries many server-managed fields (geo, sub-locations, VPN
//     credentials) and only a verbatim replay restores them;
//   * ZIA stages writes, so a deploy that never reaches /status/activate has
//     changed nothing the customer can see.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const LOCATION = item('HQ', {
  name: 'HQ London',
  country: 'UNITED_KINGDOM',
  tz: 'EUROPE_LONDON',
  location_json: '{"ipAddresses":["203.0.113.10"],"authRequired":true,"sslScanEnabled":true}',
})

/**
 * The live location, deliberately UNLIKE the canvas: a different country and
 * timezone, a different egress IP, both security flags off, plus two
 * server-managed fields the canvas never mentions. A rollback entry that mirrors
 * the canvas rather than this has recorded the desired state, not the prior one.
 */
const LIVE = {
  id: 7788,
  name: 'HQ London',
  country: 'IRELAND',
  tz: 'EUROPE_DUBLIN',
  ipAddresses: ['198.51.100.7'],
  authRequired: false,
  sslScanEnabled: false,
  surrogateIP: true,
  profile: 'CORPORATE',
}

registerDeployGuardContract({ label: 'zia-locations', handler: deploy, product: 'zia', items: [LOCATION] })

test('zia-locations deploy: creates a location that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 7700, name: 'Branch Leeds' }]),
    created({ id: 7789, name: 'HQ London' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([LOCATION]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/locations\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/locations$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'HQ London')
    assert.equal(body?.country, 'UNITED_KINGDOM')
    assert.equal(body?.tz, 'EUROPE_LONDON')
    assert.deepEqual(body?.ipAddresses, ['203.0.113.10'], 'location_json keys are merged into the payload')
    assert.equal(body?.authRequired, true)
    assert.equal(body?.sslScanEnabled, true)
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'HQ London', existed: false, id: 7789 }])
    assert.deepEqual(rollback.createdIds, [7789])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-locations deploy: updates an existing location and records its LIVE prior object', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 7788 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([LOCATION]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a location that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/locations\/7788$/)
    const body = bodyOf(tenant[1])
    assert.equal(body?.id, 7788, 'the live id is echoed back so ZIA edits in place')
    assert.equal(body?.authRequired, true)

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ name: string; existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 7788)
    assert.equal(entry.prior.country, 'IRELAND', 'rollback must restore what was there')
    assert.equal(entry.prior.tz, 'EUROPE_DUBLIN')
    assert.deepEqual(entry.prior.ipAddresses, ['198.51.100.7'])
    assert.equal(entry.prior.authRequired, false)
    assert.equal(entry.prior.sslScanEnabled, false)
    assert.equal(entry.prior.surrogateIP, true, 'server-managed fields are captured too')
    assert.equal(entry.prior.profile, 'CORPORATE')
  } finally {
    restore()
  }
})

test('zia-locations deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'IP address already assigned to another location'),
  ])
  try {
    const result = await deploy(deployContext([LOCATION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /IP address already assigned to another location/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live location, so the prior object deploy
    // read beforehand has to survive on the failure path or it can never be
    // restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.country, 'IRELAND')
    assert.equal(rollback.previousState[0].prior?.authRequired, false)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-locations deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/locations/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([LOCATION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list locations/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-locations deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 7789 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([LOCATION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [7789], 'the staged location still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-locations deploy: a create whose response carries no id fails the deploy', async () => {
  // NOTE: what this path RECORDS is deliberately not asserted. The POST
  // succeeded — the location exists in the tenant — but deploy throws on the
  // missing id BEFORE pushing its rollback entry, so the created location is
  // returned as nothing to roll back. Asserting that would bless it; see the
  // report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ name: 'HQ London' })])
  try {
    const result = await deploy(deployContext([LOCATION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
