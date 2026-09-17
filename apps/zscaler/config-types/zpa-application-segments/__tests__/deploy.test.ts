// deploy for zpa-application-segments.
//
// Specific to this config type: a segment REFERENCES a segment group and one or
// more server groups BY NAME, so deploy reads three listings concurrently and
// resolves those names into `segmentGroupId` / `serverGroups: [{ id }]` before
// writing. A reference that does not exist must stop the deploy rather than
// producing a segment with fewer backers than the author declared. The authored
// port-range LINES are parsed into ZPA's `{ from, to }` pairs in the same body.
//
// Three concurrent listings mean three concurrent token exchanges, so every
// fixture here is `routeFetch` (URL-matched), never an ordered queue.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ZPA_CUSTOMER_ID,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  ok,
  resourceWrites,
  routeFetch,
  serverError,
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const SEGMENT = item('Corp Intranet', {
  name: 'Corp Intranet',
  description: 'desired description',
  enabled: true,
  domain_names: 'intranet.corp.example\n*.apps.corp.example',
  segment_group_name: 'Corp Apps',
  server_group_names: 'DC1 Servers\nDC2 Servers',
  tcp_port_ranges: '443\n8080-8090',
  udp_port_ranges: '53',
  bypass_type: 'ON_NET',
  health_reporting: 'CONTINUOUS',
})

const SEGMENT_GROUPS = zpaList([{ id: 'sg-1', name: 'Corp Apps' }])
const SERVER_GROUPS = zpaList([
  { id: 'srv-1', name: 'DC1 Servers' },
  { id: 'srv-2', name: 'DC2 Servers' },
])

/** The live segment, deliberately unlike the canvas in every managed field. */
const LIVE = {
  id: '216196257331370500',
  name: 'Corp Intranet',
  description: 'live description set by hand',
  enabled: false,
  domainNames: ['legacy.corp.example'],
  segmentGroupId: 'sg-legacy',
  segmentGroupName: 'Legacy Apps',
  serverGroups: [{ id: 'srv-legacy', name: 'Legacy Servers' }],
  tcpPortRange: [{ from: '80', to: '80' }],
  udpPortRange: [],
  bypassType: 'ALWAYS',
  healthReporting: 'NONE',
}

registerDeployGuardContract({
  label: 'zpa-application-segments',
  handler: deploy,
  product: 'zpa',
  items: [SEGMENT],
})

