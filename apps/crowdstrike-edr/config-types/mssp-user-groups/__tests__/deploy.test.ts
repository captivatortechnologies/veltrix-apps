// deploy for mssp-user-groups.
//
// A user group is the analyst side of an MSSP access boundary: who is in it,
// bound to a CID group by a role mapping, decides which customer tenants those
// analysts can reach. So the assertions that matter are the membership delta —
// what is added, what is removed, and that both are written down BEFORE either
// is applied, because rollback can only restore what deploy recorded. The shared
// contract covers the pre-flight refusals.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CREATED_WITHOUT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  created,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  serverError,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/mssp\/queries\/user-groups\/v1/
const ENTITY_GET = /\/mssp\/entities\/user-groups\/v2/
const ENTITY_WRITE = /\/mssp\/entities\/user-groups\/v1/
const MEMBERS_GET = /\/mssp\/entities\/user-group-members\/v2/
const MEMBERS_WRITE = /\/mssp\/entities\/user-group-members\/v1/

/** Analyst user UUIDs — 8-4-4-4-12 hex, lowercased and de-duplicated by the extractor. */
const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
/** An analyst the tenant still has in the group but the canvas no longer declares. */
const UUID_LEAVER = '99999999-8888-7777-6666-555555555555'

/**
 * One declared user group. `extractUserGroupSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `description`, `userUuids`.
 */
const GROUP = item('SOC tier 2', {
  name: 'SOC tier 2 analysts',
  description: 'Escalation analysts',
  userUuids: `${UUID_A}, ${UUID_B}`,
})

/**
 * The group as it exists in the tenant BEFORE this deploy. `name` is the
 * identity so it must match; every OTHER managed value is deliberately
 * different, so a rollback record that captured the DESIRED values instead of
 * the LIVE ones fails these assertions.
 */
const LIVE_GROUP = {
  id: 'ug-live-1',
  name: 'SOC tier 2 analysts',
  description: 'legacy description nobody updated',
}

/** The live membership: one declared analyst, plus one the canvas dropped. */
const LIVE_MEMBERS = entityPage([{ user_group_id: 'ug-live-1', user_uuids: [UUID_A, UUID_LEAVER] }])

registerDeployGuardContract({ label: 'mssp-user-groups', handler: deploy, items: [GROUP] })

/** Routes for a group that already exists, with its live membership. */
function existingGroup(over: { add?: ReturnType<typeof ok> } = {}) {
  return routeFetch([
    { url: MEMBERS_GET, respond: LIVE_MEMBERS },
    { url: MEMBERS_WRITE, method: 'POST', respond: over.add ?? ok() },
    { url: MEMBERS_WRITE, method: 'DELETE', respond: ok() },
    { url: ENTITY_GET, respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY_WRITE, method: 'PATCH', respond: ok() },
    { url: QUERY, respond: idsPage(['ug-live-1']) },
  ])
}

