// rollback for cloud-kac-policies.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two-step teardown — an enabled admission policy cannot be
// deleted, so it is disabled first — and the entries that must produce NO write
// because there is nothing safe to restore.

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

const ENTITY = /\/admission-control-policies\/entities\/policies\/v1/

const CREATED_ENTRY = { name: 'Cluster admission', existed: false, id: 'kac-new-1' }

const UPDATED_ENTRY = {
  name: 'Cluster admission',
  existed: true,
  id: 'kac-live-1',
  prior: {
    name: 'Cluster admission',
    description: 'legacy description nobody updated',
    enabled: false,
  },
}

registerRollbackGuardContract({
  label: 'cloud-kac-policies',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-kac-policies rollback: disables a policy it created before deleting it', async () => {
  // Falcon refuses to delete an enabled admission control policy, so the order
  // of these two calls is load-bearing.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 2, `expected a disable then a delete, got ${describeCalls(writes)}`)
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(bodyOf(writes[0])?.is_enabled, false)
    assert.match(writes[0].url, /ids=kac-new-1/)
    assert.equal(writes[1].method, 'DELETE')
    assert.match(writes[1].url, /ids=kac-new-1/)
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: still deletes when the pre-delete disable is rejected', async () => {
  // The disable is best-effort — the policy may already be disabled or gone.
  // Abandoning the delete because of it would leave the created policy behind.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1)
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: treats a 404 on delete as already gone', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'DELETE', respond: notFound() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, 'a policy already removed is the desired end state')
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Deploy created a policy but never recorded its id. Guessing at "the one with
  // that name" against a contains-match query could delete a different policy.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ name: 'Cluster admission', existed: false }] }),
    )

    assert.equal(vendorCalls(calls).length, 0, `rollback called: ${describeCalls(vendorCalls(calls))}`)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: restores the recorded prior values of a policy it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=kac-live-1/)

    const body = bodyOf(patches[0])
    assert.equal(body?.name, 'Cluster admission')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.is_enabled, false, 'a policy the deploy enabled must be disabled again')
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a policy that existed before the deploy must never be deleted',
    )
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: clears a description the deploy added rather than leaving it behind', async () => {
  const entry = {
    name: 'Cluster admission',
    existed: true,
    id: 'kac-live-1',
    prior: { name: 'Cluster admission', description: '', enabled: false },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.description, '')
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live policy but recorded no prior body. Patching an
  // invented default here could disable a cluster's admission gate.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'Cluster admission', existed: true, id: 'kac-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const { id: _id, ...withoutId } = UPDATED_ENTRY
    await rollback(rollbackContext({ previousState: [withoutId] }))

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: ok() },
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

test('cloud-kac-policies rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('policy is locked by another operation') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored policy')
    assert.match(String(result.message), /locked/)
  } finally {
    restore()
  }
})

test('cloud-kac-policies rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'Staging admission', id: 'kac-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
