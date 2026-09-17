// rollback for it-automation-scheduled-tasks.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch the LIVE prior recurrence back onto what it overwrote —
// and the entries that must produce NO write because there is nothing safe to
// restore.

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

const QUERIES = /\/it-automation\/queries\/scheduled-tasks\/v1/
const ENTITY = /\/it-automation\/entities\/scheduled-tasks\/v1/

const CREATED_ENTRY = {
  name: 'nightly-patch-sweep',
  taskId: 'task-7781',
  existed: false,
  id: 'sched-new-1',
}

/** The recurrence the tenant held before the deploy overwrote it. */
const LIVE_SCHEDULE = {
  frequency: 'Weekly',
  interval: 3,
  time: '13:30',
  timezone: 'America/New_York',
  days_of_week: ['Sunday'],
}

const UPDATED_ENTRY = {
  name: 'nightly-patch-sweep',
  taskId: 'task-7781',
  existed: true,
  id: 'sched-live-1',
  prior: { is_active: false, schedule: LIVE_SCHEDULE },
}

registerRollbackGuardContract({
  label: 'it-automation-scheduled-tasks',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('it-automation-scheduled-tasks rollback: deletes a scheduled task this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sched-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'sched-new-1', task_id: 'task-7781' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=sched-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created schedule is deleted, not patched')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks rollback: makes no delete when the created task is already gone', async () => {
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

test('it-automation-scheduled-tasks rollback: restores the LIVE prior schedule, not the desired one', async () => {
  // This is the whole point of the rollback record for this config type: the
  // recurrence that goes back must be the weekly 13:30 New York one the tenant
  // held, never the daily 02:00 UTC one the canvas asked for.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'sched-live-1')
    assert.equal(body?.task_id, 'task-7781')
    assert.equal(body?.is_active, false, 'a schedule the deploy switched on must be switched off again')
    assert.deepEqual(body?.schedule, LIVE_SCHEDULE)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated schedule must never be deleted')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live recurrence but recorded no prior. Restoring an
  // invented default here would schedule the task at a time nobody chose.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'nightly-patch-sweep', taskId: 'task-7781', existed: true, id: 'sched-live-1' },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'nightly-patch-sweep',
            taskId: 'task-7781',
            existed: true,
            prior: { is_active: false, schedule: LIVE_SCHEDULE },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks rollback: reports a rejected restore rather than throwing', async () => {
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

test('it-automation-scheduled-tasks rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('scheduled task is locked') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored schedule')
    assert.match(String(result.message), /locked/)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'weekly-inventory', taskId: 'task-8892', id: 'sched-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
