// deploy for users — the highest-consequence config type in this app.
//
// A Falcon user is an identity, not a policy object: the identity is the EMAIL
// (`uid`), a role grant is a second call whose deltas fund rollback, and a user
// this deploy did not create must never be deleted. The shared contract covers
// the pre-flight refusals; what is here is the create/rename/role paths and the
// rollback state they record.
//
// Read `lib/__tests__/fakeFalcon.ts` first — it explains the module-scope token
// cache (which is why every context mints a fresh client secret) and the 401
// that `FalconClient` silently retries.

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
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/user-management\/queries\/users\/v1/
const BULK_GET = /\/user-management\/entities\/users\/GET\/v1/
const USER_ENTITY = /\/user-management\/entities\/users\/v1/
const USER_ROLES = /\/user-management\/combined\/user-roles\/v2/
const ROLE_ACTIONS = /\/user-management\/entities\/user-role-actions\/v1/

/**
 * One declared user. `extractUserSpecs` reads a FLAT `fields` record off each
 * canvas item — `email`, `firstName`, `lastName`, `roleIds`. The item's own
 * name ("Alice Chen") is a label only; the identity is the email.
 */
const USER = item('Alice Chen', {
  email: 'alice@acme.com',
  firstName: 'Alice',
  lastName: 'Chen',
  roleIds: 'falcon_analyst, falcon_investigator',
})

/** The same user with no roles declared — `manageRoles` is false. */
const USER_NO_ROLES = item('Alice Chen', {
  email: 'alice@acme.com',
  firstName: 'Alice',
  lastName: 'Chen',
})

/**
 * The user as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 * The `uid` must match: it is the identity, not a managed field.
 */
const LIVE_USER = {
  uuid: 'usr-live-1',
  uid: 'alice@acme.com',
  first_name: 'Alicia',
  last_name: 'Chan',
}

/** The role the live user already holds — the canvas declares neither of these. */
const LIVE_ROLES = entityPage([{ role_id: 'falcon_security_lead', user_uuid: 'usr-live-1' }])

registerDeployGuardContract({ label: 'users', handler: deploy, items: [USER] })

test('users deploy: invites a user that does not exist yet, and never sends a password', async () => {
  const { calls, restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: EMPTY },
    { url: QUERY, respond: EMPTY },
    { url: USER_ROLES, respond: EMPTY },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
    { url: USER_ENTITY, method: 'POST', respond: created({ uuid: 'usr-new-1', uid: 'alice@acme.com' }) },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const creates = callsOfMethod(calls, 'POST').filter((c) => USER_ENTITY.test(c.url))
    assert.equal(creates.length, 1, `expected exactly one invite, got ${describeCalls(creates)}`)
    const body = bodyOf(creates[0])
    assert.equal(body?.uid, 'alice@acme.com')
    assert.equal(body?.first_name, 'Alice')
    assert.equal(body?.last_name, 'Chen')
    // Falcon sends an activation invite; this app never sets or handles secrets.
    assert.equal('password' in (body ?? {}), false, 'a user is invited, never given a password')

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a user that did not exist must not be renamed')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('users deploy: looks a user up by email (uid), never by display name', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERY, respond: EMPTY },
    { url: USER_ENTITY, method: 'POST', respond: created({ uuid: 'usr-new-1' }) },
    { url: USER_ROLES, respond: EMPTY },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    await deploy(deployContext([USER]))

    const lookup = calls.find((c) => QUERY.test(c.url))
    assert.ok(lookup, 'deploy issued no lookup at all')
    const decoded = decodeURIComponent(lookup.url)
    assert.match(decoded, /uid:'alice@acme\.com'/, 'the identity is the Falcon uid')
    assert.equal(decoded.includes('Alice Chen'), false, 'the display name must never be the lookup key')
  } finally {
    restore()
  }
})

test('users deploy: records the created user so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERY, respond: EMPTY },
    { url: USER_ENTITY, method: 'POST', respond: created({ uuid: 'usr-new-1' }) },
    { url: USER_ROLES, respond: EMPTY },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].email, 'alice@acme.com')
    assert.equal(state[0].existed, false, 'a user this deploy created is not pre-existing')
    assert.equal(state[0].uuid, 'usr-new-1', 'without the new uuid rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('users deploy: renames a user that already exists, addressing it by uuid', async () => {
  const { calls, restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: USER_ROLES, respond: LIVE_ROLES },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => USER_ENTITY.test(c.url)).length,
      0,
      'an existing user must not be invited again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one rename, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /user_uuid=usr-live-1/, 'the rename must address the live user by uuid')
    const body = bodyOf(patches[0])
    assert.equal(body?.first_name, 'Alice')
    assert.equal(body?.last_name, 'Chen')
  } finally {
    restore()
  }
})

test('users deploy: records the LIVE prior names of a user it renamed', async () => {
  // The canvas asks for Alice/Chen; the tenant holds Alicia/Chan. Rollback
  // restores what was there, not what was wanted.
  const { restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: USER_ROLES, respond: LIVE_ROLES },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          existed: boolean
          uuid?: string
          nameChanged?: boolean
          priorFirstName?: string
          priorLastName?: string
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].uuid, 'usr-live-1')
    assert.equal(state[0].nameChanged, true)
    assert.equal(state[0].priorFirstName, 'Alicia')
    assert.equal(state[0].priorLastName, 'Chan')
  } finally {
    restore()
  }
})

