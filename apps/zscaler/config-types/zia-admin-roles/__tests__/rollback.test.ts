// rollback for zia-admin-roles.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body is
// the prior role deploy captured — the whole live object, not a rebuilt payload —
// with the identity name pinned back on; a role deploy created is DELETEd; a role
// already gone (404) is not an error; and the revert is itself a staged ZIA
// change, so it only takes effect on activation.

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
  label: 'zia-admin-roles',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'SOC Analyst',
  existed: true,
  id: 4102,
  prior: {
    id: 4102,
    name: 'SOC Analyst',
    rank: 6,
    isNameL10nTag: false,
    policyAccess: 'READ_ONLY',
    dashboardAccess: 'NONE',
    adminAcctAccess: 'READ_ONLY',
  },
}

const CREATED_ENTRY = { name: 'Threat Hunter', existed: false, id: 4110 }

test('zia-admin-roles rollback: restores the prior body of a role deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 4102 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/adminRoles\/4102$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.rank, 6, 'the restored rank is the prior one, not a default')
    assert.equal(body?.policyAccess, 'READ_ONLY')
    assert.equal(body?.dashboardAccess, 'NONE')
    assert.equal(body?.name, 'SOC Analyst')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-admin-roles rollback: deletes a role deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/adminRoles\/4110$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-admin-roles rollback: undoes the newest change first', async () => {
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

test('zia-admin-roles rollback: a role already gone is not an error', async () => {
  // 404 is a known answer — the role we would delete is already absent, which is
  // the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-admin-roles rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Invalid permission in role')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Invalid permission in role/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-admin-roles rollback: a failed activation is reported as still-staged', async () => {
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