test('zpa-application-segments deploy: creates a segment, resolving its referenced group NAMES to ids', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/segmentGroup/, respond: SEGMENT_GROUPS },
    { url: /\/serverGroup/, respond: SERVER_GROUPS },
    { url: /\/application/, method: 'GET', respond: zpaList([{ id: '1', name: 'Something Else' }]) },
    { url: /\/application/, method: 'POST', respond: created({ id: '216196257331370999' }) },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    assertAuthenticatedFirst(assert, calls)
    const writes = resourceWrites(calls)
    assert.equal(writes.length, 1, 'one segment, one write')
    assert.equal(writes[0].method, 'POST')
    assert.ok(
      writes[0].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/application`),
      `create hit ${writes[0].url}`,
    )

    const body = bodyOf(writes[0])
    assert.equal(body?.name, 'Corp Intranet')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.enabled, true)
    assert.deepEqual(body?.domainNames, ['intranet.corp.example', '*.apps.corp.example'])
    assert.equal(body?.segmentGroupId, 'sg-1', 'the segment group NAME resolved to its live id')
    assert.deepEqual(body?.serverGroups, [{ id: 'srv-1' }, { id: 'srv-2' }], 'server group names resolved to ids')
    assert.deepEqual(body?.tcpPortRange, [
      { from: '443', to: '443' },
      { from: '8080', to: '8090' },
    ])
    assert.deepEqual(body?.udpPortRange, [{ from: '53', to: '53' }])
    assert.equal(body?.bypassType, 'ON_NET')
    assert.equal(body?.healthReporting, 'CONTINUOUS')
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      { name: 'Corp Intranet', existed: false, id: '216196257331370999' },
    ])
    assert.deepEqual(rollback.createdIds, ['216196257331370999'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-application-segments deploy: updates an existing segment and records its LIVE prior body', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/segmentGroup/, respond: SEGMENT_GROUPS },
    { url: /\/serverGroup/, respond: SERVER_GROUPS },
    { url: /\/application/, method: 'GET', respond: zpaList([LIVE]) },
    { url: /\/application\//, method: 'PUT', respond: ok({ id: LIVE.id }) },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    const writes = resourceWrites(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PUT', 'a segment that exists is updated, not created')
    assert.ok(writes[0].url.includes(`/application/${LIVE.id}`), `update hit ${writes[0].url}`)

    const body = bodyOf(writes[0])
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.segmentGroupId, 'sg-1')
    assert.deepEqual(body?.serverGroups, [{ id: 'srv-1' }, { id: 'srv-2' }])
    assert.equal(body?.enabled, true)

    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, LIVE.id)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.enabled, false)
    assert.deepEqual(entry.prior.domainNames, ['legacy.corp.example'])
    assert.equal(entry.prior.segmentGroupId, 'sg-legacy')
    assert.deepEqual(entry.prior.serverGroups, [{ id: 'srv-legacy' }], 'the prior backers, by id')
    assert.deepEqual(entry.prior.tcpPortRange, [{ from: '80', to: '80' }])
    assert.deepEqual(entry.prior.udpPortRange, [])
    assert.equal(entry.prior.bypassType, 'ALWAYS')
    assert.equal(entry.prior.healthReporting, 'NONE')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-application-segments deploy: refuses to write a segment whose server group does not exist', async () => {
  // Dropping the unresolvable backer and writing the segment anyway would publish
  // an application served by fewer server groups than the author declared.
  const { calls, restore } = routeFetch([
    { url: /\/segmentGroup/, respond: SEGMENT_GROUPS },
    { url: /\/serverGroup/, respond: zpaList([{ id: 'srv-1', name: 'DC1 Servers' }]) },
    { url: /\/application/, method: 'GET', respond: zpaList([]) },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Server group "DC2 Servers".*was not found in the tenant/)
    assert.equal(resourceWrites(calls).length, 0, 'an unresolvable reference must not be written around')
  } finally {
    restore()
  }
})

test('zpa-application-segments deploy: refuses to write a segment whose segment group does not exist', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/segmentGroup/, respond: zpaList([{ id: 'sg-other', name: 'Other Apps' }]) },
    { url: /\/serverGroup/, respond: SERVER_GROUPS },
    { url: /\/application/, method: 'GET', respond: zpaList([]) },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Segment group "Corp Apps".*was not found in the tenant/)
    assert.equal(resourceWrites(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-application-segments deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: /\/segmentGroup/, respond: SEGMENT_GROUPS },
    { url: /\/serverGroup/, respond: SERVER_GROUPS },
    { url: /\/application/, method: 'GET', respond: zpaList([LIVE]) },
    { url: /\/application\//, method: 'PUT', respond: zpaError(400, 'domain name already claimed by another segment') },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /domain name already claimed by another segment/)
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

test('zpa-application-segments deploy: a failed segment listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/segmentGroup/, respond: SEGMENT_GROUPS },
    { url: /\/serverGroup/, respond: SERVER_GROUPS },
    { url: /\/application/, respond: serverError() },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list application segments/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})

test('zpa-application-segments deploy: a failed dependency listing stops the deploy before it writes anything', async () => {
  // A 500 on the server group listing is "I could not look", not "there are
  // none" — resolving to an empty set would strip the segment's backers.
  const { calls, restore } = routeFetch([
    { url: /\/segmentGroup/, respond: SEGMENT_GROUPS },
    { url: /\/serverGroup/, respond: serverError() },
    { url: /\/application/, method: 'GET', respond: zpaList([]) },
  ])
  try {
    const result = await deploy(deployContext([SEGMENT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list server groups/)
    assert.equal(resourceWrites(calls).length, 0)
  } finally {
    restore()
  }
})
