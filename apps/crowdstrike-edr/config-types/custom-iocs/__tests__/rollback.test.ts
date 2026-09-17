// rollback for custom-iocs.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — plus the one field this API
// cannot clear (expiration), which the handler has to say out loud rather than
// leave an operator believing the indicator was fully restored.

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
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/iocs\/entities\/indicators\/v1/

const HASH = 'a3f1c0de4b2955ab7788c0d1e2f3a4b5c6d7e8f90112233445566778899aabbc'

function indicator(call: RecordedCall | undefined): Record<string, unknown> | undefined {
  const indicators = bodyOf(call)?.indicators
  return Array.isArray(indicators) ? (indicators[0] as Record<string, unknown>) : undefined
}

const CREATED_ENTRY = { type: 'sha256', value: HASH, existed: false, id: 'ioc-new-1' }

const UPDATED_ENTRY = {
  type: 'sha256',
  value: HASH,
  existed: true,
  id: 'ioc-live-1',
  prior: {
    action: 'no_action',
    severity: 'informational',
    platforms: ['linux'],
    applied_globally: false,
    host_groups: ['hg-legacy'],
    expiration: '2026-02-01T00:00:00Z',
    description: 'legacy note nobody updated',
    tags: ['retired'],
  },
}

registerRollbackGuardContract({ label: 'custom-iocs', handler: rollback, entry: CREATED_ENTRY })

test('custom-iocs rollback: deletes an indicator this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=ioc-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created indicator is deleted, not patched')
  } finally {
    restore()
  }
})

test('custom-iocs rollback: treats a 404 on the delete as already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — "gone" is a known
  // answer, unlike a 5xx.
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('custom-iocs rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ type: 'sha256', value: HASH, existed: false }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('custom-iocs rollback: restores the recorded prior action and targeting', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = indicator(patches[0])
    assert.equal(body?.id, 'ioc-live-1')
    assert.equal(body?.action, 'no_action', 'the restore must carry the LIVE prior action')
    assert.equal(body?.severity, 'informational')
    assert.deepEqual(body?.platforms, ['linux'])
    assert.equal(body?.applied_globally, false)
    assert.deepEqual(body?.host_groups, ['hg-legacy'])
    assert.equal(body?.expiration, '2026-02-01T00:00:00Z')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated indicator must never be deleted')
  } finally {
    restore()
  }
})

test('custom-iocs rollback: clears a description and tags the deploy added', async () => {
  // The indicator had neither before the deploy. Leaving the deployed values in
  // place would make the rollback a silent no-op for the fields deploy set.
  const entry = {
    type: 'sha256',
    value: HASH,
    existed: true,
    id: 'ioc-live-1',
    prior: { action: 'detect', severity: 'medium', expiration: '2026-02-01T00:00:00Z' },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = indicator(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.description, '')
    assert.deepEqual(body?.tags, [])
  } finally {
    restore()
  }
})

test('custom-iocs rollback: says so when an expiration the deploy added cannot be cleared', async () => {
  // The indicator had no expiration before the deploy and the API offers no
  // verified way to remove one. Reporting a clean rollback would leave an
  // operator believing an indicator that now self-expires is back to normal.
  const entry = {
    type: 'sha256',
    value: HASH,
    existed: true,
    id: 'ioc-live-1',
    prior: { action: 'detect', severity: 'medium' },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /expirations cannot be cleared/)
    assert.equal(
      'expiration' in (indicator(callsOfMethod(calls, 'PATCH')[0]) ?? {}),
      false,
      'no invented expiration may be written',
    )
  } finally {
    restore()
  }
})

test('custom-iocs rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live indicator but recorded no prior body. Writing an
  // invented default here could downgrade a prevent rule to detect.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ type: 'sha256', value: HASH, existed: true, id: 'ioc-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('custom-iocs rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ type: 'sha256', value: HASH, existed: true, prior: { action: 'detect' } }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('custom-iocs rollback: reports a rejected delete rather than throwing', async () => {
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

test('custom-iocs rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('indicator is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored indicator')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('custom-iocs rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, id: 'ioc-live-2', value: 'b'.repeat(64) }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
