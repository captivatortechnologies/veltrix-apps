// rollback for mssp-cid-groups.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that rollback must restore the LIVE prior membership the
// deploy recorded — not the membership the canvas wanted — and must make NO
// call at all for an entry it cannot restore safely.

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
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY_WRITE = /\/mssp\/entities\/cid-groups\/v1/
const MEMBERS_WRITE = /\/mssp\/entities\/cid-group-members\/v1/

const CID_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const CID_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'
const CID_DEPARTED = '0123456789abcdef0123456789abcdef'

const CREATED_ENTRY = {
  name: 'Tier 1 managed customers',
  existed: false,
  id: 'cg-new-1',
  memberDelta: { added: [CID_A, CID_B], removed: [] },
}

const UPDATED_ENTRY = {
  name: 'Tier 1 managed customers',
  existed: true,
  id: 'cg-live-1',
  prior: { name: 'Tier 1 managed customers', description: 'legacy description nobody updated' },
  memberDelta: { added: [CID_B], removed: [CID_DEPARTED] },
}

registerRollbackGuardContract({ label: 'mssp-cid-groups', handler: rollback, entry: CREATED_ENTRY })

test('mssp-cid-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY_WRITE, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /cid_group_ids=cg-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: treats a 404 on the delete as the group already being gone', async () => {
  const { restore } = routeFetch([{ url: ENTITY_WRITE, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '"gone" is a known answer, not a failure')
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: restores the LIVE prior membership, not the desired one', async () => {
  // The deploy added CID_B and removed CID_DEPARTED. Rollback must put the
  // tenant back exactly there: revoke CID_B, re-grant CID_DEPARTED, and leave
  // CID_A — which the deploy never touched — alone.
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'DELETE', respond: ok() },
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    { url: ENTITY_WRITE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)

    const remove = callsOfMethod(calls, 'DELETE').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(remove, 'the customer the deploy added was never revoked')
    const removed = (bodyOf(remove)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(removed?.cid_group_id, 'cg-live-1')
    assert.deepEqual(removed?.cids, [CID_B])

    const add = callsOfMethod(calls, 'POST').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(add, 'the customer the deploy removed was never restored')
    const added = (bodyOf(add)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(added?.cids, [CID_DEPARTED])

    assert.equal(
      JSON.stringify(calls.map((c) => c.body)).includes(CID_A),
      false,
      'a member the deploy never touched must not be written at all',
    )
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: restores the recorded prior description', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, respond: ok() },
    { url: ENTITY_WRITE, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    const body = (bodyOf(patches[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(body?.cid_group_id, 'cg-live-1')
    assert.equal(body?.description, 'legacy description nobody updated')
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: never deletes a group this deploy did not create', async () => {
  // Leaving an extra group behind is visible and removable by hand; deleting a
  // pre-existing CID group cuts an analyst team off from its customers.
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, respond: ok() },
    { url: ENTITY_WRITE, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const groupDeletes = calls.filter((c) => c.method === 'DELETE' && ENTITY_WRITE.test(c.url))
    assert.equal(groupDeletes.length, 0, `rollback deleted a pre-existing group: ${describeCalls(groupDeletes)}`)
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'Tier 1 managed customers', existed: false, memberDelta: { added: [], removed: [] } }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'Tier 1 managed customers',
            existed: true,
            prior: { description: 'legacy description nobody updated' },
            memberDelta: { added: [CID_B], removed: [CID_DEPARTED] },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: makes no membership call for an entry that recorded no delta', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY_WRITE, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(
      rollbackContext({
        previousState: [{ name: 'Tier 1 managed customers', existed: true, id: 'cg-live-1', memberDelta: { added: [], removed: [] } }],
      }),
    )

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => MEMBERS_WRITE.test(c.url)).length,
      0,
      'no recorded delta means no membership to reverse',
    )
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY_WRITE, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('mssp-cid-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'DELETE', respond: partialFailure('cid group is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('mssp-cid-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, respond: ok() },
    {
      url: ENTITY_WRITE,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'Trial customers', id: 'cg-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length >= 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
