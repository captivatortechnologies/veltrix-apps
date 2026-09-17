// rollback for zia-url-categories.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body
// must be the prior body deploy captured, not the canvas; a category deploy
// created is deleted; a category already gone (404) is not an error; and the
// revert is itself a staged ZIA change, so it only takes effect on activation.

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
  label: 'zia-url-categories',
  handler: rollback,
  product: 'zia',
  nameKey: 'configuredName',
})

const UPDATED_ENTRY = {
  configuredName: 'Blocked Vendors',
  existed: true,
  id: 'CUSTOM_01',
  prior: {
    configuredName: 'Blocked Vendors',
    superCategory: 'USER_DEFINED',
    type: 'URL_CATEGORY',
    urls: ['legacy.example.com'],
    keywords: ['legacy'],
    description: 'live description set by hand',
  },
}

const CREATED_ENTRY = { configuredName: 'New Category', existed: false, id: 'CUSTOM_09' }

test('zia-url-categories rollback: restores the prior body of a category deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 'CUSTOM_01' }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/urlCategories\/CUSTOM_01$/)
    const body = bodyOf(tenant[0])
    assert.deepEqual(body?.urls, ['legacy.example.com'])
    assert.deepEqual(body?.keywords, ['legacy'])
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.customCategory, true)

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-categories rollback: deletes a category deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/urlCategories\/CUSTOM_09$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-url-categories rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    const tenant = resourceCalls(calls)
    assert.deepEqual(
      tenant.map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-url-categories rollback: a category already gone is not an error', async () => {
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

test('zia-url-categories rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Invalid URL in category')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Invalid URL in category/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-categories rollback: a failed activation is reported as still-staged', async () => {
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
