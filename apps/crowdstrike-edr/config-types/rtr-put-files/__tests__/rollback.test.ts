// rollback for rtr-put-files.
//
// The shared contract covers the refusals every config type has. What is
// specific here follows from put-file immutability: deploy either created a
// file, REPLACED one (delete + recreate) or left one alone, and rollback can
// only ever delete what deploy uploaded — the original bytes are not readable
// from the API, so a replaced file must be reported as unrestorable rather than
// silently declared rolled back.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
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

const ENTITY = /\/real-time-response\/entities\/put-files\/v1/

const CREATED_ENTRY = { name: 'isolate-host.ps1', existed: false, id: 'pf-new-1' }

const REPLACED_ENTRY = {
  name: 'isolate-host.ps1',
  existed: true,
  replaced: true,
  id: 'pf-new-2',
  priorDescription: 'legacy description nobody updated',
}

const UNTOUCHED_ENTRY = { name: 'isolate-host.ps1', existed: true, replaced: false, id: 'pf-live-1' }

registerRollbackGuardContract({ label: 'rtr-put-files', handler: rollback, entry: CREATED_ENTRY })

test('rtr-put-files rollback: deletes a put-file this deploy staged', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=pf-new-1/)
  } finally {
    restore()
  }
})

test('rtr-put-files rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Without the id there is no safe delete to make — guessing one would remove
  // somebody else's staged file.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ name: 'isolate-host.ps1', existed: false }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('rtr-put-files rollback: deletes the replacement and says the original bytes cannot be restored', async () => {
  // The RTR Admin API never returns a put-file's content, so this rollback is
  // genuinely partial. Reporting success without saying so would leave an
  // operator believing the original payload is staged again when it is not.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [REPLACED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(callsOfMethod(calls, 'DELETE')[0].url, /ids=pf-new-2/)
    assert.match(String(result.message), /cannot be restored automatically/)
    assert.match(String(result.message), /isolate-host\.ps1/)
  } finally {
    restore()
  }
})

test('rtr-put-files rollback: leaves a put-file the deploy never changed alone', async () => {
  // `existed && !replaced` means deploy found matching bytes and did nothing.
  // Deleting here would destroy a file this deployment never wrote.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(rollbackContext({ previousState: [UNTOUCHED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
    assert.equal(
      /cannot be restored automatically/.test(String(result.message)),
      false,
      'nothing was replaced, so nothing is unrestorable',
    )
  } finally {
    restore()
  }
})

test('rtr-put-files rollback: treats a 404 on delete as already undone', async () => {
  // "Gone" is a known answer, not an unknown one — a concurrent delete must not
  // fail the rollback.
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rtr-put-files rollback: reports a rejected delete rather than throwing', async () => {
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

test('rtr-put-files rollback: treats HTTP 200 with a populated errors[] as a failed delete', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: partialFailure('put-file is in use by a session') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a deleted file')
    assert.match(String(result.message), /in use by a session/)
  } finally {
    restore()
  }
})

test('rtr-put-files rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { name: 'collect.ps1', existed: false, id: 'pf-new-3' }
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
