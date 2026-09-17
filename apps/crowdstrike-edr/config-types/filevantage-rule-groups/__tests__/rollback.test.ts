// rollback for filevantage-rule-groups.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that an UPDATED group is not deleted — it belonged to the
// customer before the deploy — so rollback removes only the rules this deploy
// added (by the ids it recorded, each carrying its parent group) and then puts
// the group's own name and description back.

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

const RULES = /\/filevantage\/entities\/rule-groups-rules\/v1/
const GROUPS = /\/filevantage\/entities\/rule-groups\/v1/

const CREATED_ENTRY = {
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  existed: false,
  id: 'fvrg-new-1',
  createdRuleIds: [],
}

const UPDATED_ENTRY = {
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  existed: true,
  id: 'fvrg-live-1',
  prior: { name: 'veltrix-fim-system', description: 'legacy description nobody updated' },
  createdRuleIds: ['fvr-new'],
}

registerRollbackGuardContract({
  label: 'filevantage-rule-groups',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('filevantage-rule-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: GROUPS, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=fvrg-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: treats a 404 on the delete as already gone', async () => {
  // "Gone" is a known answer, unlike a 5xx — a concurrent delete must be a no-op.
  const { restore } = routeFetch([{ url: GROUPS, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'veltrix-fim-system', type: 'WindowsFiles', existed: false, createdRuleIds: [] },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: removes only the rules this deploy added, then restores the group', async () => {
  const { calls, restore } = routeFetch([
    { url: RULES, method: 'DELETE', respond: ok() },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)

    const ruleDeletes = callsOfMethod(calls, 'DELETE').filter((c) => RULES.test(c.url))
    assert.equal(ruleDeletes.length, 1, `expected one rule delete, got ${describeCalls(ruleDeletes)}`)
    assert.match(ruleDeletes[0].url, /ids=fvr-new/)
    assert.match(ruleDeletes[0].url, /rule_group_id=fvrg-live-1/)
    assert.equal(
      callsOfMethod(calls, 'DELETE').filter((c) => GROUPS.test(c.url)).length,
      0,
      'a group that existed before the deploy must never be deleted',
    )

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.id, 'fvrg-live-1')
    assert.equal(body?.name, 'veltrix-fim-system')
    assert.equal(body?.description, 'legacy description nobody updated')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: treats a 404 on a rule delete as already gone', async () => {
  const { restore } = routeFetch([
    { url: RULES, method: 'DELETE', respond: notFound() },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: clears a description the deploy added rather than leaving it behind', async () => {
  const entry = {
    ...UPDATED_ENTRY,
    createdRuleIds: [],
    prior: { name: 'veltrix-fim-system', description: '' },
  }
  const { calls, restore } = routeFetch([{ url: GROUPS, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.description, '')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy converged a live group but recorded no prior body. Renaming it to an
  // invented default is strictly worse than leaving it alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'veltrix-fim-system',
            type: 'WindowsFiles',
            existed: true,
            id: 'fvrg-live-1',
            createdRuleIds: [],
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'veltrix-fim-system',
            type: 'WindowsFiles',
            existed: true,
            prior: { description: 'legacy description nobody updated' },
            createdRuleIds: [],
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: reports a rejected delete rather than throwing', async () => {
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

test('filevantage-rule-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: RULES, method: 'DELETE', respond: ok() },
    { url: GROUPS, method: 'PATCH', respond: partialFailure('rule group is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: GROUPS, method: 'DELETE', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...CREATED_ENTRY, name: 'veltrix-fim-registry', id: 'fvrg-new-2' }
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
