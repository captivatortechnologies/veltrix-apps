// deploy for mssp-cid-groups.
//
// A CID group is an ACCESS BOUNDARY: its member child CIDs decide which customer
// tenants an MSSP's analysts can see. So the assertions that matter are the
// membership delta — what is added, what is removed, and that both are written
// down BEFORE either is applied, because rollback can only restore what deploy
// recorded. The shared contract covers the pre-flight refusals.

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

const QUERY = /\/mssp\/queries\/cid-groups\/v1/
const ENTITY_GET = /\/mssp\/entities\/cid-groups\/v2/
const ENTITY_WRITE = /\/mssp\/entities\/cid-groups\/v1/
const MEMBERS_GET = /\/mssp\/entities\/cid-group-members\/v2/
const MEMBERS_WRITE = /\/mssp\/entities\/cid-group-members\/v1/

/** Customer CIDs — 32 hex characters, lowercased and de-duplicated by the extractor. */
const CID_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const CID_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'
/** A customer the tenant still has in the group but the canvas no longer declares. */
const CID_DEPARTED = '0123456789abcdef0123456789abcdef'

/**
 * One declared CID group. `extractCidGroupSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `description`, `cids`.
 */
const GROUP = item('Managed customers', {
  name: 'Tier 1 managed customers',
  description: 'Customers under 24x7 monitoring',
  cids: `${CID_A}, ${CID_B}`,
})

/**
 * The group as it exists in the tenant BEFORE this deploy. `name` is the
 * identity so it must match; every OTHER managed value is deliberately
 * different, so a rollback record that captured the DESIRED values instead of
 * the LIVE ones fails these assertions.
 */
const LIVE_GROUP = {
  id: 'cg-live-1',
  name: 'Tier 1 managed customers',
  description: 'legacy description nobody updated',
}

/** The live membership: one declared customer, plus one the canvas dropped. */
const LIVE_MEMBERS = entityPage([{ cid_group_id: 'cg-live-1', cids: [CID_A, CID_DEPARTED] }])

registerDeployGuardContract({ label: 'mssp-cid-groups', handler: deploy, items: [GROUP] })

/** Routes for a group that already exists, with its live membership. */
function existingGroup(over: { patch?: ReturnType<typeof ok>; add?: ReturnType<typeof ok> } = {}) {
  return routeFetch([
    { url: MEMBERS_GET, respond: LIVE_MEMBERS },
    { url: MEMBERS_WRITE, method: 'POST', respond: over.add ?? ok() },
    { url: MEMBERS_WRITE, method: 'DELETE', respond: ok() },
    { url: ENTITY_GET, respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY_WRITE, method: 'PATCH', respond: over.patch ?? ok() },
    { url: QUERY, respond: idsPage(['cg-live-1']) },
  ])
}

test('mssp-cid-groups deploy: creates a group that does not exist yet and adds its members', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    { url: ENTITY_WRITE, method: 'POST', respond: created({ id: 'cg-new-1' }) },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const creates = callsOfMethod(calls, 'POST').filter((c) => ENTITY_WRITE.test(c.url))
    assert.equal(creates.length, 1, `expected exactly one create, got ${describeCalls(creates)}`)
    const created0 = (bodyOf(creates[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(created0?.name, 'Tier 1 managed customers')
    assert.equal(created0?.description, 'Customers under 24x7 monitoring')

    const adds = callsOfMethod(calls, 'POST').filter((c) => MEMBERS_WRITE.test(c.url))
    assert.equal(adds.length, 1, `expected exactly one member add, got ${describeCalls(adds)}`)
    const member0 = (bodyOf(adds[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(member0?.cid_group_id, 'cg-new-1', 'members must be added to the group just created')
    assert.deepEqual(member0?.cids, [CID_A, CID_B])

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a group that did not exist must not be patched')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'a fresh group has no members to remove')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    { url: ENTITY_WRITE, method: 'POST', respond: created({ id: 'cg-new-1' }) },
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
    assert.equal(state[0].name, 'Tier 1 managed customers')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'cg-new-1', 'without the new id rollback cannot delete what it created')
    assert.deepEqual(state[0].memberDelta.added, [CID_A, CID_B])
    assert.deepEqual(state[0].memberDelta.removed, [])
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: updates a group that already exists, carrying its id', async () => {
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
    assert.equal(body?.cid_group_id, 'cg-live-1', 'the update must address the live group by its id')
    assert.equal(body?.name, 'Tier 1 managed customers')
    assert.equal(body?.description, 'Customers under 24x7 monitoring')
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: converges membership — adds only the new customer, removes only the departed one', async () => {
  const { calls, restore } = existingGroup()
  try {
    await deploy(deployContext([GROUP]))

    const add = callsOfMethod(calls, 'POST').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(add, 'the customer the canvas added was never granted')
    const added = (bodyOf(add)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(added?.cids, [CID_B], 'a customer already in the group must not be re-added')

    const remove = callsOfMethod(calls, 'DELETE').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(remove, 'the customer dropped from the canvas was never revoked')
    const removed = (bodyOf(remove)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(removed?.cids, [CID_DEPARTED], 'only the undeclared customer may be removed')
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: records the LIVE prior description and the exact membership delta', async () => {
  // The canvas asks for a new description and a different customer set; the
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
    assert.equal(state[0].id, 'cg-live-1')
    assert.equal(state[0].prior?.description, 'legacy description nobody updated')
    assert.deepEqual(state[0].memberDelta.added, [CID_B])
    assert.deepEqual(state[0].memberDelta.removed, [CID_DEPARTED])
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: records the membership delta BEFORE applying it', async () => {
  // The member add is rejected after the group was already patched. Everything
  // the deploy intended must still come back on the failure path, or a
  // half-applied convergence has nothing to reverse.
  const { restore } = existingGroup({ add: partialFailure('cid not managed by this parent') })
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    const state = (
      result.rollbackData as { previousState?: Array<{ memberDelta: { added: string[]; removed: string[] } }> }
    )?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.deepEqual(state[0].memberDelta.added, [CID_B])
    assert.deepEqual(state[0].memberDelta.removed, [CID_DEPARTED])
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
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

test('mssp-cid-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as deployed.
  const { restore } = routeFetch([
    { url: ENTITY_WRITE, method: 'POST', respond: partialFailure('cid group quota exceeded') },
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

test('mssp-cid-groups deploy: a failed lookup stops the deploy rather than creating a duplicate', async () => {
  // A 500 on the name query is "I could not look". Reading it as "no such group"
  // would create a second group under the same name and split the customer set.
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

test('mssp-cid-groups deploy: keeps the rollback record of what it wrote when a later group fails', async () => {
  const SECOND = item('Trial customers', { name: 'Trial customers', cids: CID_DEPARTED })
  const { restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    {
      url: ENTITY_WRITE,
      method: 'POST',
      respond: [created({ id: 'cg-new-1' }), forbidden('access denied, authorization failed')],
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
    assert.equal(state[0].id, 'cg-new-1')
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createCidGroup` throws here AFTER the POST
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

test('mssp-cid-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = existingGroup()
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('mssp-cid-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
