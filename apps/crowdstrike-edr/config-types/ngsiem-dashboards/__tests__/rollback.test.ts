// rollback for ngsiem-dashboards.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the SPLIT surface — a created dashboard is deleted through
// the NON-template collection after being re-resolved by name, while an updated
// one is patched back through the template collection using the recorded id —
// and the entries that must produce NO write at all.

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

const QUERIES = /\/ngsiem-content\/queries\/dashboards\/v1/
const TEMPLATE = /\/ngsiem-content\/entities\/dashboards-template\/v1/
const DELETE_COLLECTION = /\/ngsiem-content\/entities\/dashboards\/v1/

const CREATED_ENTRY = { name: 'authentication-overview', existed: false, id: 'dash-new-1' }

const UPDATED_ENTRY = {
  name: 'authentication-overview',
  existed: true,
  id: 'dash-live-1',
  prior: {
    description: 'legacy description nobody updated',
    definition: { widgets: [{ title: 'Old widget', query: '#event_simpleName=OldEvent' }] },
    shared: false,
  },
}

registerRollbackGuardContract({
  label: 'ngsiem-dashboards',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('ngsiem-dashboards rollback: deletes a created dashboard through the non-template collection', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['dash-new-1']) },
    {
      url: TEMPLATE,
      method: 'GET',
      respond: entityPage([{ id: 'dash-new-1', name: 'authentication-overview' }]),
    },
    { url: DELETE_COLLECTION, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=dash-new-1/)
    // The template collection has no DELETE — routing the delete there would 404
    // and leave the dashboard behind.
    assert.equal(
      /dashboards-template/.test(deletes[0].url),
      false,
      `delete went to the template collection: ${deletes[0].url}`,
    )
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created dashboard is deleted, not patched')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards rollback: makes no delete when the created dashboard is already gone', async () => {
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

test('ngsiem-dashboards rollback: restores the recorded prior values of a dashboard it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: TEMPLATE, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.ok(body, 'the restore carried no JSON body')
    assert.equal(body.id, 'dash-live-1')
    assert.equal(body.name, 'authentication-overview')
    assert.equal(body.description, 'legacy description nobody updated')
    assert.deepEqual(body.definition, UPDATED_ENTRY.prior.definition)
    assert.equal(body.shared, false, 'a dashboard the deploy shared must be made private again')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated dashboard must never be deleted')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards rollback: clears a description the deploy added rather than leaving it behind', async () => {
  // The dashboard had no description before the deploy. Leaving the deployed
  // value in place would make the rollback a silent no-op for that field.
  const entry = {
    name: 'authentication-overview',
    existed: true,
    id: 'dash-live-1',
    prior: { definition: { widgets: [] }, shared: false },
  }
  const { calls, restore } = routeFetch([{ url: TEMPLATE, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.description, '')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live dashboard but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving it alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'authentication-overview', existed: true, id: 'dash-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'authentication-overview', existed: true, prior: { shared: false } },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['dash-new-1']) },
    {
      url: TEMPLATE,
      method: 'GET',
      respond: entityPage([{ id: 'dash-new-1', name: 'authentication-overview' }]),
    },
    {
      url: DELETE_COLLECTION,
      method: 'DELETE',
      respond: forbidden('access denied, authorization failed'),
    },
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

test('ngsiem-dashboards rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: TEMPLATE, method: 'PATCH', respond: partialFailure('dashboard is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored dashboard')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: TEMPLATE,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'detection-overview', id: 'dash-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
