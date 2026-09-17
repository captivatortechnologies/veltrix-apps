// deploy for zia-network-service-groups.
//
// What is specific to this type and worth driving end to end:
//   * members are authored as NAMES, one per line, and ZIA wants `{ id }` — so
//     this deploy reads TWO listings, /networkServices FIRST to build the
//     name -> id index and /networkServiceGroups second, and the resolved
//     `{ id }` list is the part of the body worth asserting;
//   * a member name that does not exist in the tenant must FAIL the deploy, not
//     be silently dropped — a group written with fewer members than the author
//     declared is a firewall rule that stops matching traffic;
//   * ZIA STAGES writes, so nothing is visible until `/status/activate`;
//   * the update path must record the LIVE prior member ids, which is the only
//     thing rollback can restore.

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

const GROUP = item('Vendor Access', {
  name: 'Vendor Access',
  description: 'desired description',
  services: 'Vendor SFTP\nVendor HTTPS',
})

/** The tenant's network services — the index deploy resolves member names against. */
const SERVICES = [
  { id: 7001, name: 'Vendor SFTP', type: 'CUSTOM' },
  { id: 7002, name: 'Vendor HTTPS', type: 'CUSTOM' },
  { id: 7003, name: 'Unrelated', type: 'CUSTOM' },
]

/**
 * The live group, deliberately UNLIKE the canvas: a different description and a
 * different member. A rollback entry that mirrors the canvas rather than this has
 * recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 5001,
  name: 'Vendor Access',
  description: 'live description set by hand',
  services: [{ id: 7003, name: 'Unrelated' }],
}

registerDeployGuardContract({
  label: 'zia-network-service-groups',
  handler: deploy,
  product: 'zia',
  items: [GROUP],
})

test('zia-network-service-groups deploy: resolves member names to ids and creates the group, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList(SERVICES),
    ziaList([{ id: 5077, name: 'Something Else' }]),
    created({ id: 5009, name: 'Vendor Access' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkServices\?/, 'member services are indexed first')
    assert.equal(tenant[1].method, 'GET')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/networkServiceGroups\?/)
    assert.equal(tenant[2].method, 'POST')
    assert.match(tenant[2].url, /\/zia\/api\/v1\/networkServiceGroups$/)

    const body = bodyOf(tenant[2])
    assert.equal(body?.name, 'Vendor Access')
    assert.equal(body?.description, 'desired description')
    assert.deepEqual(body?.services, [{ id: 7001 }, { id: 7002 }], 'member names become bare { id } references')

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Vendor Access', existed: false, id: 5009 }])
    assert.deepEqual(rollback.createdIds, [5009])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOTE: the branch where ZIA answers the POST without an id is deliberately not
// asserted. deploy throws there BEFORE pushing the rollback entry, so the group
// it just created exists in the tenant with nothing recorded to delete it — see
// the report accompanying these tests. Asserting it would bless it.

test('zia-network-service-groups deploy: a member service that does not exist fails the deploy, and writes nothing', async () => {
  // Writing the group with the two members it COULD resolve would leave a
  // firewall rule silently narrower than the author declared.
  const { calls, restore } = recordFetch([TOKEN, ziaList(SERVICES), ziaList([])])
  try {
    const result = await deploy(
      deployContext([
        item('Vendor Access', { name: 'Vendor Access', services: 'Vendor SFTP\nGhost Service\nVendor HTTPS' }),
      ]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /"Ghost Service", which does not exist in the tenant/)
    assert.equal(resourceWrites(calls).length, 0, 'an unresolvable member must not produce a partial group')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-service-groups deploy: updates an existing group and records its LIVE prior members', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList(SERVICES), ziaList([LIVE]), created({ id: 5001 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[2].method, 'PUT', 'a group that exists is updated, not created')
    assert.match(tenant[2].url, /\/zia\/api\/v1\/networkServiceGroups\/5001$/)
    assert.deepEqual(bodyOf(tenant[2])?.services, [{ id: 7001 }, { id: 7002 }])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{
        existed: boolean
        id: number
        prior: { description?: string; services?: Array<{ id: number }> }
      }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 5001)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.deepEqual(entry.prior.services, [{ id: 7003 }], 'the prior MEMBERS are what rollback has to put back')
  } finally {
    restore()
  }
})

test('zia-network-service-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList(SERVICES),
    ziaList([LIVE]),
    ziaError(400, 'Network service group is referenced by a firewall rule'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /referenced by a firewall rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live group, so the prior members deploy read
    // beforehand have to survive on the failure path or they can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { services?: Array<{ id: number }> } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.services, [{ id: 7003 }])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-service-groups deploy: a failed member-service listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/networkServices\?/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list network services/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-service-groups deploy: a failed group listing stops the deploy before it writes anything', async () => {
  // The second listing is the one that decides create-vs-update; if it cannot be
  // read, every declared group would look new and be POSTed over a live one.
  const { calls, restore } = routeFetch([
    { url: /\/networkServiceGroups/, respond: serverError() },
    { url: /\/networkServices\?/, respond: ziaList(SERVICES) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list network service groups/)
    assert.equal(resourceWrites(calls).length, 0)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-service-groups deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList(SERVICES),
    ziaList([]),
    created({ id: 5009 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [5009], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})
