// rollback for cloud-groups.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — and above all the entries that
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
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/cloud-security\/queries\/cloud-groups\/v1/
const ENTITY = /\/cloud-security\/entities\/cloud-groups\/v1/

const CREATED_ENTRY = { name: 'prod-workloads', existed: false, id: 'grp-new-1' }

const UPDATED_ENTRY = {
  name: 'prod-workloads',
  existed: true,
  id: 'grp-live-1',
  prior: {
    description: 'legacy description nobody updated',
    business_impact: 'low',
    business_unit: 'Shared Services',
    environment: 'dev',
    owners: ['retired-owner@acme.com'],
  },
}

registerRollbackGuardContract({ label: 'cloud-groups', handler: rollback, entry: CREATED_ENTRY })

test('cloud-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['grp-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'grp-new-1', name: 'prod-workloads' }]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=grp-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('cloud-groups rollback: makes no delete when the created group is already gone', async () => {
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

test('cloud-groups rollback: restores the recorded prior values of a group it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'grp-live-1')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.business_impact, 'low')
    assert.equal(body?.business_unit, 'Shared Services')
    assert.equal(body?.environment, 'dev')
    assert.deepEqual(body?.owners, ['retired-owner@acme.com'])
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated group must never be deleted')
  } finally {
    restore()
  }
})

test('cloud-groups rollback: clears metadata the deploy added rather than leaving it behind', async () => {
  // The group had no business unit and no description before the deploy. Leaving
  // the deployed values in place would make the rollback a silent no-op for
  // exactly the fields the deploy set.
  const entry = {
    name: 'prod-workloads',
    existed: true,
    id: 'grp-live-1',
    prior: { business_impact: 'low', environment: 'dev', owners: [] },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.description, '', 'a description the deploy added must be cleared')
    assert.equal(body?.business_unit, '', 'a business unit the deploy added must be cleared')
    assert.deepEqual(body?.owners, [])
  } finally {
    restore()
  }
})

test('cloud-groups rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live group but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the group alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'prod-workloads', existed: true, id: 'grp-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'prod-workloads', existed: true, prior: { environment: 'dev' } }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-groups rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['grp-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'grp-new-1', name: 'prod-workloads' }]) },
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

test('cloud-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('cloud group is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'stage-workloads', id: 'grp-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
