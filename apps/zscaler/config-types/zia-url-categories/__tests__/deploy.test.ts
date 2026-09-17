// deploy for zia-url-categories — the reference for every ZIA config type here.
//
// What is specific to this type and worth driving end to end:
//   * identity is `configuredName` and the id is a STRING ("CUSTOM_xx"), unlike
//     the numeric-id ZIA objects;
//   * a PREDEFINED category must never be overwritten — deploy has to refuse;
//   * ZIA STAGES writes, so a deploy that does not reach `/status/activate` has
//     changed nothing the customer can see, and one that activates has;
//   * the update path must record the LIVE prior body, which is the only thing
//     rollback can restore.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const CATEGORY = item('Blocked Vendors', {
  configured_name: 'Blocked Vendors',
  description: 'desired description',
  super_category: 'USER_DEFINED',
  type: 'URL_CATEGORY',
  urls: 'new.example.com\nother.example.com',
  keywords: 'vendor',
})

/**
 * The live category, deliberately UNLIKE the canvas: different description,
 * different URLs, different keywords. A rollback entry that mirrors the canvas
 * rather than this has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 'CUSTOM_01',
  configuredName: 'Blocked Vendors',
  customCategory: true,
  superCategory: 'USER_DEFINED',
  type: 'URL_CATEGORY',
  urls: ['legacy.example.com'],
  keywords: ['legacy'],
  description: 'live description set by hand',
}

registerDeployGuardContract({ label: 'zia-url-categories', handler: deploy, product: 'zia', items: [CATEGORY] })

test('zia-url-categories deploy: creates a category that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 'CUSTOM_77', configuredName: 'Something Else', customCategory: true }]),
    created({ id: 'CUSTOM_09', configuredName: 'Blocked Vendors', customCategory: true }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([CATEGORY]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/urlCategories\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/urlCategories$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.configuredName, 'Blocked Vendors')
    assert.equal(body?.customCategory, true)
    assert.equal(body?.superCategory, 'USER_DEFINED')
    assert.deepEqual(body?.urls, ['new.example.com', 'other.example.com'])
    assert.deepEqual(body?.keywords, ['vendor'])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      { configuredName: 'Blocked Vendors', existed: false, id: 'CUSTOM_09' },
    ])
    assert.deepEqual(rollback.createdIds, ['CUSTOM_09'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-categories deploy: updates an existing category and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 'CUSTOM_01' }), ACTIVATED])
  try {
    const result = await deploy(deployContext([CATEGORY]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a category that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/urlCategories\/CUSTOM_01$/)
    assert.deepEqual(bodyOf(tenant[1])?.urls, ['new.example.com', 'other.example.com'])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 'CUSTOM_01')
    assert.deepEqual(entry.prior.urls, ['legacy.example.com'], 'rollback must restore what was there')
    assert.deepEqual(entry.prior.keywords, ['legacy'])
    assert.equal(entry.prior.description, 'live description set by hand')
  } finally {
    restore()
  }
})

test('zia-url-categories deploy: refuses to overwrite a predefined category, and writes nothing', async () => {
  const predefined = { id: 'OTHER_ADULT_MATERIAL', configuredName: 'Blocked Vendors', customCategory: false }
  const { calls, restore } = recordFetch([TOKEN, ziaList([predefined])])
  try {
    const result = await deploy(deployContext([CATEGORY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined URL category/)
    assert.equal(writeCalls(calls).length, 0, 'a built-in category must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'a predefined category is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-url-categories deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Category name already in use by a predefined category'),
  ])
  try {
    const result = await deploy(deployContext([CATEGORY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Category name already in use/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live category, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { urls?: string[] } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.urls, ['legacy.example.com'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-categories deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/urlCategories/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([CATEGORY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list URL categories/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-url-categories deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 'CUSTOM_09' }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([CATEGORY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: string[] }
    assert.deepEqual(rollback.createdIds, ['CUSTOM_09'], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})
