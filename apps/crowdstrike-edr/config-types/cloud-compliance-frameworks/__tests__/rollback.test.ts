// rollback for cloud-compliance-frameworks.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created (re-resolved by name, so a concurrent delete is a no-op) and
// patch back what it overwrote — and above all the entries that must produce NO
// write because there is nothing safe to restore.

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
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/cloud-policies\/queries\/compliance\/frameworks\/v1/
const ENTITY = /\/cloud-policies\/entities\/compliance\/frameworks\/v1/

const CREATED_ENTRY = { name: 'ACME Cloud Baseline', existed: false, uuid: 'fw-new-1' }

const UPDATED_ENTRY = {
  name: 'ACME Cloud Baseline',
  existed: true,
  uuid: 'fw-live-1',
  prior: { description: 'legacy description nobody updated', active: false },
}

registerRollbackGuardContract({
  label: 'cloud-compliance-frameworks',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-compliance-frameworks rollback: deletes a framework this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fw-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ uuid: 'fw-new-1', name: 'ACME Cloud Baseline' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=fw-new-1/)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a created framework is deleted, not patched',
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks rollback: makes no delete when the created framework is already gone', async () => {
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

test('cloud-compliance-frameworks rollback: restores the recorded prior values of a framework it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=fw-live-1/)

    const body = bodyOf(patches[0])
    assert.equal(body?.name, 'ACME Cloud Baseline')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.active, false, 'a framework the deploy activated must be deactivated again')
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a framework that existed before the deploy must never be deleted',
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live framework but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the framework alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'ACME Cloud Baseline', existed: true, uuid: 'fw-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks rollback: writes nothing for an updated entry whose uuid was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'ACME Cloud Baseline', existed: true, prior: { description: 'legacy', active: false } },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fw-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ uuid: 'fw-new-1', name: 'ACME Cloud Baseline' }]),
    },
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

test('cloud-compliance-frameworks rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('framework is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored framework')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'ACME Staging Baseline', uuid: 'fw-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
