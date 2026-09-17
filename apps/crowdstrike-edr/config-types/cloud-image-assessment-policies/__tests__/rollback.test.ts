// rollback for cloud-image-assessment-policies.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that a restore must put the whole `policy_data` back — the
// action and thresholds that decide which images are admitted — and that an
// entry with no id or no captured prior must produce NO write at all rather than
// an invented default policy.

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

const ENTITY = /\/container-security\/entities\/image-assessment-policies\/v1/

const CREATED_ENTRY = { name: 'Registry gate', existed: false, id: 'pol-new-1' }

const PRIOR_POLICY_DATA = {
  rules: [{ action: 'alert', policy_rules_data: { conditions: [{ prop: 'severity', value: 'high' }] } }],
}

const UPDATED_ENTRY = {
  name: 'Registry gate',
  existed: true,
  id: 'pol-live-1',
  prior: {
    name: 'Registry gate',
    description: 'legacy description nobody updated',
    is_enabled: false,
    policy_data: PRIOR_POLICY_DATA,
  },
}

registerRollbackGuardContract({
  label: 'cloud-image-assessment-policies',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-image-assessment-policies rollback: deletes a policy this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /[?&]id=pol-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created policy is deleted, not patched')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: treats a 404 on delete as already gone', async () => {
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, 'a policy already removed is the desired end state')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Deploy created a policy but never recorded its id. Deleting "the one with
  // that name" would be a guess against a collection this handler cannot query.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ name: 'Registry gate', existed: false }] }),
    )

    assert.equal(vendorCalls(calls).length, 0, `rollback called: ${describeCalls(vendorCalls(calls))}`)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: restores the recorded prior values of a policy it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /[?&]id=pol-live-1/)

    const body = bodyOf(patches[0])
    assert.equal(body?.name, 'Registry gate')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.is_enabled, false)
    assert.deepEqual(body?.policy_data, PRIOR_POLICY_DATA, 'the prior action and thresholds must come back')
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a policy that existed before the deploy must never be deleted',
    )
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: clears a description the deploy added rather than leaving it behind', async () => {
  // The policy had no description before the deploy. Leaving the deployed value
  // in place would make the rollback a silent no-op for that field.
  const entry = {
    name: 'Registry gate',
    existed: true,
    id: 'pol-live-1',
    prior: { name: 'Registry gate', is_enabled: false },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.description, '')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live policy but recorded no prior body. Patching an
  // invented default here would replace a working gate with an empty one.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'Registry gate', existed: true, id: 'pol-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const { id: _id, ...withoutId } = UPDATED_ENTRY
    await rollback(rollbackContext({ previousState: [withoutId] }))

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('cloud-image-assessment-policies rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('policy is managed by a policy group') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored policy')
    assert.match(String(result.message), /policy group/)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'Staging gate', id: 'pol-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
