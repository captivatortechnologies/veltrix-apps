// rollback for ml-exclusions.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — plus the entries that must
// produce NO write, and the ["all"] sentinel that decides whether a restored
// exclusion protects the whole fleet or two host groups.

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

const QUERIES = /\/policy\/queries\/ml-exclusions\/v1/
const ENTITY = /\/policy\/entities\/ml-exclusions\/v1/

const CREATED_ENTRY = { value: '/opt/vendor/agent/**', existed: false, id: 'ml-new-1' }

/** An exclusion that was scoped to one host group before the deploy widened it. */
const SCOPED_ENTRY = {
  value: '/opt/vendor/agent/**',
  existed: true,
  id: 'ml-live-1',
  prior: {
    excludedFrom: ['extraction'],
    appliedGlobally: false,
    groups: ['hg-legacy-1'],
    comment: 'added by hand during an incident',
  },
}

/** An exclusion that covered the whole fleet before the deploy narrowed it. */
const GLOBAL_ENTRY = {
  value: '/opt/vendor/agent/**',
  existed: true,
  id: 'ml-live-1',
  prior: { excludedFrom: ['blocking'], appliedGlobally: true, groups: [] },
}

registerRollbackGuardContract({ label: 'ml-exclusions', handler: rollback, entry: CREATED_ENTRY })

test('ml-exclusions rollback: deletes an exclusion this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ml-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'ml-new-1', value: '/opt/vendor/agent/**' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=ml-new-1/)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a created exclusion is deleted, not patched',
    )
  } finally {
    restore()
  }
})

test('ml-exclusions rollback: makes no delete when the created exclusion is already gone', async () => {
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

test('ml-exclusions rollback: restores the recorded prior values of an exclusion it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [SCOPED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'ml-live-1')
    assert.equal(body?.value, '/opt/vendor/agent/**')
    assert.deepEqual(body?.excluded_from, ['extraction'])
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

test('ml-exclusions rollback: restores a host-group scope rather than re-applying globally', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [SCOPED_ENTRY] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(
      body?.groups,
      ['hg-legacy-1'],
      'restoring ["all"] here would widen an exclusion that was never fleet-wide',
    )
  } finally {
    restore()
  }
})

test('ml-exclusions rollback: restores a fleet-wide exclusion as ["all"], not as no groups', async () => {
  // The prior state was global, which the API reports as applied_globally:true
  // with an EMPTY groups array. Replaying that empty array would leave the
  // exclusion attached to nothing and stop it protecting any host.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [GLOBAL_ENTRY] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(body?.groups, ['all'])
  } finally {
    restore()
  }
})

test('ml-exclusions rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live exclusion but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the exclusion alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ value: '/opt/vendor/agent/**', existed: true, id: 'ml-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ml-exclusions rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            value: '/opt/vendor/agent/**',
            existed: true,
            prior: { excludedFrom: ['blocking'], appliedGlobally: false, groups: ['hg-legacy-1'] },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ml-exclusions rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ml-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'ml-new-1', value: '/opt/vendor/agent/**' }]),
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

test('ml-exclusions rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
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

test('ml-exclusions rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...SCOPED_ENTRY, value: '/opt/build/**', id: 'ml-live-2' }
    const result = await rollback(rollbackContext({ previousState: [SCOPED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
