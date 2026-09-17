// deploy for sensor-update-policies.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the policy family's three-endpoint lifecycle driven
// through lib/policyAdapter: the policy body is created/patched on
// `/policy/entities/sensor-update/v2`, but enablement and host-group assignment
// are NOT fields on it — each is a separate `sensor-update-actions` call.
//
// The live fixture is deliberately different from the canvas in every managed
// field (build, uninstall protection, description, enablement, host groups), so
// a rollback record that captured the DESIRED values rather than the LIVE ones
// fails these assertions instead of passing them.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CREATED_WITHOUT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  created,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const COMBINED = /\/policy\/combined\/sensor-update\/v1/
const ACTIONS = /\/policy\/entities\/sensor-update-actions\/v2/
const ENTITY = /\/policy\/entities\/sensor-update\/v2/

/**
 * Falcon wraps every policy write in `{ resources: [ … ] }`. Defined locally
 * because the shared fake has no envelope helper and must not be edited.
 */
function resource(call: RecordedCall | undefined): Record<string, unknown> | null {
  const list = bodyOf(call)?.resources
  return Array.isArray(list) ? ((list[0] as Record<string, unknown>) ?? null) : null
}

function actionCalls(calls: RecordedCall[], name: string): RecordedCall[] {
  return calls.filter(
    (c) => c.url.includes('sensor-update-actions') && c.url.includes(`action_name=${name}`),
  )
}

/**
 * One declared sensor update policy. `extractPolicySpecs` reads a FLAT `fields`
 * record — `name`, `platform`, `description`, `enabled`, `hostGroups`, `build`
 * and `uninstall_protection` (note the snake_case on that last one).
 */
const POLICY = item('Windows sensor updates', {
  name: 'Corp Windows Sensor Updates',
  platform: 'Windows',
  description: 'n-1 pinned build for workstations',
  enabled: true,
  hostGroups: 'hg-workstations, hg-laptops',
  build: '7.14.18110|n-1|Tagged|14',
  uninstall_protection: 'ENABLED',
})

/**
 * The policy as it exists in the tenant BEFORE this deploy. `scheduler` is a
 * settings key this configuration does not manage — it must not appear in the
 * recorded prior, which captures only build + uninstall_protection.
 */
const LIVE_POLICY = {
  id: 'pol-live-1',
  name: 'Corp Windows Sensor Updates',
  platform_name: 'Windows',
  description: 'legacy description nobody updated',
  enabled: false,
  groups: [{ id: 'hg-servers', name: 'Servers' }],
  settings: {
    build: '7.10.16101|n-3|Tagged|14',
    uninstall_protection: 'DISABLED',
    scheduler: { enabled: true, timezone: 'UTC' },
  },
}

registerDeployGuardContract({ label: 'sensor-update-policies', handler: deploy, items: [POLICY] })

