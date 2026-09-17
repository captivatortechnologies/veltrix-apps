// rollback for zia-url-filtering-rules.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore is the
// WHOLE prior rule PUT back verbatim — advanced criteria included — so a rule
// that was allowing traffic before the deploy goes back to allowing it; a rule
// deploy created is deleted; a 404 is not an error; and the revert is itself a
// staged ZIA change.

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
  label: 'zia-url-filtering-rules',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const PRIOR = {
  id: 5150,
  name: 'Block adult content',
  order: 9,
  state: 'DISABLED',
  action: 'ALLOW',
  protocols: ['ANY_RULE'],
  urlCategories: ['GAMBLING'],
  locations: [{ id: 999, name: 'HQ' }],
  description: 'hand-tuned in the ZIA console',
}

const UPDATED_ENTRY = { name: 'Block adult content', existed: true, id: 5150, prior: PRIOR }
const CREATED_ENTRY = { name: 'Block gambling', existed: false, id: 6001 }

test('zia-url-filtering-rules rollback: restores the prior rule deploy overwrote, verbatim', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 5150 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/urlFilteringRules\/5150$/)
    assert.deepEqual(bodyOf(tenant[0]), PRIOR, 'the recorded prior rule, not a rebuilt default')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules rollback: deletes a rule deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/urlFilteringRules\/6001$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules rollback: undoes the newest change first', async () => {
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

test('zia-url-filtering-rules rollback: a rule already gone is not an error', async () => {
  // 404 is a known answer — the rule we would delete is already absent, which is
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

test('zia-url-filtering-rules rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Referenced location no longer exists')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Referenced location no longer exists/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules rollback: a failed activation is reported as still-staged', async () => {
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
