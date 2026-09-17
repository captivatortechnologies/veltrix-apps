// rollback for firewall-policies.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that undoing a firewall deploy means undoing BOTH halves: the
// /policy shell (name, description, enablement, host groups) and the fwmgr
// container (rule groups, default in/out actions, enforce, test mode, logging) —
// and that the container restore has to re-read the tracking token, because the
// deploy's own PUT bumped the one it captured.

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

const ACTIONS = /\/policy\/entities\/firewall-actions\/v1/
const ENTITY = /\/policy\/entities\/firewall\/v1/
const FWMGR_GET = /\/fwmgr\/entities\/policies\/v1/
const FWMGR_PUT = /\/fwmgr\/entities\/policies\/v2/

/** Falcon wraps every /policy write in `{ resources: [ … ] }` — see deploy.test.ts. */
function resource(call: RecordedCall | undefined): Record<string, unknown> | null {
  const list = bodyOf(call)?.resources
  return Array.isArray(list) ? ((list[0] as Record<string, unknown>) ?? null) : null
}

function actionCalls(calls: RecordedCall[], name: string): RecordedCall[] {
  return calls.filter((c) => c.url.includes('firewall-actions') && c.url.includes(`action_name=${name}`))
}

const CREATED_ENTRY = {
  name: 'Corp Windows Firewall',
  platform: 'Windows',
  existed: false,
  id: 'pol-new-1',
}

const UPDATED_ENTRY = {
  name: 'Corp Windows Firewall',
  platform: 'Windows',
  existed: true,
  id: 'pol-live-1',
  prior: {
    name: 'Corp Windows Firewall',
    description: 'legacy description nobody updated',
    enabled: false,
    groupsAdded: ['hg-workstations', 'hg-laptops'],
    groupsRemoved: ['hg-servers'],
    container: {
      platform_id: '0',
      rule_group_ids: ['rg-legacy'],
      default_inbound: 'ALLOW',
      default_outbound: 'DENY',
      enforce: false,
      test_mode: true,
      local_logging: false,
    },
  },
}

/** The container as it stands AFTER the deploy — a fresh tracking token. */
const CONTAINER_AFTER_DEPLOY = entityPage([
  { policy_id: 'pol-live-1', platform_id: '0', tracking: 'track-after-deploy' },
])

registerRollbackGuardContract({ label: 'firewall-policies', handler: rollback, entry: CREATED_ENTRY })

test('firewall-policies rollback: disables then deletes a policy this deploy created', async () => {
  // Falcon refuses to delete an enabled policy, so the disable is not optional
  // housekeeping. Deleting the policy takes its fwmgr container with it, so
  // there is no separate container cleanup on this branch.
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.deepEqual(bodyOf(actionCalls(calls, 'disable')[0])?.ids, ['pol-new-1'])

    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=pol-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created policy is deleted, not patched')
    assert.equal(callsOfMethod(calls, 'PUT').length, 0, 'a deleted policy needs no container restore')
  } finally {
    restore()
  }
})

test('firewall-policies rollback: treats a 404 on delete as the policy already being gone', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'DELETE', respond: notFound() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: still deletes when the pre-delete disable is refused', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: forbidden('access denied, authorization failed') },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: restores the recorded prior shell values', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: CONTAINER_AFTER_DEPLOY },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one shell restore, got ${describeCalls(patches)}`)

    const body = resource(patches[0])
    assert.equal(body?.id, 'pol-live-1')
    assert.equal(body?.name, 'Corp Windows Firewall')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated policy must never be deleted')
  } finally {
    restore()
  }
})

test('firewall-policies rollback: restores the fwmgr container with a freshly read tracking token', async () => {
  // The deploy's own PUT bumped the token it captured, so replaying the old one
  // would be rejected as a stale write and the rule set would stay as deployed.
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: CONTAINER_AFTER_DEPLOY },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const puts = callsOfMethod(calls, 'PUT')
    assert.equal(puts.length, 1, `expected exactly one container restore, got ${describeCalls(puts)}`)
    const body = bodyOf(puts[0])
    assert.equal(body?.policy_id, 'pol-live-1')
    assert.equal(body?.platform_id, '0')
    assert.deepEqual(body?.rule_group_ids, ['rg-legacy'])
    assert.equal(body?.default_inbound, 'ALLOW')
    assert.equal(body?.default_outbound, 'DENY')
    assert.equal(body?.enforce, false)
    assert.equal(body?.test_mode, true)
    assert.equal(body?.local_logging, false)
    assert.equal(body?.tracking, 'track-after-deploy')
  } finally {
    restore()
  }
})

test('firewall-policies rollback: restores the prior enablement through an actions call', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: CONTAINER_AFTER_DEPLOY },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.deepEqual(bodyOf(actionCalls(calls, 'disable')[0])?.ids, ['pol-live-1'])
    assert.equal(actionCalls(calls, 'enable').length, 0)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: reverses exactly the host-group deltas the deploy applied', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: CONTAINER_AFTER_DEPLOY },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
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

test('firewall-policies rollback: touches the container only when the deploy recorded one', async () => {
  // Without a recorded container there is nothing to put back, and a PUT built
  // from defaults would wipe the tenant's live rule set.
  const entry = { ...UPDATED_ENTRY, prior: { ...UPDATED_ENTRY.prior, container: undefined } }
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(callsOfMethod(calls, 'PUT').length, 0, 'no container was recorded, so none is written')
    assert.equal(
      calls.filter((c) => c.url.includes('/fwmgr/entities/policies/v1')).length,
      0,
      'and none is read either',
    )
  } finally {
    restore()
  }
})

test('firewall-policies rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live policy but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the policy alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'Corp Windows Firewall', platform: 'Windows', existed: true, id: 'pol-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'Corp Windows Firewall', platform: 'Windows', existed: true, prior: UPDATED_ENTRY.prior },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: writes nothing for a created entry whose id was never captured', async () => {
  // DEFECT (reported, not blessed): rollback silently skips this entry and still
  // reports success, so an orphaned policy is left in the tenant while the
  // operator is told the rollback completed. For this config type deploy never
  // records such an entry at all (see deploy.test.ts) — which is the same defect
  // one step earlier. Only the half that is certainly right is asserted here:
  // it invents no id and writes nothing.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'Corp Windows Firewall', platform: 'Windows', existed: false }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
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

test('firewall-policies rollback: treats HTTP 200 with a populated errors[] on the container as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: CONTAINER_AFTER_DEPLOY },
    { url: FWMGR_PUT, respond: partialFailure('stale tracking token') },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored container')
    assert.match(String(result.message), /stale tracking token/)
  } finally {
    restore()
  }
})

test('firewall-policies rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: CONTAINER_AFTER_DEPLOY },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'Corp Mac Firewall', id: 'pol-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length > 1, 'both entries were attempted, in order')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
