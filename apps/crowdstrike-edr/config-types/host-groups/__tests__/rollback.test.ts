// rollback for host-groups.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — and above all that the rule it
// restores is the LIVE prior rule deploy captured. Restoring the DESIRED rule
// would leave the group targeting exactly the hosts the rollback is undoing.

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

const ENTITY = /\/devices\/entities\/host-groups\/v1/

function resource(call: RecordedCall | undefined): Record<string, unknown> | undefined {
  const resources = bodyOf(call)?.resources
  return Array.isArray(resources) ? (resources[0] as Record<string, unknown>) : undefined
}

const CREATED_ENTRY = { name: 'prod-servers', existed: false, id: 'hg-new-1' }

const UPDATED_ENTRY = {
  name: 'prod-servers',
  existed: true,
  id: 'hg-live-1',
  prior: {
    name: 'prod-servers',
    description: 'legacy description nobody updated',
    assignment_rule: "platform_name:'Linux'",
  },
}

registerRollbackGuardContract({ label: 'host-groups', handler: rollback, entry: CREATED_ENTRY })

test('host-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=hg-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('host-groups rollback: treats a 404 on the delete as already gone', async () => {
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

test('host-groups rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Deploy recorded that it created something but never got an id back. There is
  // nothing safe to delete, and deleting whatever a name lookup returned would
  // remove a group this deployment never created.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(rollbackContext({ previousState: [{ name: 'prod-servers', existed: false }] }))

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)

    // ...and it says so. The entry used to be counted as reverted anyway, so the
    // handler returned "Rolled back 1 host group(s)" and success having issued
    // zero calls — turning a stale group into a stale group nobody looks for.
    assert.equal(result.success, false, 'an entry that could not be rolled back is not a clean revert')
    assert.match(String(result.message), /Not rolled back/)
    assert.match(String(result.message), /prod-servers/)
  } finally {
    restore()
  }
})

test('host-groups rollback: restores the recorded prior assignment rule of a group it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = resource(patches[0])
    assert.equal(body?.id, 'hg-live-1')
    assert.equal(body?.name, 'prod-servers')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(
      body?.assignment_rule,
      "platform_name:'Linux'",
      'the restore must carry the LIVE prior rule, never the rule the deploy wanted',
    )
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated group must never be deleted')
  } finally {
    restore()
  }
})

test('host-groups rollback: clears a description the deploy added rather than leaving it behind', async () => {
  // The group had no description before the deploy, which deploy captured as an
  // explicit empty. Leaving the deployed text in place would make the rollback a
  // silent no-op for exactly the field the deploy set.
  const entry = {
    name: 'prod-servers',
    existed: true,
    id: 'hg-live-1',
    prior: { name: 'prod-servers', description: '', assignment_rule: "platform_name:'Linux'" },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(resource(callsOfMethod(calls, 'PATCH')[0])?.description, '')
  } finally {
    restore()
  }
})

test('host-groups rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live group but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the group alone —
  // an invented assignment rule silently retargets every policy on the group.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'prod-servers', existed: true, id: 'hg-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('host-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'prod-servers', existed: true, prior: { assignment_rule: "platform_name:'Linux'" } },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('host-groups rollback: reports a rejected delete rather than throwing', async () => {
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

test('host-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('host group is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('host-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'stage-servers', id: 'hg-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
