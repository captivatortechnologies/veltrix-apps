// deploy for zia-static-ips.
//
// What is specific to this type:
//   * identity is the IP ADDRESS and the id is NUMERIC, so the rollback entry is
//     keyed on `ipAddress` and carries a number id;
//   * `routableIP` and the geo override are managed fields — manual coordinates
//     are only sent when the override is on, and ZIA derives them otherwise;
//   * ZIA STAGES writes, so a deploy that does not reach `/status/activate` has
//     changed nothing the customer can see;
//   * the update path must record the LIVE prior body, which is the only thing
//     rollback can restore.

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
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const STATIC_IP = item('Chicago egress', {
  ip_address: '203.0.113.10',
  comment: 'Chicago DC egress',
  geo_override: true,
  latitude: 41.8781,
  longitude: -87.6298,
  routable_ip: true,
})

/**
 * The live static IP, deliberately UNLIKE the canvas: a different comment, the
 * geo override off, different coordinates and NOT routable. A rollback entry
 * that mirrors the canvas rather than this has recorded the desired state.
 */
const LIVE = {
  id: 4242,
  ipAddress: '203.0.113.10',
  comment: 'legacy comment set by hand',
  geoOverride: false,
  latitude: 51.5074,
  longitude: -0.1278,
  routableIP: false,
}

registerDeployGuardContract({ label: 'zia-static-ips', handler: deploy, product: 'zia', items: [STATIC_IP] })

test('zia-static-ips deploy: creates a static IP that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 11, ipAddress: '198.51.100.7' }]),
    created({ id: 8801, ipAddress: '203.0.113.10' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([STATIC_IP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/staticIP\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/staticIP$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.ipAddress, '203.0.113.10')
    assert.equal(body?.comment, 'Chicago DC egress')
    assert.equal(body?.geoOverride, true)
    assert.equal(body?.routableIP, true)
    assert.equal(body?.latitude, 41.8781)
    assert.equal(body?.longitude, -87.6298)

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ ipAddress: '203.0.113.10', existed: false, id: 8801 }])
    assert.deepEqual(rollback.createdIds, [8801])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-static-ips deploy: sends no manual coordinates when the geo override is off', async () => {
  // ZIA derives the geolocation from the IP unless the override is set; sending
  // stale coordinates alongside geoOverride:false would pin the wrong location.
  const derived = item('Derived geo', {
    ip_address: '203.0.113.11',
    geo_override: false,
    latitude: 41.8781,
    longitude: -87.6298,
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 8802 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([derived]))

    const body = bodyOf(calls.filter((c) => c.method === 'POST' && c.url.includes('/staticIP'))[0]) ?? {}
    assert.equal(body.geoOverride, false)
    assert.equal('latitude' in body, false, 'coordinates are only sent when overriding')
    assert.equal('longitude' in body, false)
    assert.equal(body.comment, '', 'a blank comment is sent so clearing it converges the live object')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-static-ips deploy: updates an existing static IP and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 4242 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([STATIC_IP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a static IP that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/staticIP\/4242$/)
    assert.equal(bodyOf(tenant[1])?.comment, 'Chicago DC egress')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ ipAddress: string; existed: boolean; id: number; prior: Record<string, unknown> }>
      createdIds: number[]
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.ipAddress, '203.0.113.10')
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 4242)
    assert.equal(entry.prior.comment, 'legacy comment set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.geoOverride, false)
    assert.equal(entry.prior.latitude, 51.5074)
    assert.equal(entry.prior.longitude, -0.1278)
    assert.equal(entry.prior.routableIP, false)
    assert.deepEqual(rollback.createdIds, [], 'nothing was created')
  } finally {
    restore()
  }
})

test('zia-static-ips deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Static IP address is already assigned to another location'),
  ])
  try {
    const result = await deploy(deployContext([STATIC_IP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already assigned to another location/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live static IP, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { comment?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.comment, 'legacy comment set by hand')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-static-ips deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/staticIP/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([STATIC_IP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list static IPs/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-static-ips deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 8801 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([STATIC_IP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [8801], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-static-ips deploy: a create whose response carries no id fails rather than throwing', async () => {
  // NOTE: what rollbackData holds here is deliberately NOT asserted. The POST
  // succeeded, so the static IP exists in the tenant, but deploy throws on the
  // missing id BEFORE pushing a rollback entry — see the report accompanying
  // these tests. Asserting the empty previousState would bless that.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ ipAddress: '203.0.113.10' })])
  try {
    const result = await deploy(deployContext([STATIC_IP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
