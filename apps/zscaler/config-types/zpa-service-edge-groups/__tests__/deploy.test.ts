// deploy for zpa-service-edge-groups.
//
// The ZPA rules first — the customer id in every path, no activation step, the
// replace-style PUT echoing the id, and the LIVE prior body on the update path.
// What is specific to this config type is the size of the body: a service edge
// group carries its geography (location, latitude, longitude, countryCode) and
// its maintenance window (versionProfileId, upgradeDay, upgradeTimeInSecs), and
// three of those are supplied by the extractor's defaults rather than the author
// — so what actually reaches the tenant is worth asserting field by field.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  TOKEN,
  ZPA_CUSTOMER_ID,
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
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const EDGE_GROUP = item('San Jose Edges', {
  name: 'San Jose Edges',
  description: 'desired description',
  enabled: true,
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
  country_code: 'US',
  version_profile_id: '2',
  upgrade_day: 'TUESDAY',
  upgrade_time_in_secs: '3600',
})

/** Only what validate requires — everything else comes from the extractor's defaults. */
const MINIMAL_GROUP = item('Frankfurt Edges', {
  name: 'Frankfurt Edges',
  location: 'Frankfurt, DE',
  latitude: '50.1109',
  longitude: '8.6821',
})

/** The live group, deliberately UNLIKE the canvas in state, geography and window. */
const LIVE = {
  id: '216196257331370400',
  name: 'San Jose Edges',
  description: 'live description set by hand',
  enabled: false,
  location: 'Santa Clara, CA, USA',
  latitude: '37.3541',
  longitude: '-121.9552',
  countryCode: 'CA',
  versionProfileId: '0',
  upgradeDay: 'SUNDAY',
  upgradeTimeInSecs: '66600',
}

registerDeployGuardContract({
  label: 'zpa-service-edge-groups',
  handler: deploy,
  product: 'zpa',
  items: [EDGE_GROUP],
})

test('zpa-service-edge-groups deploy: creates a group that does not exist, addressing the ZPA customer', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([{ id: '1', name: 'Something Else' }]),
    created({ id: '216196257331370999', name: 'San Jose Edges' }),
  ])
  try {
    const result = await deploy(deployContext([EDGE_GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant.length, 2, 'one listing, then one write')
    assert.equal(tenant[0].method, 'GET')
    assert.ok(
      tenant[0].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/serviceEdgeGroup`),
      `listing hit ${tenant[0].url}`,
    )
    assert.equal(tenant[1].method, 'POST')

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'San Jose Edges')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.enabled, true)
    assert.equal(body?.location, 'San Jose, CA, USA')
    assert.equal(body?.latitude, '37.3382', 'ZPA expects the coordinates as strings')
    assert.equal(body?.longitude, '-121.8863')
    assert.equal(body?.countryCode, 'US')
    assert.equal(body?.versionProfileId, '2')
    assert.equal(body?.upgradeDay, 'TUESDAY')
    assert.equal(body?.upgradeTimeInSecs, '3600')
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      { name: 'San Jose Edges', existed: false, id: '216196257331370999' },
    ])
    assert.deepEqual(rollback.createdIds, ['216196257331370999'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups deploy: sends the upgrade window defaults an author never filled in', async () => {
  // The Private Service Edges in this group auto-upgrade in whatever window the
  // create body names, so the defaults are a real maintenance schedule, not
  // cosmetic — an author who left them blank gets Sunday 18:30 on the default
  // version profile, and that is what must actually reach the tenant.
  const { calls, restore } = recordFetch([TOKEN, zpaList([]), created({ id: '216196257331370998' })])
  try {
    const result = await deploy(deployContext([MINIMAL_GROUP]))

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[1])
    assert.equal(body?.versionProfileId, '0')
    assert.equal(body?.upgradeDay, 'SUNDAY')
    assert.equal(body?.upgradeTimeInSecs, '66600')
    assert.equal(body?.countryCode, '', 'an unset country code is sent as empty, not omitted')
    assert.equal(body?.description, '')
    assert.equal(body?.enabled, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups deploy: updates an existing group and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([LIVE]), created({ id: LIVE.id })])
  try {
    const result = await deploy(deployContext([EDGE_GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a group that exists is updated, not created')
    assert.ok(tenant[1].url.includes(`/serviceEdgeGroup/${LIVE.id}`), `update hit ${tenant[1].url}`)

    const body = bodyOf(tenant[1])
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.enabled, true)
    assert.equal(body?.location, 'San Jose, CA, USA')
    assert.equal(body?.upgradeDay, 'TUESDAY')

    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, LIVE.id)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.enabled, false)
    assert.equal(entry.prior.location, 'Santa Clara, CA, USA')
    assert.equal(entry.prior.latitude, '37.3541')
    assert.equal(entry.prior.longitude, '-121.9552')
    assert.equal(entry.prior.countryCode, 'CA')
    assert.equal(entry.prior.versionProfileId, '0')
    assert.equal(entry.prior.upgradeDay, 'SUNDAY')
    assert.equal(entry.prior.upgradeTimeInSecs, '66600')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([LIVE]),
    zpaError(400, 'service edge group name already in use'),
  ])
  try {
    const result = await deploy(deployContext([EDGE_GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /service edge group name already in use/)
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { upgradeDay?: string } }> }
    assert.equal(
      rollback.previousState[0].prior?.upgradeDay,
      'SUNDAY',
      'the prior body read before the overwrite must survive the failure path',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/serviceEdgeGroup/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([EDGE_GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list service edge groups/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})