test('sensor-update-policies deploy: creates a policy that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assertAuthenticatedFirst(assert, calls)
    assert.equal(result.success, true)

    const creates = callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('sensor-update-actions'))
    assert.equal(creates.length, 1, `expected exactly one create, got ${describeCalls(creates)}`)
    const body = resource(creates[0])
    assert.equal(body?.name, 'Corp Windows Sensor Updates')
    assert.equal(body?.platform_name, 'Windows')
    assert.equal(body?.description, 'n-1 pinned build for workstations')
    assert.deepEqual(body?.settings, {
      uninstall_protection: 'ENABLED',
      build: '7.14.18110|n-1|Tagged|14',
    })
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a policy that did not exist must not be patched')
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: creates the policy DISABLED and enables it through an actions call', async () => {
  // The API ignores `enabled` on create — every new policy starts off. Without
  // the separate actions call the declared build would never be enforced.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const creates = callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('sensor-update-actions'))
    assert.equal(resource(creates[0])?.enabled, undefined, 'enablement is not a create-body field')

    const enables = actionCalls(calls, 'enable')
    assert.equal(enables.length, 1, `expected exactly one enable action, got ${describeCalls(enables)}`)
    assert.deepEqual(bodyOf(enables[0])?.ids, ['pol-new-1'])
    assert.equal(actionCalls(calls, 'disable').length, 0)
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: attaches the declared host groups through actions calls', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const attaches = actionCalls(calls, 'add-host-group')
    assert.equal(attaches.length, 2, `expected two attaches, got ${describeCalls(attaches)}`)
    assert.deepEqual(bodyOf(attaches[0])?.action_parameters, [
      { name: 'group_id', value: 'hg-workstations' },
    ])
    assert.deepEqual(bodyOf(attaches[1])?.action_parameters, [{ name: 'group_id', value: 'hg-laptops' }])
    assert.equal(actionCalls(calls, 'remove-host-group').length, 0, 'a new policy has nothing to detach')
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: records the created policy so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'Corp Windows Sensor Updates')
    assert.equal(state[0].platform, 'Windows')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'pol-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: updates a policy that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_POLICY]) },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('sensor-update-actions')).length,
      0,
      'an existing policy must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = resource(patches[0])
    assert.equal(body?.id, 'pol-live-1', 'the update must address the live policy by its id')
    assert.equal(body?.description, 'n-1 pinned build for workstations')
    assert.deepEqual(body?.settings, {
      uninstall_protection: 'ENABLED',
      build: '7.14.18110|n-1|Tagged|14',
    })
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: records the LIVE prior build and uninstall protection it overwrote', async () => {
  // The canvas asks for the n-1 build with uninstall protection ON; the tenant
  // holds an n-3 build with it OFF. Rollback restores what was there.
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_POLICY]) },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'pol-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false)
    assert.deepEqual(
      prior.settings,
      { build: '7.10.16101|n-3|Tagged|14', uninstall_protection: 'DISABLED' },
      'only the two managed settings keys are recorded, at their live values',
    )
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: converges host groups and records the deltas it applied', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_POLICY]) },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.deepEqual(
      actionCalls(calls, 'add-host-group').map((c) => bodyOf(c)?.action_parameters),
      [
        [{ name: 'group_id', value: 'hg-workstations' }],
        [{ name: 'group_id', value: 'hg-laptops' }],
      ],
    )
    assert.deepEqual(
      actionCalls(calls, 'remove-host-group').map((c) => bodyOf(c)?.action_parameters),
      [[{ name: 'group_id', value: 'hg-servers' }]],
    )

    const prior = (
      result.rollbackData as {
        previousState?: Array<{ prior?: { groupsAdded: string[]; groupsRemoved: string[] } }>
      }
    )?.previousState?.[0].prior
    assert.deepEqual(prior?.groupsAdded, ['hg-workstations', 'hg-laptops'])
    assert.deepEqual(prior?.groupsRemoved, ['hg-servers'])
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: converges enablement on an existing policy it found disabled', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_POLICY]) },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const enables = actionCalls(calls, 'enable')
    assert.equal(enables.length, 1, `expected exactly one enable, got ${describeCalls(enables)}`)
    assert.deepEqual(bodyOf(enables[0])?.ids, ['pol-live-1'])
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy it never created as deployed.
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('sensor build not available for this tenant') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /build not available/)
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: treats a 200-with-errors on the enable action as a failure', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: partialFailure('policy is not eligible to be enabled') },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not eligible to be enabled/)
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: keeps the rollback record of what it wrote when a later policy fails', async () => {
  const SECOND = item('Linux sensor updates', {
    name: 'Corp Linux Sensor Updates',
    platform: 'Linux',
    enabled: false,
    uninstall_protection: 'DISABLED',
  })
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'pol-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([POLICY, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the policy that WAS created must still be recorded')
    assert.equal(state[0].id, 'pol-new-1')
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: a create that returns no id is not reported as a success', async () => {
  // The POST succeeded, so the policy exists in the tenant. This handler records
  // the entry BEFORE raising the missing-id error, so rollback still learns the
  // policy was created — that recording is asserted below.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no policy id/i)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('sensor-update-actions')).length,
      1,
      'the policy was in fact created',
    )
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'a created policy with no id still has to be recorded')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_POLICY]) },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('sensor-update-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
