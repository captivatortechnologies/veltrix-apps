// deploy for mssp-role-mappings — the grant that decides which MSSP analysts
// can see which CUSTOMER tenants.
//
// The Falcon grant is ADDITIVE (POST only adds), so converging to exactly the
// declared set means explicitly revoking the extras. That revoke is the
// dangerous half: it removes access this deploy never granted, so the live set
// it took the extras from must be written down BEFORE either call goes out.
// The shared contract covers the pre-flight refusals.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
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
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/mssp\/queries\/mssp-roles\/v1/
const ENTITY = /\/mssp\/entities\/mssp-roles\/v1/

const LINK_ID = 'ug-live-1:cg-live-1'

/**
 * One declared role mapping. `extractRoleMappingSpecs` reads a FLAT `fields`
 * record off each canvas item — `userGroupId`, `cidGroupId`, `roleIds`. The
 * (userGroupId, cidGroupId) pair is the identity; roleIds are the payload.
 */
const MAPPING = item('Tier 2 over managed customers', {
  userGroupId: 'ug-live-1',
  cidGroupId: 'cg-live-1',
  roleIds: 'falcon_analyst, falcon_investigator',
})

/**
 * The binding as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in both directions: it is missing a declared role
 * and carries one nobody declared, so a rollback record that captured the
 * DESIRED set instead of the LIVE one fails these assertions.
 */
const LIVE_ROLES = entityPage([
  {
    id: LINK_ID,
    user_group_id: 'ug-live-1',
    cid_group_id: 'cg-live-1',
    role_ids: ['falcon_security_lead', 'falcon_analyst'],
  },
])

registerDeployGuardContract({ label: 'mssp-role-mappings', handler: deploy, items: [MAPPING] })

/** Routes for a binding that already carries roles. */
function existingBinding(over: { grant?: ReturnType<typeof ok>; revoke?: ReturnType<typeof ok> } = {}) {
  return routeFetch([
    { url: ENTITY, method: 'GET', respond: LIVE_ROLES },
    { url: ENTITY, method: 'POST', respond: over.grant ?? ok() },
    { url: ENTITY, method: 'DELETE', respond: over.revoke ?? ok() },
    { url: QUERY, respond: idsPage([LINK_ID]) },
  ])
}

test('mssp-role-mappings deploy: grants the declared roles on a binding that has none', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: ok() },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([MAPPING]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const grants = callsOfMethod(calls, 'POST')
    assert.equal(grants.length, 1, `expected exactly one grant, got ${describeCalls(grants)}`)
    const body = (bodyOf(grants[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(body?.user_group_id, 'ug-live-1')
    assert.equal(body?.cid_group_id, 'cg-live-1')
    assert.deepEqual(body?.role_ids, ['falcon_analyst', 'falcon_investigator'])

    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a binding with no live roles has nothing to revoke',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: revokes only the roles the live binding actually held', async () => {
  // The grant is additive, so the extras must be revoked explicitly — but only
  // the extras. Sending the declared roles to the revoke endpoint would strip
  // the access the canvas just asked for.
  const { calls, restore } = existingBinding()
  try {
    await deploy(deployContext([MAPPING]))

    const grant = (bodyOf(callsOfMethod(calls, 'POST')[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(grant?.role_ids, ['falcon_investigator'], 'a role already granted must not be re-granted')

    const revoke = (bodyOf(callsOfMethod(calls, 'DELETE')[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(revoke?.role_ids, ['falcon_security_lead'], 'only the undeclared role may be revoked')
    assert.equal(revoke?.user_group_id, 'ug-live-1')
    assert.equal(revoke?.cid_group_id, 'cg-live-1')
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: records the LIVE prior role set, not the declared one', async () => {
  // Rollback re-grants whatever this deploy revoked. If the record held the
  // desired set, the analyst team would come back with the wrong access.
  const { restore } = existingBinding()
  try {
    const result = await deploy(deployContext([MAPPING]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          userGroupId: string
          cidGroupId: string
          existed: boolean
          previousRoleIds: string[]
          added: string[]
          revoked: string[]
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].userGroupId, 'ug-live-1')
    assert.equal(state[0].cidGroupId, 'cg-live-1')
    assert.equal(state[0].existed, true)
    assert.deepEqual(state[0].previousRoleIds, ['falcon_security_lead', 'falcon_analyst'])
    assert.deepEqual(state[0].added, ['falcon_investigator'])
    assert.deepEqual(state[0].revoked, ['falcon_security_lead'])
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: records the deltas BEFORE applying them', async () => {
  // The grant is rejected. Everything the deploy intended must still come back
  // on the failure path, or a half-applied convergence has nothing to reverse.
  const { restore } = existingBinding({ grant: partialFailure('role id not valid for this cid group') })
  try {
    const result = await deploy(deployContext([MAPPING]))

    assert.equal(result.success, false)
    const state = (
      result.rollbackData as { previousState?: Array<{ added: string[]; revoked: string[] }> }
    )?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.deepEqual(state[0].added, ['falcon_investigator'])
    assert.deepEqual(state[0].revoked, ['falcon_security_lead'])
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: writes nothing when the live roles already match', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: LINK_ID, role_ids: ['falcon_investigator', 'falcon_analyst'] }]),
    },
    { url: QUERY, respond: idsPage([LINK_ID]) },
  ])
  try {
    const result = await deploy(deployContext([MAPPING]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: a failed read stops the deploy rather than granting into the dark', async () => {
  // A 500 on the binding lookup is "I could not look". Reading it as "no roles"
  // would make the revoke set empty and the grant set everything — a silent
  // re-grant against a binding whose real state is unknown.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await deploy(deployContext([MAPPING]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `an unreadable binding must not be written to: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: a failed role read stops the deploy too', async () => {
  // The link id resolved but the role resource read failed. Same rule: an
  // unknown live set must not become an empty one.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: serverError() },
    { url: QUERY, respond: idsPage([LINK_ID]) },
  ])
  try {
    const result = await deploy(deployContext([MAPPING]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: touches only the binding the canvas declares', async () => {
  // A mapping removed from the canvas is simply not iterated — deploy never
  // enumerates the tenant's other bindings, so it can never revoke access it
  // was not asked about.
  const { calls, restore } = existingBinding()
  try {
    await deploy(deployContext([MAPPING]))

    for (const call of vendorCalls(calls).filter((c) => c.body)) {
      assert.match(call.body, /ug-live-1/, `a write reached an undeclared binding: ${call.body}`)
      assert.match(call.body, /cg-live-1/, `a write reached an undeclared binding: ${call.body}`)
    }
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([MAPPING]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports access it never granted as deployed.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: partialFailure('user group not owned by this parent cid') },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([MAPPING]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /not owned by this parent cid/)
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: keeps the rollback record of what it wrote when a later mapping fails', async () => {
  const SECOND = item('Tier 1 over trial customers', {
    userGroupId: 'ug-live-2',
    cidGroupId: 'cg-live-2',
    roleIds: 'falcon_analyst',
  })
  const { restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: [ok(), forbidden('access denied, authorization failed')] },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([MAPPING, SECOND]))

    assert.equal(result.success, false)
    const state = (
      result.rollbackData as { previousState?: Array<{ userGroupId: string; added: string[] }> }
    )?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 2, 'both deltas were recorded before either was applied')
    assert.deepEqual(state[0].added, ['falcon_analyst', 'falcon_investigator'])
    assert.equal(state[1].userGroupId, 'ug-live-2')
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = existingBinding()
  try {
    const result = await deploy(deployContext([MAPPING]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('mssp-role-mappings deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
