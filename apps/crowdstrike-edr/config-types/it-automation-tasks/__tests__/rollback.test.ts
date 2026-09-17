// rollback for it-automation-tasks.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch the prior script/osquery back onto what it overwrote —
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

const QUERIES = /\/it-automation\/queries\/tasks\/v1/
const ENTITY = /\/it-automation\/entities\/tasks\/v1/

const CREATED_ENTRY = { name: 'clear-stale-temp', existed: false, id: 'task-new-1' }

const PRIOR = {
  description: 'legacy description nobody updated',
  task_type: 'query',
  os_query: 'SELECT name FROM processes',
  remediations: { windows: { content: 'Remove-Item -Path /tmp/legacy -Recurse' } },
  task_parameters: [{ key: 'legacyParam' }],
}

const UPDATED_ENTRY = {
  name: 'clear-stale-temp',
  existed: true,
  id: 'task-live-1',
  prior: PRIOR,
}

registerRollbackGuardContract({
  label: 'it-automation-tasks',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('it-automation-tasks rollback: deletes a task this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['task-new-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'task-new-1', name: 'clear-stale-temp' }]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=task-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created task is deleted, not patched')
  } finally {
    restore()
  }
})

test('it-automation-tasks rollback: makes no delete when the created task is already gone', async () => {
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

test('it-automation-tasks rollback: restores the prior script and osquery of a task it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'task-live-1')
    assert.equal(body?.name, 'clear-stale-temp')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.task_type, 'query')
    assert.equal(body?.os_query, 'SELECT name FROM processes')
    assert.deepEqual(body?.remediations, PRIOR.remediations)
    assert.deepEqual(body?.task_parameters, [{ key: 'legacyParam' }])
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated task must never be deleted')
  } finally {
    restore()
  }
})

test('it-automation-tasks rollback: clears parameters the deploy added rather than leaving them behind', async () => {
  // The task took no input parameters before the deploy. Leaving the deployed
  // list in place would make the rollback a silent no-op for that field.
  const entry = { name: 'clear-stale-temp', existed: true, id: 'task-live-1', prior: { task_type: 'query' } }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(body?.task_parameters, [])
    assert.equal(body?.description, '', 'a description the deploy added must be cleared')
  } finally {
    restore()
  }
})

test('it-automation-tasks rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live task but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the task alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'clear-stale-temp', existed: true, id: 'task-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-tasks rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'clear-stale-temp', existed: true, prior: PRIOR }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('it-automation-tasks rollback: reports a rejected restore rather than throwing', async () => {
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

test('it-automation-tasks rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('task is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored task')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('it-automation-tasks rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'collect-inventory', id: 'task-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