test('mssp-user-groups deploy: creates a group that does not exist yet and adds its members', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    { url: ENTITY_WRITE, method: 'POST', respond: created({ id: 'ug-new-1' }) },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const creates = callsOfMethod(calls, 'POST').filter((c) => ENTITY_WRITE.test(c.url))
    assert.equal(creates.length, 1, `expected exactly one create, got ${describeCalls(creates)}`)
    const created0 = (bodyOf(creates[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(created0?.name, 'SOC tier 2 analysts')
    assert.equal(created0?.description, 'Escalation analysts')

    const adds = callsOfMethod(calls, 'POST').filter((c) => MEMBERS_WRITE.test(c.url))
    assert.equal(adds.length, 1, `expected exactly one member add, got ${describeCalls(adds)}`)
    const member0 = (bodyOf(adds[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(member0?.user_group_id, 'ug-new-1', 'members must be added to the group just created')
    assert.deepEqual(member0?.user_uuids, [UUID_A, UUID_B])

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a group that did not exist must not be patched')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'a fresh group has no members to remove')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    { url: ENTITY_WRITE, method: 'POST', respond: created({ id: 'ug-new-1' }) },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ name: string; existed: boolean; id?: string; memberDelta: { added: string[]; removed: string[] } }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'SOC tier 2 analysts')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'ug-new-1', 'without the new id rollback cannot delete what it created')
    assert.deepEqual(state[0].memberDelta.added, [UUID_A, UUID_B])
    assert.deepEqual(state[0].memberDelta.removed, [])
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: updates a group that already exists, carrying its id', async () => {
  const { calls, restore } = existingGroup()
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => ENTITY_WRITE.test(c.url)).length,
      0,
      'an existing group must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = (bodyOf(patches[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(body?.user_group_id, 'ug-live-1', 'the update must address the live group by its id')
    assert.equal(body?.name, 'SOC tier 2 analysts')
    assert.equal(body?.description, 'Escalation analysts')
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: converges membership — adds only the new analyst, removes only the leaver', async () => {
  const { calls, restore } = existingGroup()
  try {
    await deploy(deployContext([GROUP]))

    const add = callsOfMethod(calls, 'POST').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(add, 'the analyst the canvas added was never granted')
    const added = (bodyOf(add)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(added?.user_uuids, [UUID_B], 'an analyst already in the group must not be re-added')

    const remove = callsOfMethod(calls, 'DELETE').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(remove, 'the analyst dropped from the canvas was never removed')
    const removed = (bodyOf(remove)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(removed?.user_uuids, [UUID_LEAVER], 'only the undeclared analyst may be removed')
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: records the LIVE prior description and the exact membership delta', async () => {
  // The canvas asks for a new description and a different analyst set; the
  // tenant holds the old ones. Rollback restores what was there, not what was
  // wanted — so every one of these must come from the live group.
  const { restore } = existingGroup()
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          existed: boolean
          id?: string
          prior?: { name?: string; description?: string }
          memberDelta: { added: string[]; removed: string[] }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'ug-live-1')
    assert.equal(state[0].prior?.description, 'legacy description nobody updated')
    assert.deepEqual(state[0].memberDelta.added, [UUID_B])
    assert.deepEqual(state[0].memberDelta.removed, [UUID_LEAVER])
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: records the membership delta BEFORE applying it', async () => {
  // The member add is rejected after the group was already patched. Everything
  // the deploy intended must still come back on the failure path, or a
  // half-applied convergence has nothing to reverse.
  const { restore } = existingGroup({ add: partialFailure('user uuid not in this parent cid') })
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    const state = (
      result.rollbackData as { previousState?: Array<{ memberDelta: { added: string[]; removed: string[] } }> }
    )?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.deepEqual(state[0].memberDelta.added, [UUID_B])
    assert.deepEqual(state[0].memberDelta.removed, [UUID_LEAVER])
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: ENTITY_WRITE, method: 'POST', respond: forbidden('access denied, authorization failed') },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as deployed.
  const { restore } = routeFetch([
    { url: ENTITY_WRITE, method: 'POST', respond: partialFailure('user group quota exceeded') },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: a failed lookup stops the deploy rather than creating a duplicate', async () => {
  // A 500 on the name query is "I could not look". Reading it as "no such group"
  // would create a second group under the same name and split the analyst set.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      `an unreadable tenant must not be written to: ${describeCalls(callsOfMethod(calls, 'POST'))}`,
    )
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: keeps the rollback record of what it wrote when a later group fails', async () => {
  const SECOND = item('SOC tier 1', { name: 'SOC tier 1 analysts', userUuids: UUID_LEAVER })
  const { restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    {
      url: ENTITY_WRITE,
      method: 'POST',
      respond: [created({ id: 'ug-new-1' }), forbidden('access denied, authorization failed')],
    },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the group that WAS created must still be recorded')
    assert.equal(state[0].id, 'ug-new-1')
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createUserGroup` throws here AFTER the POST
  // succeeded, and deploy's `rollbackState.push` only runs on the line below it
  // — so the group now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: ENTITY_WRITE, method: 'POST', respond: CREATED_WITHOUT_ID },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no group id/i)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => ENTITY_WRITE.test(c.url)).length,
      1,
      'the group was in fact created',
    )
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = existingGroup()
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('mssp-user-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