test('users deploy: grants and revokes roles as separate calls, and records both deltas', async () => {
  // Role convergence is a second step against a different endpoint: the canvas
  // declares analyst+investigator, the tenant holds security_lead. Rollback can
  // only reverse what these deltas record.
  const { calls, restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: USER_ROLES, respond: LIVE_ROLES },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    const actions = calls.filter((c) => ROLE_ACTIONS.test(c.url))
    assert.equal(actions.length, 2, `expected a grant and a revoke, got ${describeCalls(actions)}`)

    const grant = bodyOf(actions[0])
    assert.equal(grant?.action, 'grant')
    assert.equal(grant?.uuid, 'usr-live-1')
    assert.deepEqual(grant?.role_ids, ['falcon_analyst', 'falcon_investigator'])

    const revoke = bodyOf(actions[1])
    assert.equal(revoke?.action, 'revoke')
    assert.equal(revoke?.uuid, 'usr-live-1')
    assert.deepEqual(revoke?.role_ids, ['falcon_security_lead'], 'only the undeclared live role is revoked')

    const state = (
      result.rollbackData as { previousState?: Array<{ rolesGranted: string[]; rolesRevoked: string[] }> }
    )?.previousState
    assert.ok(state)
    assert.deepEqual(state[0].rolesGranted, ['falcon_analyst', 'falcon_investigator'])
    assert.deepEqual(state[0].rolesRevoked, ['falcon_security_lead'])
  } finally {
    restore()
  }
})

test('users deploy: leaves role grants alone when the canvas declares none', async () => {
  // An item may exist purely to invite or rename an account. Reading the live
  // roles at all would risk revoking grants this configuration never owned.
  const { calls, restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([USER_NO_ROLES]))

    assert.equal(result.success, true)
    assert.equal(calls.some((c) => USER_ROLES.test(c.url)), false, 'undeclared roles must not be read')
    assert.equal(calls.some((c) => ROLE_ACTIONS.test(c.url)), false, 'undeclared roles must not be changed')
  } finally {
    restore()
  }
})

test('users deploy: never deletes a user', async () => {
  // Deploy converges only what the canvas declares. A user removed from the
  // canvas — or any other account in the tenant — is left in place; deleting an
  // identity is not recoverable from here.
  const { calls, restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: USER_ROLES, respond: LIVE_ROLES },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    await deploy(deployContext([USER]))

    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      `deploy issued a delete: ${describeCalls(callsOfMethod(calls, 'DELETE'))}`,
    )
  } finally {
    restore()
  }
})

test('users deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERY, respond: EMPTY },
    { url: USER_ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('users deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a user it never invited as deployed.
  const { restore } = routeFetch([
    { url: QUERY, respond: EMPTY },
    { url: USER_ENTITY, method: 'POST', respond: partialFailure('user seat quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /seat quota exceeded/)
  } finally {
    restore()
  }
})

test('users deploy: treats a partially-failed role grant as a failure', async () => {
  const { restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: USER_ROLES, respond: LIVE_ROLES },
    { url: ROLE_ACTIONS, method: 'POST', respond: partialFailure('role id not found for this cid') },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /role id not found/)

    // The delta was recorded before the batch was issued, so a half-applied
    // grant is still reversible.
    const state = (result.rollbackData as { previousState?: Array<{ rolesGranted: string[] }> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.deepEqual(state[0].rolesGranted, ['falcon_analyst', 'falcon_investigator'])
  } finally {
    restore()
  }
})

test('users deploy: keeps the rollback record of what it wrote when a later user fails', async () => {
  const SECOND = item('Bob Ray', { email: 'bob@acme.com', firstName: 'Bob' })
  const { restore } = routeFetch([
    { url: QUERY, respond: EMPTY },
    {
      url: USER_ENTITY,
      method: 'POST',
      respond: [created({ uuid: 'usr-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([USER_NO_ROLES, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the user that WAS invited must still be recorded')
    assert.equal(state[0].email, 'alice@acme.com')
    assert.equal(state[0].uuid, 'usr-new-1')
  } finally {
    restore()
  }
})

test('users deploy: a create that returns no uuid is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createUser` throws here AFTER the POST
  // succeeded — the fallback lookup also finds nothing — and deploy's
  // `rollbackState.push(entry)` only runs on the line below the create. So the
  // user now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERY, respond: EMPTY },
    { url: USER_ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no user uuid/i)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => USER_ENTITY.test(c.url)).length,
      1,
      'the user was in fact created',
    )
  } finally {
    restore()
  }
})

test('users deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: BULK_GET, method: 'POST', respond: entityPage([LIVE_USER]) },
    { url: QUERY, respond: idsPage(['usr-live-1']) },
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: USER_ROLES, respond: LIVE_ROLES },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('users deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
