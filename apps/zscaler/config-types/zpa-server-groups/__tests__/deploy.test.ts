// deploy for zpa-server-groups — the multi-lookup ZPA deploy.
//
// What is specific here, beyond the ZPA rules (customer id in every path, no
// activation, replace-style PUT echoing the id):
//   * membership is declared by NAME and resolved to ids against two further
//     listings — /appConnectorGroup always, /server only when a group has
//     dynamic discovery off — so the request sequence is three reads then a
//     write, and the BODY is where the resolution has to be proved;
//   * a group written with an empty or short member list is an outage, so each
//     failed listing is driven separately and asserted to write nothing;
//   * explicit servers are only sent with discovery off (ZPA rejects them
//     otherwise), so the create body must omit them entirely.

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
  vendorCalls,
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('Prod Web Tier', {
  name: 'Prod Web Tier',
  description: 'desired description',
  enabled: true,
  dynamic_discovery: false,
  app_connector_groups: 'Frankfurt Connectors\nLondon Connectors',
  servers: 'web-01\nweb-02',
})

const DISCOVERY_GROUP = item('Prod Web Tier', {
  name: 'Prod Web Tier',
  description: 'desired description',
  enabled: true,
  dynamic_discovery: true,
  app_connector_groups: 'Frankfurt Connectors',
})

const CONNECTOR_GROUPS = [
  { id: '216196257331370501', name: 'Frankfurt Connectors' },
  { id: '216196257331370502', name: 'London Connectors' },
  { id: '216196257331370503', name: 'Unused Connectors' },
]

const SERVERS = [
  { id: '216196257331370601', name: 'web-01' },
  { id: '216196257331370602', name: 'web-02' },
]

/** The live group, deliberately UNLIKE the canvas in every managed field. */
const LIVE = {
  id: '216196257331370400',
  name: 'Prod Web Tier',
  description: 'live description set by hand',
  enabled: false,
  dynamicDiscovery: true,
  appConnectorGroups: [{ id: '216196257331370599', name: 'Legacy Connectors' }],
  servers: [{ id: '216196257331370699', name: 'web-legacy' }],
}

registerDeployGuardContract({ label: 'zpa-server-groups', handler: deploy, product: 'zpa', items: [GROUP] })

