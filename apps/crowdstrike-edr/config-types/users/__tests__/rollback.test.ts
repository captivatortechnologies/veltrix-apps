// rollback for users.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the asymmetry that governs identities — a user this deploy
// CREATED is deleted, a user it merely renamed is never deleted — and the
// entries that must produce NO write because there is nothing safe to restore.

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
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const USER_ENTITY = /\/user-management\/entities\/users\/v1/
const ROLE_ACTIONS = /\/user-management\/entities\/user-role-actions\/v1/

const CREATED_ENTRY = {
  email: 'alice@acme.com',
  existed: false,
  uuid: 'usr-new-1',
  rolesGranted: ['falcon_analyst'],
  rolesRevoked: [],
}

const RENAMED_ENTRY = {
  email: 'alice@acme.com',
  existed: true,
  uuid: 'usr-live-1',
  nameChanged: true,
  priorFirstName: 'Alicia',
  priorLastName: 'Chan',
  rolesGranted: ['falcon_analyst', 'falcon_investigator'],
  rolesRevoked: ['falcon_security_lead'],
}

registerRollbackGuardContract({ label: 'users', handler: rollback, entry: CREATED_ENTRY })

test('users rollback: deletes a user this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: USER_ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /user_uuid=usr-new-1/)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'deleting the account also drops its grants — nothing else is needed',
    )
  } finally {
    restore()
  }
})

test('users rollback: treats a 404 on the delete as the user already being gone', async () => {
  const { restore } = routeFetch([{ url: USER_ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '"gone" is a known answer, not a failure')
  } finally {
    restore()
  }
})

test('users rollback: never deletes a user this deploy did not create', async () => {
  // Leaving an extra account behind is visible and removable by hand; deleting
  // an identity the deploy only renamed is not undoable from here.
  const { calls, restore } = routeFetch([
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [RENAMED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      `rollback deleted a pre-existing user: ${describeCalls(callsOfMethod(calls, 'DELETE'))}`,
    )
  } finally {
    restore()
  }
})

test('users rollback: restores the recorded prior name of a user it renamed', async () => {
  const { calls, restore } = routeFetch([
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [RENAMED_ENTRY] }))

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /user_uuid=usr-live-1/)
    const body = bodyOf(patches[0])
    assert.equal(body?.first_name, 'Alicia')
    assert.equal(body?.last_name, 'Chan')
  } finally {
    restore()
  }
})

test('users rollback: reverses exactly the role deltas the deploy recorded', async () => {
  const { calls, restore } = routeFetch([
    { url: USER_ENTITY, method: 'PATCH', respond: ok() },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [RENAMED_ENTRY] }))

    const actions = calls.filter((c) => ROLE_ACTIONS.test(c.url))
    assert.equal(actions.length, 2, `expected a revoke and a grant, got ${describeCalls(actions)}`)

    const revoke = bodyOf(actions[0])
    assert.equal(revoke?.action, 'revoke')
    assert.deepEqual(revoke?.role_ids, ['falcon_analyst', 'falcon_investigator'], 'undo what deploy granted')

    const grant = bodyOf(actions[1])
    assert.equal(grant?.action, 'grant')
    assert.deepEqual(grant?.role_ids, ['falcon_security_lead'], 'restore the LIVE role deploy revoked')
  } finally {
    restore()
  }
})

test('users rollback: does not rename a user whose name this deploy never changed', async () => {
  const entry = { ...RENAMED_ENTRY, nameChanged: false, priorFirstName: undefined, priorLastName: undefined }
  const { calls, restore } = routeFetch([{ url: ROLE_ACTIONS, method: 'POST', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a name deploy never touched must be left alone')
    assert.equal(calls.filter((c) => ROLE_ACTIONS.test(c.url)).length, 2, 'the role deltas are still reversed')
  } finally {
    restore()
  }
})

test('users rollback: writes nothing for a created entry whose uuid was never captured', async () => {
  // Deploy invited the user but never recorded a uuid. Deleting "whatever the
  // lookup returns" would remove an account this deploy may not have created.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ email: 'alice@acme.com', existed: false, rolesGranted: [], rolesRevoked: [] }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('users rollback: writes nothing for a renamed entry whose uuid was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            email: 'alice@acme.com',
            existed: true,
            nameChanged: true,
            priorFirstName: 'Alicia',
            rolesGranted: ['falcon_analyst'],
            rolesRevoked: [],
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('users rollback: makes no role call for an entry that recorded no deltas', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ email: 'alice@acme.com', existed: true, uuid: 'usr-live-1' }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, 'no recorded delta means nothing to reverse')
  } finally {
    restore()
  }
})

test('users rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: USER_ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('users rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: USER_ENTITY, method: 'PATCH', respond: partialFailure('user is managed by SSO') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [RENAMED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored user')
    assert.match(String(result.message), /managed by SSO/)
  } finally {
    restore()
  }
})

test('users rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: USER_ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
    { url: ROLE_ACTIONS, method: 'POST', respond: ok() },
  ])
  try {
    const second = { ...RENAMED_ENTRY, email: 'bob@acme.com', uuid: 'usr-live-2' }
    const result = await rollback(rollbackContext({ previousState: [RENAMED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length >= 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
