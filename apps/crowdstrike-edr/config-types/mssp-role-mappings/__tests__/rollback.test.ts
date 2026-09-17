// rollback for mssp-role-mappings.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that rollback reverses DELTAS, not a whole object: it revokes
// exactly what the deploy granted and re-grants exactly what the deploy revoked
// — the LIVE prior access, never the desired one — and writes nothing at all for
// an entry that recorded no delta.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  forbidden,
  leaksSecret,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/mssp\/entities\/mssp-roles\/v1/

/** A binding that already had roles: the deploy added one and revoked one. */
const UPDATED_ENTRY = {
  userGroupId: 'ug-live-1',
  cidGroupId: 'cg-live-1',
  existed: true,
  previousRoleIds: ['falcon_security_lead', 'falcon_analyst'],
  added: ['falcon_investigator'],
  revoked: ['falcon_security_lead'],
}

/** A binding the deploy created from nothing: everything it holds was granted. */
const CREATED_ENTRY = {
  userGroupId: 'ug-live-1',
  cidGroupId: 'cg-live-1',
  existed: false,
  previousRoleIds: [],
  added: ['falcon_analyst', 'falcon_investigator'],
  revoked: [],
}

registerRollbackGuardContract({ label: 'mssp-role-mappings', handler: rollback, entry: CREATED_ENTRY })

test('mssp-role-mappings rollback: revokes what the deploy granted and re-grants what it revoked', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)

    const revoke = (bodyOf(callsOfMethod(calls, 'DELETE')[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.ok(revoke, 'the role the deploy granted was never revoked')
    assert.deepEqual(revoke.role_ids, ['falcon_investigator'])
    assert.equal(revoke.user_group_id, 'ug-live-1')
    assert.equal(revoke.cid_group_id, 'cg-live-1')

    const grant = (bodyOf(callsOfMethod(calls, 'POST')[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.ok(grant, 'the role the deploy revoked was never restored')
    assert.deepEqual(grant.role_ids, ['falcon_security_lead'], 'restore the LIVE prior access')
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: never revokes access the deploy did not grant', async () => {
  // `previousRoleIds` records what the binding already held. Sending that set to
  // the revoke endpoint would strip an analyst team of access that predates this
  // deployment entirely.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const revokedBodies = callsOfMethod(calls, 'DELETE').map((c) => c.body).join(' ')
    assert.equal(
      revokedBodies.includes('falcon_analyst'),
      false,
      `rollback revoked a role the deploy never granted: ${revokedBodies}`,
    )
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: leaves a binding it created with no roles at all', async () => {
  // There is no endpoint that deletes a binding; revoking every role the deploy
  // granted is what "removed" means here.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const revoke = (bodyOf(callsOfMethod(calls, 'DELETE')[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(revoke?.role_ids, ['falcon_analyst', 'falcon_investigator'])
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'a binding that had no roles gets none back')
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: writes nothing for an entry that recorded no delta', async () => {
  // Deploy found the binding already converged. Inventing a grant or a revoke
  // here would change access nothing asked to change.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({
        previousState: [
          {
            userGroupId: 'ug-live-1',
            cidGroupId: 'cg-live-1',
            existed: true,
            previousRoleIds: ['falcon_analyst'],
            added: [],
            revoked: [],
          },
        ],
      }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: writes nothing for an entry whose deltas were never recorded', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ userGroupId: 'ug-live-1', cidGroupId: 'cg-live-1', existed: true }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: reports a rejected revoke rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: treats HTTP 200 with a populated errors[] as a failed rollback', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: partialFailure('role mapping is managed by flight control') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a reversed grant')
    assert.match(String(result.message), /managed by flight control/)
  } finally {
    restore()
  }
})

test('mssp-role-mappings rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'DELETE',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
    { url: ENTITY, method: 'POST', respond: ok() },
  ])
  try {
    const second = { ...UPDATED_ENTRY, userGroupId: 'ug-live-2', cidGroupId: 'cg-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length >= 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