test('zpa-server-groups deploy: resolves member names to ids and creates the group under the ZPA customer', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList(CONNECTOR_GROUPS),
    zpaList(SERVERS),
    zpaList([{ id: '1', name: 'Something Else' }]),
    created({ id: '216196257331370999', name: 'Prod Web Tier' }),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant.length, 4, 'two member listings, the group listing, then one write')
    assert.ok(tenant[0].url.includes('/appConnectorGroup'), `first read hit ${tenant[0].url}`)
    assert.ok(tenant[1].url.includes('/server?'), `second read hit ${tenant[1].url}`)
    assert.ok(tenant[2].url.includes('/serverGroup?'), `third read hit ${tenant[2].url}`)

    assert.equal(tenant[3].method, 'POST')
    assert.ok(
      tenant[3].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/serverGroup`),
      `create hit ${tenant[3].url}`,
    )

    const body = bodyOf(tenant[3])
    assert.equal(body?.name, 'Prod Web Tier')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.enabled, true)
    assert.equal(body?.dynamicDiscovery, false)
    assert.deepEqual(
      body?.appConnectorGroups,
      [{ id: '216196257331370501' }, { id: '216196257331370502' }],
      'both declared connector groups must reach the tenant, as ids',
    )
    assert.deepEqual(
      body?.servers,
      [{ id: '216196257331370601' }, { id: '216196257331370602' }],
      'both declared servers must reach the tenant, as ids',
    )
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      { name: 'Prod Web Tier', existed: false, id: '216196257331370999' },
    ])
    assert.deepEqual(rollback.createdIds, ['216196257331370999'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-server-groups deploy: with dynamic discovery on it neither lists nor sends servers', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList(CONNECTOR_GROUPS),
    zpaList([]),
    created({ id: '216196257331370998', name: 'Prod Web Tier' }),
  ])
  try {
    const result = await deploy(deployContext([DISCOVERY_GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(
      tenant.filter((c) => c.url.includes('/server?')).length,
      0,
      'nothing needs the server index when every group discovers its own members',
    )

    const write = tenant[tenant.length - 1]
    const body = bodyOf(write)
    assert.equal(body?.dynamicDiscovery, true)
    assert.deepEqual(body?.appConnectorGroups, [{ id: '216196257331370501' }])
    assert.equal(body?.servers, undefined, 'ZPA rejects explicit servers when discovery is on')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-server-groups deploy: updates an existing group and records its LIVE prior membership', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList(CONNECTOR_GROUPS),
    zpaList(SERVERS),
    zpaList([LIVE]),
    created({ id: LIVE.id }),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    const write = tenant[3]
    assert.equal(write.method, 'PUT', 'a group that exists is updated, not created')
    assert.ok(write.url.includes(`/serverGroup/${LIVE.id}`), `update hit ${write.url}`)

    const body = bodyOf(write)
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.enabled, true)
    assert.equal(body?.dynamicDiscovery, false)
    assert.deepEqual(body?.appConnectorGroups, [{ id: '216196257331370501' }, { id: '216196257331370502' }])
    assert.deepEqual(body?.servers, [{ id: '216196257331370601' }, { id: '216196257331370602' }])

    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, LIVE.id)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.enabled, false)
    assert.equal(entry.prior.dynamicDiscovery, true)
    assert.deepEqual(
      entry.prior.appConnectorGroups,
      [{ id: '216196257331370599' }],
      'the prior membership is the LIVE one, not the one being deployed',
    )
    assert.deepEqual(entry.prior.servers, [{ id: '216196257331370699' }])
  } finally {
    restore()
  }
})

test('zpa-server-groups deploy: an App Connector group that does not exist stops the deploy before writing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([CONNECTOR_GROUPS[0]]),
    zpaList(SERVERS),
    zpaList([]),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /London Connectors/)
    assert.match(String(result.message), /does not exist in the tenant/)
    assert.equal(
      resourceWrites(calls).length,
      0,
      'a group must never be written with fewer connector groups than were declared',
    )
  } finally {
    restore()
  }
})

test('zpa-server-groups deploy: a server that does not exist stops the deploy before writing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList(CONNECTOR_GROUPS),
    zpaList([SERVERS[0]]),
    zpaList([]),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /web-02/)
    assert.match(String(result.message), /does not exist in the tenant/)
    assert.equal(resourceWrites(calls).length, 0, 'a half-resolved member list must not reach the tenant')
  } finally {
    restore()
  }
})

test('zpa-server-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList(CONNECTOR_GROUPS),
    zpaList(SERVERS),
    zpaList([LIVE]),
    zpaError(400, 'server group name already in use'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /server group name already in use/)
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

test('zpa-server-groups deploy: an unreadable connector-group listing never becomes an empty member list', async () => {
  // The worst failure this config type has available: a 500 on the membership
  // listing read as "no connector groups" would write a group with none.
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

test('zpa-server-groups deploy: an unreadable server listing stops the deploy before writing', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/appConnectorGroup/, respond: zpaList(CONNECTOR_GROUPS) },
    { url: /\/serverGroup/, respond: zpaList([]) },
    { url: /\/server\?/, respond: serverError() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list servers/)
    assert.equal(resourceWrites(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-server-groups deploy: an unreadable server-group listing stops the deploy before writing', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/appConnectorGroup/, respond: zpaList(CONNECTOR_GROUPS) },
    { url: /\/serverGroup/, respond: serverError() },
    { url: /\/server\?/, respond: zpaList(SERVERS) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list server groups/)
    assert.equal(resourceWrites(calls).length, 0)
    assert.equal(
      vendorCalls(calls).filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA has nothing to activate, failed or not',
    )
  } finally {
    restore()
  }
})
