// rollback for it-automation-policies.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the three branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote, and reverse a host-group
// assignment ONLY when this deploy actually changed one — plus the entries that
// must produce NO write because there is nothing safe to restore.

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
  idsPage,
  leaksSecret,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/it-automation\/queries\/policies\/v1/
const ENTITY = /\/it-automation\/entities\/policies\/v1/
const HOST_GROUPS = /\/it-automation\/entities\/policies-host-groups\/v1/

const CREATED_ENTRY = {
  name: 'win-it-automation',
  platform: 'Windows',
  existed: false,
  id: 'pol-new-1',
}

const PRIOR = {
  description: 'legacy description nobody updated',
  enabled: false,
  config: {
    execution: { enable_script_execution: false, execution_timeout: 1, execution_timeout_unit: 'Minutes' },
    concurrency: { concurrent_host_limit: 5 },
  },
  hostGroups: ['hg-legacy-9'],
  hostGroupsChanged: false,
}

const UPDATED_ENTRY = {
  name: 'win-it-automation',
  platform: 'Windows',
  existed: true,
  id: 'pol-live-1',
  prior: PRIOR,
}

const policyPatches = (calls: RecordedCall[]) =>
  callsOfMethod(calls, 'PATCH').filter((call) => ENTITY.test(call.url))

const hostGroupPatches = (calls: RecordedCall[]) =>
  callsOfMethod(calls, 'PATCH').filter((call) => HOST_GROUPS.test(call.url))

registerRollbackGuardContract({
  label: 'it-automation-policies',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('it-automation-policies rollback: deletes a policy this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pol-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'pol-new-1', name: 'win-it-automation' }]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=pol-new-1/)
    assert.equal(policyPatches(calls).length, 0, 'a created policy is deleted, not patched')
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: makes no delete when the created policy is already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the id query happened to return.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: restores the recorded prior values of a policy it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = policyPatches(calls)
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'pol-live-1')
    assert.equal(body?.name, 'win-it-automation')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.is_enabled, false, 'a policy the deploy enabled must be disabled again')
    assert.deepEqual(body?.config, PRIOR.config)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated policy must never be deleted')
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: reverses a host-group assignment this deploy made', async () => {
  const entry = { ...UPDATED_ENTRY, prior: { ...PRIOR, hostGroupsChanged: true } }
  const { calls, restore } = routeFetch([
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(result.success, true)
    const assigns = hostGroupPatches(calls)
    assert.equal(assigns.length, 1, `expected one host-group restore, got ${describeCalls(assigns)}`)
    const body = bodyOf(assigns[0])
    assert.equal(body?.policy_id, 'pol-live-1')
    assert.deepEqual(body?.host_group_ids, ['hg-legacy-9'], 'the LIVE prior groups, not the desired ones')
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: leaves host groups alone when this deploy never changed them', async () => {
  // `hostGroupsChanged: false` means the live assignment already matched, so
  // rewriting it here would undo a change somebody else legitimately made.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(hostGroupPatches(calls).length, 0, 'an unchanged assignment must not be rewritten')
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live policy but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the policy alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'win-it-automation', platform: 'Windows', existed: true, id: 'pol-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'win-it-automation', platform: 'Windows', existed: true, prior: PRIOR }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: reports a rejected restore rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('policy is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored policy')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('it-automation-policies rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'linux-it-automation', id: 'pol-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
