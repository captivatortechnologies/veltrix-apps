// deploy for content-update-policies.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the policy family's three-endpoint lifecycle driven
// through lib/policyAdapter — plus the one way this family differs from the rest
// of it: content update policies are NOT per-platform, so the lookup filter
// carries no `platform_name` and the create body sends none. Enablement and
// host-group assignment are NOT fields on the policy body — each is a separate
// `content-update-actions` call.
//
// The live fixture is deliberately different from the canvas in every managed
// field, so a rollback record that captured the DESIRED ring assignments rather
// than the LIVE ones fails these assertions instead of passing them.

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
  vendorCalls,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const COMBINED = /\/policy\/combined\/content-update\/v1/
const ACTIONS = /\/policy\/entities\/content-update-actions\/v1/
const ENTITY = /\/policy\/entities\/content-update\/v1/

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
    (c) => c.url.includes('content-update-actions') && c.url.includes(`action_name=${name}`),
  )
}

/**
 * One declared content update policy. `extractContentUpdatePolicySpecs` reads a
 * FLAT `fields` record — `name`, `description`, `enabled`, `hostGroups` and
 * `settings` (a JSON OBJECT with a `ring_assignment_settings` array). There is
 * no `platform` field in this family.
 */
const POLICY = item('Rapid response rings', {
  name: 'Corp Content Rings',
  description: 'EA for sensor ops, GA elsewhere',
  enabled: true,
  hostGroups: 'hg-canary, hg-workstations',
  settings: JSON.stringify({
    ring_assignment_settings: [
      { id: 'sensor_operations', ring_assignment: 'ea' },
      { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
    ],
  }),
})

/**
 * The policy as it exists in the tenant BEFORE this deploy — sensor operations
 * paused, system_critical delayed 48h, plus a category the canvas never listed.
 */
const LIVE_POLICY = {
  id: 'pol-live-1',
  name: 'Corp Content Rings',
  description: 'legacy description nobody updated',
  enabled: false,
  groups: [{ id: 'hg-servers', name: 'Servers' }],
  settings: {
    ring_assignment_settings: [
      { id: 'sensor_operations', ring_assignment: 'pause' },
      { id: 'system_critical', ring_assignment: 'ga', delay_hours: '48' },
      { id: 'vulnerability_management', ring_assignment: 'ga', delay_hours: '0' },
    ],
  },
}

registerDeployGuardContract({ label: 'content-update-policies', handler: deploy, items: [POLICY] })

test('content-update-policies deploy: creates a policy that does not exist yet, with no platform', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assertAuthenticatedFirst(assert, calls)
    assert.equal(result.success, true)

    const creates = callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('content-update-actions'))
    assert.equal(creates.length, 1, `expected exactly one create, got ${describeCalls(creates)}`)
    const body = resource(creates[0])
    assert.equal(body?.name, 'Corp Content Rings')
    assert.equal(body?.platform_name, undefined, 'content update policies have no platform')
    assert.equal(body?.description, 'EA for sensor ops, GA elsewhere')
    assert.deepEqual(body?.settings, {
      ring_assignment_settings: [
        { id: 'sensor_operations', ring_assignment: 'ea' },
        { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
      ],
    })
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a policy that did not exist must not be patched')
  } finally {
    restore()
  }
})

test('content-update-policies deploy: looks a policy up by name alone', async () => {
  // A `platform_name:'…'` clause in the filter would match nothing in this
  // family and every declared policy would read as missing and be re-created.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const find = vendorCalls(calls).find((c) => c.url.includes('/policy/combined/content-update/v1'))
    assert.ok(find, 'no combined lookup was made')
    assert.equal(find.url.includes('platform_name'), false)
    assert.match(decodeURIComponent(find.url), /name:~'/)
  } finally {
    restore()
  }
})

