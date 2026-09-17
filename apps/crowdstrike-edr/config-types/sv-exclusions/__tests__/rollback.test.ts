// rollback for sv-exclusions.
//
// The shared contract covers the refusals every config type has. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — plus the entries that must
// produce NO write, and the ["all"] sentinel that decides whether the restored
// exclusion blinds the sensor across the fleet or only on the recorded groups.

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

const QUERIES = /\/policy\/queries\/sv-exclusions\/v1/
const ENTITY = /\/policy\/entities\/sv-exclusions\/v1/

const CREATED_ENTRY = { value: '/opt/backup/agent/**', existed: false, id: 'sv-new-1' }

/** An exclusion that was scoped to one host group before the deploy widened it. */
const SCOPED_ENTRY = {
  value: '/opt/backup/agent/**',
  existed: true,
  id: 'sv-live-1',
  prior: {
    appliedGlobally: false,
    groups: ['hg-legacy-1'],
    comment: 'added by hand during an incident',
  },
}

/** An exclusion that covered the whole fleet before the deploy narrowed it. */
const GLOBAL_ENTRY = {
  value: '/opt/backup/agent/**',
  existed: true,
  id: 'sv-live-1',
  prior: { appliedGlobally: true, groups: [] },
}

registerRollbackGuardContract({ label: 'sv-exclusions', handler: rollback, entry: CREATED_ENTRY })

test('sv-exclusions rollback: deletes an exclusion this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sv-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'sv-new-1', value: '/opt/backup/agent/**' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=sv-new-1/)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a created exclusion is deleted, not patched',
    )
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: makes no delete when the created exclusion is already gone', async () => {
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

test('sv-exclusions rollback: restores the recorded prior values of an exclusion it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [SCOPED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'sv-live-1')
    assert.equal(body?.value, '/opt/backup/agent/**')
    assert.equal(body?.comment, 'added by hand during an incident')
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'an updated exclusion must never be deleted',
    )
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: restores a host-group scope rather than re-applying globally', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [SCOPED_ENTRY] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(
      body?.groups,
      ['hg-legacy-1'],
      'restoring ["all"] here would blind the sensor on every host in the tenant',
    )
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: restores a fleet-wide exclusion as ["all"], not as no groups', async () => {
  // Falcon reports a globally applied exclusion with an EMPTY groups array.
  // Replaying that empty array would leave the exclusion attached to nothing.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [GLOBAL_ENTRY] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(body?.groups, ['all'])
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Restoring an invented default here is strictly worse than leaving the
  // exclusion alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ value: '/opt/backup/agent/**', existed: true, id: 'sv-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            value: '/opt/backup/agent/**',
            existed: true,
            prior: { appliedGlobally: false, groups: ['hg-legacy-1'] },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sv-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'sv-new-1', value: '/opt/backup/agent/**' }]),
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

test('sv-exclusions rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('exclusion is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [SCOPED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored exclusion')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('sv-exclusions rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...SCOPED_ENTRY, value: '/opt/build/**', id: 'sv-live-2' }
    const result = await rollback(rollbackContext({ previousState: [SCOPED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
