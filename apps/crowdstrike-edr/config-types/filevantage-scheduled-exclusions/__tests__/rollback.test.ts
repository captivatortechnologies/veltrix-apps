// rollback for filevantage-scheduled-exclusions.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that a created exclusion is re-resolved by name inside its
// policy before being deleted (so a concurrent delete is a no-op rather than a
// hard error), and that an updated one is patched back to the window, scope and
// recurrence deploy read off the live tenant.

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
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/filevantage\/queries\/policy-scheduled-exclusions\/v1/
const ENTITY = /\/filevantage\/entities\/policy-scheduled-exclusions\/v1/

const CREATED_ENTRY = {
  name: 'weekend-patch-window',
  policyId: 'fvp-1',
  existed: false,
  id: 'fvse-new-1',
}

const UPDATED_ENTRY = {
  name: 'weekend-patch-window',
  policyId: 'fvp-1',
  existed: true,
  id: 'fvse-live-1',
  prior: {
    description: 'legacy note nobody updated',
    timezone: 'America/New_York',
    schedule_start: '2025-06-01T00:00:00Z',
    schedule_end: '2025-12-31T00:00:00Z',
    processes: 'C:\\Legacy\\old.exe',
    users: 'ACME\\legacy',
    repeated: { frequency: 'daily', all_day: true },
  },
}

registerRollbackGuardContract({
  label: 'filevantage-scheduled-exclusions',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('filevantage-scheduled-exclusions rollback: deletes an exclusion this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'fvse-new-1', name: 'weekend-patch-window' }]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=fvse-new-1/)
    assert.match(deletes[0].url, /policy_id=fvp-1/, 'the delete endpoint requires the parent policy')
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created exclusion is deleted, not patched')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: makes no delete when the created exclusion is already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the policy-wide id query happened to return.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: deletes nothing when only another exclusion is left in the policy', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-other']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'fvse-other', name: 'nightly-backup-window' }]) },
  ])
  try {
    await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(
      writeCalls(calls).length,
      0,
      `rollback deleted somebody else's exclusion: ${describeCalls(writeCalls(calls))}`,
    )
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: treats a 404 on the delete as already gone', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'fvse-new-1', name: 'weekend-patch-window' }]) },
    { url: ENTITY, method: 'DELETE', respond: notFound() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: restores the recorded prior window, scope and recurrence', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'fvse-live-1')
    assert.equal(body?.policy_id, 'fvp-1')
    assert.equal(body?.timezone, 'America/New_York', 'the restore carries the LIVE prior timezone')
    assert.equal(body?.schedule_start, '2025-06-01T00:00:00Z')
    assert.equal(body?.schedule_end, '2025-12-31T00:00:00Z')
    assert.equal(body?.processes, 'C:\\Legacy\\old.exe')
    assert.equal(body?.users, 'ACME\\legacy')
    assert.deepEqual(body?.repeated, { frequency: 'daily', all_day: true })
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated exclusion must never be deleted')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: clears a description and scope the deploy added', async () => {
  // The exclusion had neither before the deploy. Leaving the deployed values in
  // place would keep suppressing change events for whatever the deploy scoped.
  const entry = {
    name: 'weekend-patch-window',
    policyId: 'fvp-1',
    existed: true,
    id: 'fvse-live-1',
    prior: { timezone: 'Etc/UTC', schedule_start: '2025-06-01T00:00:00Z' },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.description, '')
    assert.equal(body?.processes, '')
    assert.equal(body?.users, '')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: writes no invented recurrence when the prior had none', async () => {
  // DEFECT (reported, not blessed): a one-time window the deploy turned into a
  // recurring one cannot be put back — `repeated` is only sent when a prior one
  // was recorded, so the recurrence deploy added survives the rollback and the
  // result still reports success. What is asserted is only the half that is
  // certainly right: nothing invented is written. The success claim is NOT
  // asserted here.
  const entry = {
    name: 'weekend-patch-window',
    policyId: 'fvp-1',
    existed: true,
    id: 'fvse-live-1',
    prior: { timezone: 'Etc/UTC', schedule_start: '2025-06-01T00:00:00Z' },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal('repeated' in (bodyOf(callsOfMethod(calls, 'PATCH')[0]) ?? {}), false)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live exclusion but recorded no prior body. An invented
  // default here would leave a blind spot on a schedule nobody chose.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'weekend-patch-window', policyId: 'fvp-1', existed: true, id: 'fvse-live-1' },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'weekend-patch-window', policyId: 'fvp-1', existed: true, prior: UPDATED_ENTRY.prior },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'fvse-new-1', name: 'weekend-patch-window' }]) },
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

test('filevantage-scheduled-exclusions rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('exclusion is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored exclusion')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'nightly-backup-window', id: 'fvse-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