test('content-update-policies deploy: creates the policy DISABLED and enables it through an actions call', async () => {
  // The API ignores `enabled` on create — every new policy starts off. Without
  // the separate actions call the declared ring schedule never takes effect.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const creates = callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('content-update-actions'))
    assert.equal(resource(creates[0])?.enabled, undefined, 'enablement is not a create-body field')

    const enables = actionCalls(calls, 'enable')
    assert.equal(enables.length, 1, `expected exactly one enable action, got ${describeCalls(enables)}`)
    assert.deepEqual(bodyOf(enables[0])?.ids, ['pol-new-1'])
    assert.equal(actionCalls(calls, 'disable').length, 0)
  } finally {
    restore()
  }
})

test('content-update-policies deploy: attaches the declared host groups through actions calls', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const attaches = actionCalls(calls, 'add-host-group')
    assert.equal(attaches.length, 2, `expected two attaches, got ${describeCalls(attaches)}`)
    assert.deepEqual(bodyOf(attaches[0])?.action_parameters, [{ name: 'group_id', value: 'hg-canary' }])
    assert.deepEqual(bodyOf(attaches[1])?.action_parameters, [
      { name: 'group_id', value: 'hg-workstations' },
    ])
    assert.equal(actionCalls(calls, 'remove-host-group').length, 0, 'a new policy has nothing to detach')
  } finally {
    restore()
  }
})

test('content-update-policies deploy: records the created policy so rollback can delete it', async () => {
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
    assert.equal(state[0].name, 'Corp Content Rings')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'pol-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('content-update-policies deploy: updates a policy that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_POLICY]) },
    { url: ACTIONS, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('content-update-actions')).length,
      0,
      'an existing policy must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = resource(patches[0])
    assert.equal(body?.id, 'pol-live-1', 'the update must address the live policy by its id')
    assert.equal(body?.description, 'EA for sensor ops, GA elsewhere')
    assert.deepEqual(body?.settings, {
      ring_assignment_settings: [
        { id: 'sensor_operations', ring_assignment: 'ea' },
        { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
      ],
    })
  } finally {
    restore()
  }
})

test('content-update-policies deploy: records the LIVE prior ring assignments it overwrote', async () => {
  // The canvas asks for EA on sensor operations and no delay on system
  // critical; the tenant holds paused and 48h. Rollback restores what was there.
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
    assert.deepEqual(prior.settings, LIVE_POLICY.settings, 'the whole live settings object is recorded')
  } finally {
    restore()
  }
})

test('content-update-policies deploy: converges host groups and records the deltas it applied', async () => {
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
        [{ name: 'group_id', value: 'hg-canary' }],
        [{ name: 'group_id', value: 'hg-workstations' }],
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
    assert.deepEqual(prior?.groupsAdded, ['hg-canary', 'hg-workstations'])
    assert.deepEqual(prior?.groupsRemoved, ['hg-servers'])
  } finally {
    restore()
  }
})

test('content-update-policies deploy: converges enablement on an existing policy it found disabled', async () => {
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

test('content-update-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
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

test('content-update-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy it never created as deployed.
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('unknown content category') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /unknown content category/)
  } finally {
    restore()
  }
})

test('content-update-policies deploy: treats a 200-with-errors on the enable action as a failure', async () => {
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

test('content-update-policies deploy: refuses to pause system_critical, before any write', async () => {
  // Pausing system-critical content is not a permitted ring assignment, and
  // sending it would be a silent request to stop the updates that matter most.
  const BAD = item('Rapid response rings', {
    name: 'Corp Content Rings',
    enabled: true,
    settings: JSON.stringify({
      ring_assignment_settings: [{ id: 'system_critical', ring_assignment: 'pause' }],
    }),
  })
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([BAD]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not permitted for system_critical/)
    assert.equal(
      callsOfMethod(calls, 'POST').length + callsOfMethod(calls, 'PATCH').length,
      0,
      'nothing may be written for a policy whose settings did not parse',
    )
  } finally {
    restore()
  }
})

test('content-update-policies deploy: keeps the rollback record of what it wrote when a later policy fails', async () => {
  const SECOND = item('Server rings', { name: 'Corp Server Content Rings', enabled: false })
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

test('content-update-policies deploy: a create that returns no id is not reported as a success', async () => {
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
      callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('content-update-actions')).length,
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

test('content-update-policies deploy: never puts the token or the client secret in its result', async () => {
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

test('content-update-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
