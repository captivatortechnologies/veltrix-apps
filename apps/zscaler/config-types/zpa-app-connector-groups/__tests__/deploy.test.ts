// deploy for zpa-app-connector-groups.
//
// Specific to this config type: the geo placement (location/latitude/longitude,
// sent to ZPA as STRINGS) and the connector settings (dnsQueryType,
// versionProfileId) all ride in the same replace-style body, so the update path
// has ten fields to get wrong and the live fixture here differs from the canvas
// in every one of them. Being ZPA: the customer id is in every path, the PUT
// echoes the id, and there is no activation step.

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
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('San Jose Connectors', {
  name: 'San Jose Connectors',
  description: 'desired description',
  enabled: true,
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
  country_code: 'US',
  dns_query_type: 'IPV4',
  version_profile_id: '2',
  city_country: 'San Jose, US',
})

/** The live group — deliberately unlike the canvas in EVERY managed field. */
const LIVE = {
  id: '216196257331370400',
  name: 'San Jose Connectors',
  description: 'live description set by hand',
  enabled: false,
  location: 'Frankfurt, DE',
  latitude: 50.1109,
  longitude: 8.6821,
  countryCode: 'DE',
  dnsQueryType: 'IPV6',
  versionProfileId: '0',
  cityCountry: 'Frankfurt, DE',
}

registerDeployGuardContract({
  label: 'zpa-app-connector-groups',
  handler: deploy,
  product: 'zpa',
  items: [GROUP],
})

test('zpa-app-connector-groups deploy: creates a group that does not exist, addressing the ZPA customer', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([{ id: '1', name: 'Somewhere Else' }]),
    created({ id: '216196257331370999', name: 'San Jose Connectors' }),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.ok(
      tenant[0].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/appConnectorGroup`),
      `listing hit ${tenant[0].url}`,
    )
    assert.equal(tenant[1].method, 'POST')
    assert.ok(
      tenant[1].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/appConnectorGroup`),
      `create hit ${tenant[1].url}`,
    )

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'San Jose Connectors')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.enabled, true)
    assert.equal(body?.location, 'San Jose, CA, USA')
    assert.equal(body?.latitude, '37.3382', 'ZPA takes the coordinates as strings')
    assert.equal(body?.longitude, '-121.8863')
    assert.equal(body?.countryCode, 'US')
    assert.equal(body?.dnsQueryType, 'IPV4')
    assert.equal(body?.versionProfileId, '2')
    assert.equal(body?.cityCountry, 'San Jose, US')
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      { name: 'San Jose Connectors', existed: false, id: '216196257331370999' },
    ])
    assert.deepEqual(rollback.createdIds, ['216196257331370999'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups deploy: updates an existing group and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([LIVE]), ok({ id: LIVE.id })])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a group that exists is updated, not created')
    assert.ok(tenant[1].url.includes(`/appConnectorGroup/${LIVE.id}`), `update hit ${tenant[1].url}`)

    const body = bodyOf(tenant[1])
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.enabled, true)
    assert.equal(body?.location, 'San Jose, CA, USA')
    assert.equal(body?.dnsQueryType, 'IPV4')
    assert.equal(body?.versionProfileId, '2')

    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, LIVE.id)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.enabled, false)
    assert.equal(entry.prior.location, 'Frankfurt, DE')
    assert.equal(entry.prior.latitude, '50.1109', 'a numeric coordinate is recorded as the string ZPA wants back')
    assert.equal(entry.prior.longitude, '8.6821')
    assert.equal(entry.prior.countryCode, 'DE')
    assert.equal(entry.prior.dnsQueryType, 'IPV6')
    assert.equal(entry.prior.versionProfileId, '0')
    assert.equal(entry.prior.cityCountry, 'Frankfurt, DE')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([LIVE]),
    zpaError(400, 'app connector group name already in use'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /app connector group name already in use/)
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { description?: string } }> }
    assert.equal(
      rollback.previousState[0].prior?.description,
      'live description set by hand',
      'the prior body read before the overwrite must survive the failure path',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/appConnectorGroup/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list App Connector groups/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})
