// rollback for zia-admin-users.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: an account that
// existed before the deploy is RESTORED and never deleted — the bootstrap super
// admin must survive a rollback — the restored body is the prior state deploy
// captured (its prior role id included) and carries NO password, an account
// deploy created is DELETEd, a 404 on that delete is not an error, and the revert
// is itself a staged ZIA change.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACTIVATED,
  NO_CONTENT,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-admin-users',
  handler: rollback,
  product: 'zia',
  nameKey: 'loginName',
})

const UPDATED_ENTRY = {
  loginName: 'soc.analyst@acme.com',
  existed: true,
  id: 5501,
  prior: {
    userName: 'Former Analyst',
    email: 'former.analyst@acme.com',
    roleId: 9,
    comments: 'granted by hand in the ZIA console',
    disabled: true,
  },
}

const CREATED_ENTRY = { loginName: 'new.analyst@acme.com', existed: false, id: 5510 }

test('zia-admin-users rollback: restores a pre-existing account rather than deleting it', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 5501 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT', 'an account this deploy did not create is never deleted')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/adminUsers\/5501$/)

    const body = bodyOf(tenant[0])
    assert.equal(body?.loginName, 'soc.analyst@acme.com')
    assert.equal(body?.userName, 'Former Analyst', 'the restored account is the prior one, not a default')
    assert.equal(body?.email, 'former.analyst@acme.com')
    assert.deepEqual(body?.role, { id: 9 })
    assert.equal(body?.comments, 'granted by hand in the ZIA console')
    assert.equal(body?.disabled, true)
    assert.equal(body?.password, undefined, 'the password was never captured and must never be invented')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-admin-users rollback: deletes an account deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/adminUsers\/5510$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-admin-users rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-admin-users rollback: an account already gone is not an error', async () => {
  // 404 is a known answer — the account we would delete is already absent, which
  // is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-admin-users rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Admin role no longer exists')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Admin role no longer exists/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-admin-users rollback: a failed activation is reported as still-staged', async () => {
  const { restore } = recordFetch([TOKEN, ok({}), ziaError(409, 'Another activation is already in progress')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /Re-run rollback/)
  } finally {
    restore()
  }
})
