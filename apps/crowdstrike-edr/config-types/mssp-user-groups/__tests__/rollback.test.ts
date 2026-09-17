// rollback for mssp-user-groups.
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

const ENTITY_WRITE = /\/mssp\/entities\/user-groups\/v1/
const MEMBERS_WRITE = /\/mssp\/entities\/user-group-members\/v1/

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const UUID_LEAVER = '99999999-8888-7777-6666-555555555555'

const CREATED_ENTRY = {
  name: 'SOC tier 2 analysts',
  existed: false,
  id: 'ug-new-1',
  memberDelta: { added: [UUID_A, UUID_B], removed: [] },
}

const UPDATED_ENTRY = {
  name: 'SOC tier 2 analysts',
  existed: true,
  id: 'ug-live-1',
  prior: { name: 'SOC tier 2 analysts', description: 'legacy description nobody updated' },
  memberDelta: { added: [UUID_B], removed: [UUID_LEAVER] },
}

registerRollbackGuardContract({ label: 'mssp-user-groups', handler: rollback, entry: CREATED_ENTRY })

test('mssp-user-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY_WRITE, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /user_group_ids=ug-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: treats a 404 on the delete as the group already being gone', async () => {
  const { restore } = routeFetch([{ url: ENTITY_WRITE, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '"gone" is a known answer, not a failure')
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: restores the LIVE prior membership, not the desired one', async () => {
  // The deploy added UUID_B and removed UUID_LEAVER. Rollback must put the
  // tenant back exactly there: remove UUID_B, re-add UUID_LEAVER, and leave
  // UUID_A — which the deploy never touched — alone.
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'DELETE', respond: ok() },
    { url: MEMBERS_WRITE, method: 'POST', respond: ok() },
    { url: ENTITY_WRITE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)

    const remove = callsOfMethod(calls, 'DELETE').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(remove, 'the analyst the deploy added was never removed')
    const removed = (bodyOf(remove)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(removed?.user_group_id, 'ug-live-1')
    assert.deepEqual(removed?.user_uuids, [UUID_B])

    const add = callsOfMethod(calls, 'POST').find((c) => MEMBERS_WRITE.test(c.url))
    assert.ok(add, 'the analyst the deploy removed was never restored')
    const added = (bodyOf(add)?.resources as Array<Record<string, unknown>>)?.[0]
    assert.deepEqual(added?.user_uuids, [UUID_LEAVER])

    assert.equal(
      JSON.stringify(calls.map((c) => c.body)).includes(UUID_A),
      false,
      'a member the deploy never touched must not be written at all',
    )
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: restores the recorded prior description', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, respond: ok() },
    { url: ENTITY_WRITE, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    const body = (bodyOf(patches[0])?.resources as Array<Record<string, unknown>>)?.[0]
    assert.equal(body?.user_group_id, 'ug-live-1')
    assert.equal(body?.description, 'legacy description nobody updated')
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: never deletes a group this deploy did not create', async () => {
  // Leaving an extra group behind is visible and removable by hand; deleting a
  // pre-existing user group cuts an analyst team off from its customers.
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

test('mssp-user-groups rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'SOC tier 2 analysts', existed: false, memberDelta: { added: [], removed: [] } }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'SOC tier 2 analysts',
            existed: true,
            prior: { description: 'legacy description nobody updated' },
            memberDelta: { added: [UUID_B], removed: [UUID_LEAVER] },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: makes no membership call for an entry that recorded no delta', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY_WRITE, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(
      rollbackContext({
        previousState: [{ name: 'SOC tier 2 analysts', existed: true, id: 'ug-live-1', memberDelta: { added: [], removed: [] } }],
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

test('mssp-user-groups rollback: reports a rejected delete rather than throwing', async () => {
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

test('mssp-user-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: MEMBERS_WRITE, method: 'DELETE', respond: partialFailure('user group is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('mssp-user-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBERS_WRITE, respond: ok() },
    {
      url: ENTITY_WRITE,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'SOC tier 1 analysts', id: 'ug-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length >= 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
