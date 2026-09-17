// rollback for zia-ssl-inspection-rules.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: an SSL inspection
// rule is restored by PUTting the WHOLE captured prior object back — its `action`
// object and all its advanced criteria included — so the restore body must be
// that object verbatim; rebuilding it from the managed scalars would silently
// drop the criteria that decide which traffic the rule matches. A rule deploy
// created is deleted, a rule already gone (404) is not an error, and the revert
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
  label: 'zia-ssl-inspection-rules',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const PRIOR = {
  id: 6001,
  name: 'Decrypt Finance',
  order: 9,
  state: 'DISABLED',
  action: { type: 'DO_NOT_DECRYPT' },
  urlCategories: ['OTHER_MISCELLANEOUS'],
  deviceTrustLevels: ['LOW_TRUST'],
}

const UPDATED_ENTRY = { name: 'Decrypt Finance', existed: true, id: 6001, prior: PRIOR }
const CREATED_ENTRY = { name: 'New Rule', existed: false, id: 6009 }

test('zia-ssl-inspection-rules rollback: restores the whole prior rule of one deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 6001 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/sslInspectionRules\/6001$/)
    assert.deepEqual(bodyOf(tenant[0]), PRIOR, 'the captured prior rule goes back verbatim')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules rollback: deletes a rule deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/sslInspectionRules\/6009$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules rollback: undoes the newest change first', async () => {
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

test('zia-ssl-inspection-rules rollback: a rule already gone is not an error', async () => {
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

test('zia-ssl-inspection-rules rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Rule order 9 is already taken')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rule order 9 is already taken/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules rollback: a failed activation is reported as still-staged', async () => {
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
