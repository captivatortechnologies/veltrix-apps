// rollback for usb-device-control-policies.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — disable-then-delete
// what this deploy created (on the V1 entity, because DELETE has no v2), patch
// the prior settings object back on the v2 entity and reverse exactly the
// host-group deltas it applied — and above all the entries that must produce NO
// write because there is nothing safe to restore.

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

const ACTIONS = /\/policy\/entities\/device-control-actions\/v1/
const ENTITY_V2 = /\/policy\/entities\/device-control\/v2/
const ENTITY_V1 = /\/policy\/entities\/device-control\/v1/

/** Falcon wraps every policy write in `{ resources: [ … ] }` — see deploy.test.ts. */
function resource(call: RecordedCall | undefined): Record<string, unknown> | null {
  const list = bodyOf(call)?.resources
  return Array.isArray(list) ? ((list[0] as Record<string, unknown>) ?? null) : null
}

function actionCalls(calls: RecordedCall[], name: string): RecordedCall[] {
  return calls.filter(
    (c) => c.url.includes('device-control-actions') && c.url.includes(`action_name=${name}`),
  )
}

const CREATED_ENTRY = {
  name: 'Corp Windows USB Control',
  platform: 'Windows',
  existed: false,
  id: 'pol-new-1',
}

const UPDATED_ENTRY = {
  name: 'Corp Windows USB Control',
  platform: 'Windows',
  existed: true,
  id: 'pol-live-1',
  prior: {
    name: 'Corp Windows USB Control',
    description: 'legacy description nobody updated',
    enabled: false,
    settings: {
      classes: [
        { id: 'MASS_STORAGE', action: 'FULL_ACCESS' },
        { id: 'IMAGING', action: 'FULL_ACCESS' },
        { id: 'PRINTER', action: 'FULL_ACCESS' },
      ],
      end_user_notification: 'SILENT',
    },
    groupsAdded: ['hg-workstations', 'hg-laptops'],
    groupsRemoved: ['hg-servers'],
  },
}

registerRollbackGuardContract({
  label: 'usb-device-control-policies',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('usb-device-control-policies rollback: disables then deletes a policy this deploy created, on the v1 entity', async () => {
  // Falcon refuses to delete an enabled policy, so the disable is not optional
  // housekeeping. DELETE has no v2 route, so the delete must target v1 even
  // though the create it is undoing went to v2.
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V1, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.deepEqual(bodyOf(actionCalls(calls, 'disable')[0])?.ids, ['pol-new-1'])

    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /\/policy\/entities\/device-control\/v1/)
    assert.match(deletes[0].url, /ids=pol-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created policy is deleted, not patched')
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: treats a 404 on delete as the policy already being gone', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V1, method: 'DELETE', respond: notFound() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: still deletes when the pre-delete disable is refused', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: forbidden('access denied, authorization failed') },
    { url: ENTITY_V1, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: restores the recorded prior settings object', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V2, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /\/policy\/entities\/device-control\/v2/)

    const body = resource(patches[0])
    assert.equal(body?.id, 'pol-live-1')
    assert.equal(body?.name, 'Corp Windows USB Control')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.deepEqual(body?.settings, UPDATED_ENTRY.prior.settings)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated policy must never be deleted')
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: restores the prior enablement through an actions call', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V2, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.deepEqual(bodyOf(actionCalls(calls, 'disable')[0])?.ids, ['pol-live-1'])
    assert.equal(actionCalls(calls, 'enable').length, 0)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: reverses exactly the host-group deltas the deploy applied', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V2, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.deepEqual(
      actionCalls(calls, 'remove-host-group').map((c) => bodyOf(c)?.action_parameters),
      [
        [{ name: 'group_id', value: 'hg-workstations' }],
        [{ name: 'group_id', value: 'hg-laptops' }],
      ],
      'groups the deploy attached are detached again',
    )
    assert.deepEqual(
      actionCalls(calls, 'add-host-group').map((c) => bodyOf(c)?.action_parameters),
      [[{ name: 'group_id', value: 'hg-servers' }]],
      'the group the deploy detached is re-attached',
    )
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: sends no settings when the deploy recorded none', async () => {
  // Deploy leaves `prior.settings` unset when it wrote no settings, and ALSO
  // when the live policy had none to read. Either way the restore must not
  // invent a settings object; what it cannot do in the second case is undo the
  // settings it did write, which is reported separately.
  const entry = {
    ...UPDATED_ENTRY,
    prior: { ...UPDATED_ENTRY.prior, settings: undefined },
  }
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V2, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = resource(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.settings, undefined)
    assert.equal(body?.description, 'legacy description nobody updated', 'the shell is still restored')
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live policy but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the policy alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'Corp Windows USB Control', platform: 'Windows', existed: true, id: 'pol-live-1' },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'Corp Windows USB Control',
            platform: 'Windows',
            existed: true,
            prior: UPDATED_ENTRY.prior,
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: writes nothing for a created entry whose id was never captured', async () => {
  // DEFECT (reported, not blessed): deploy records this entry when the create
  // succeeded but returned no id, and rollback silently skips it and still
  // reports success — so the orphaned policy is left in the tenant while the
  // operator is told the rollback completed. Only the half that is certainly
  // right is asserted: it invents no id and writes nothing.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'Corp Windows USB Control', platform: 'Windows', existed: false }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V1, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('usb-device-control-policies rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY_V2, method: 'PATCH', respond: partialFailure('policy is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored policy')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('usb-device-control-policies rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY_V2, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'Corp Mac USB Control', id: 'pol-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length > 1, 'both entries were attempted, in order')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
