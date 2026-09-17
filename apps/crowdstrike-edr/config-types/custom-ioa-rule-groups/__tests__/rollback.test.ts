// rollback for custom-ioa-rule-groups.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that an UPDATED group is not deleted — it belonged to the
// customer before the deploy — so rollback removes only the rules this deploy
// added and then patches the group's own fields back, re-reading the group first
// because deleting a rule bumps the version a group PATCH has to echo.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  entityPage,
  forbidden,
  leaksSecret,
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  serverError,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const GROUPS = /\/ioarules\/entities\/rule-groups\/v1/
const RULES = /\/ioarules\/entities\/rules\/v1/

const CREATED_ENTRY = {
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  existed: false,
  id: 'rg-new-1',
  createdRuleInstanceIds: [],
}

const UPDATED_ENTRY = {
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  existed: true,
  id: 'rg-live-1',
  prior: {
    name: 'veltrix-ioa-windows',
    description: 'legacy description nobody updated',
    enabled: false,
    comment: 'created by hand in 2024',
    version: 3,
  },
  createdRuleInstanceIds: ['ri-new'],
}

registerRollbackGuardContract({
  label: 'custom-ioa-rule-groups',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('custom-ioa-rule-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: GROUPS, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=rg-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: treats a 404 on the delete as already gone', async () => {
  // "Gone" is a known answer, unlike a 5xx — a concurrent delete must be a no-op.
  const { restore } = routeFetch([{ url: GROUPS, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'veltrix-ioa-windows', platform: 'windows', existed: false, createdRuleInstanceIds: [] },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: removes only the rules this deploy added, then restores the group', async () => {
  const { calls, restore } = routeFetch([
    { url: RULES, method: 'DELETE', respond: ok() },
    { url: GROUPS, method: 'GET', respond: entityPage([{ id: 'rg-live-1', version: 12 }]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)

    const ruleDeletes = callsOfMethod(calls, 'DELETE').filter((c) => RULES.test(c.url))
    assert.equal(ruleDeletes.length, 1, `expected one rule delete, got ${describeCalls(ruleDeletes)}`)
    assert.match(ruleDeletes[0].url, /ids=ri-new/)
    assert.match(ruleDeletes[0].url, /rule_group_id=rg-live-1/)
    assert.equal(
      callsOfMethod(calls, 'DELETE').filter((c) => GROUPS.test(c.url)).length,
      0,
      'a group that existed before the deploy must never be deleted',
    )

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.id, 'rg-live-1')
    assert.equal(body?.name, 'veltrix-ioa-windows')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.enabled, false, 'the group was disabled before the deploy enabled it')
    assert.equal(
      body?.rulegroup_version,
      12,
      'deleting a rule bumps the version, so the restore must re-read it first',
    )
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: falls back to the recorded version when the re-read carries none', async () => {
  // The group came back without a version. Sending 0 would be rejected as
  // stale, so the restore uses the version deploy captured instead.
  const { calls, restore } = routeFetch([
    { url: GROUPS, method: 'GET', respond: entityPage([{ id: 'rg-live-1' }]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(
      rollbackContext({ previousState: [{ ...UPDATED_ENTRY, createdRuleInstanceIds: [] }] }),
    )

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.rulegroup_version, 3)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: a failed re-read stops the restore rather than writing a stale version', async () => {
  const { calls, restore } = routeFetch([
    { url: GROUPS, method: 'GET', respond: serverError() },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ ...UPDATED_ENTRY, createdRuleInstanceIds: [] }] }),
    )

    assert.equal(result.success, false)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      `rollback wrote after a failed read: ${describeCalls(writeCalls(calls))}`,
    )
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy converged a live group but recorded no prior body. Restoring an
  // invented default here would disable a group the customer had enabled.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'veltrix-ioa-windows',
            platform: 'windows',
            existed: true,
            id: 'rg-live-1',
            createdRuleInstanceIds: [],
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'veltrix-ioa-windows',
            platform: 'windows',
            existed: true,
            prior: { enabled: false, version: 3 },
            createdRuleInstanceIds: [],
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: GROUPS, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('custom-ioa-rule-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: GROUPS, method: 'GET', respond: entityPage([{ id: 'rg-live-1', version: 12 }]) },
    { url: GROUPS, method: 'PATCH', respond: partialFailure('rule group version is out of date') },
  ])
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ ...UPDATED_ENTRY, createdRuleInstanceIds: [] }] }),
    )

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /out of date/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: GROUPS, method: 'DELETE', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...CREATED_ENTRY, name: 'veltrix-ioa-mac', platform: 'mac', id: 'rg-new-2' }
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
