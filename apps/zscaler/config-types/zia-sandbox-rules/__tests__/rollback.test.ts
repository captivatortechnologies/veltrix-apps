// rollback for zia-sandbox-rules.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: a sandbox rule is
// restored by PUTting the WHOLE captured prior object back — its Sandbox action,
// policy categories and file types included — so the restore body must be that
// object verbatim, not a rebuilt set of managed scalars; a rule deploy created is
// deleted; a rule already gone (404) is not an error; and the revert is itself a
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
  label: 'zia-sandbox-rules',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const PRIOR = {
  id: 9001,
  name: 'Block Malicious Files',
  order: 7,
  rank: 0,
  state: 'DISABLED',
  ba_rule_action: 'ALLOW',
  ba_policy_categories: ['ADWARE_BLOCK'],
  fileTypes: ['FTCATEGORY_MS_EXE'],
}

const UPDATED_ENTRY = { name: 'Block Malicious Files', existed: true, id: 9001, prior: PRIOR }
const CREATED_ENTRY = { name: 'New Rule', existed: false, id: 9009 }

test('zia-sandbox-rules rollback: restores the whole prior rule of one deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 9001 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/sandboxRules\/9001$/)
    assert.deepEqual(bodyOf(tenant[0]), PRIOR, 'the captured prior rule goes back verbatim')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules rollback: deletes a rule deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/sandboxRules\/9009$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules rollback: undoes the newest change first', async () => {
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

test('zia-sandbox-rules rollback: a rule already gone is not an error', async () => {
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

test('zia-sandbox-rules rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Rule order 7 is already taken')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rule order 7 is already taken/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules rollback: a failed activation is reported as still-staged', async () => {
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
