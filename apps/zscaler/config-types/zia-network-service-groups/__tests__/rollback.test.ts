// rollback for zia-network-service-groups.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body
// must carry the prior MEMBER IDS deploy captured, not the canvas's — a group
// restored with the wrong members is a firewall rule matching the wrong traffic —
// a group deploy created is deleted, a group already gone (404) is not an error,
// and the revert is itself a staged ZIA change.

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
  label: 'zia-network-service-groups',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Vendor Access',
  existed: true,
  id: 5001,
  prior: {
    name: 'Vendor Access',
    description: 'live description set by hand',
    services: [{ id: 7003 }],
  },
}

const CREATED_ENTRY = { name: 'New Group', existed: false, id: 5009 }

test('zia-network-service-groups rollback: restores the prior members of a group deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 5001 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkServiceGroups\/5001$/)
    assert.deepEqual(bodyOf(tenant[0]), {
      name: 'Vendor Access',
      description: 'live description set by hand',
      services: [{ id: 7003 }],
    })

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-service-groups rollback: deletes a group deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkServiceGroups\/5009$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-network-service-groups rollback: undoes the newest change first', async () => {
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

test('zia-network-service-groups rollback: a group already gone is not an error', async () => {
  // 404 is a known answer — the object we would delete is already absent, which
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

test('zia-network-service-groups rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Member network service no longer exists')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Member network service no longer exists/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-service-groups rollback: a failed activation is reported as still-staged', async () => {
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
