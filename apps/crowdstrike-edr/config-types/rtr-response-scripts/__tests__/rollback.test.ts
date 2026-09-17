// rollback for rtr-response-scripts.
//
// The shared contract covers the refusals every config type has. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, PATCH the prior script body back onto what it overwrote — and
// the entries that must produce NO write because there is nothing safe to
// restore. The restore goes out over the same multipart-only endpoint the deploy
// used, so the assertions read form fields, not a JSON body.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  callsOfMethod,
  describeCalls,
  forbidden,
  formField,
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

const ENTITY = /\/real-time-response\/entities\/scripts\/v1/

const CREATED_ENTRY = { name: 'collect-forensics', existed: false, id: 'scr-new-1' }

const PRIOR = {
  description: 'legacy description nobody updated',
  platform: ['linux'],
  permission_type: 'private',
  content: 'echo legacy',
}

const UPDATED_ENTRY = { name: 'collect-forensics', existed: true, id: 'scr-live-1', prior: PRIOR }

registerRollbackGuardContract({
  label: 'rtr-response-scripts',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('rtr-response-scripts rollback: deletes a script this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=scr-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created script is deleted, not patched')
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Without the id there is no safe delete to make — guessing one would remove
  // a script somebody else relies on.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ name: 'collect-forensics', existed: false }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: restores the prior script body of a script it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    assert.equal(formField(patches[0], 'id'), 'scr-live-1')
    assert.equal(formField(patches[0], 'name'), 'collect-forensics')
    assert.equal(formField(patches[0], 'description'), 'legacy description nobody updated')
    assert.equal(formField(patches[0], 'permission_type'), 'private')
    assert.equal(formField(patches[0], 'platform'), 'linux', 'an array platform restores as its first value')
    assert.equal(formField(patches[0], 'content'), 'echo legacy', 'the LIVE prior body, not the desired one')
    assert.match(String(formField(patches[0], 'comments_for_audit_log')), /Rollback by Veltrix/)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated script must never be deleted')
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: sends no content field when deploy never captured the prior body', async () => {
  // GET did not return the script body, so there is nothing to restore it to.
  // Sending an empty `content` would blank a working script outright.
  //
  // NOT ASSERTED, deliberately: what this rollback REPORTS in that case. It
  // still returns success with "Rolled back 1 RTR script(s)" although the field
  // that matters most was left holding the deployed body — see the report.
  const entry = {
    name: 'collect-forensics',
    existed: true,
    id: 'scr-live-1',
    prior: { description: 'legacy description nobody updated', permission_type: 'private' },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const patch = callsOfMethod(calls, 'PATCH')[0]
    assert.equal(formField(patch, 'content'), null, 'an uncaptured body must not be clobbered with an empty one')
    assert.equal(formField(patch, 'platform'), null, 'an uncaptured platform must not be invented either')
    assert.equal(formField(patch, 'description'), 'legacy description nobody updated')
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live script but recorded no prior at all. Restoring an
  // invented default here is strictly worse than leaving the script alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'collect-forensics', existed: true, id: 'scr-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'collect-forensics', existed: true, prior: PRIOR }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: treats a 404 on delete as already undone', async () => {
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

test('rtr-response-scripts rollback: reports a rejected restore rather than throwing', async () => {
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

test('rtr-response-scripts rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('script is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored script')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('rtr-response-scripts rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'isolate-host', id: 'scr-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
