// deploy for it-automation-policies.
//
// An IT automation policy decides whether scripts, Python and osquery may run on
// the hosts it covers, and the host groups it is assigned to decide WHICH hosts
// those are. The shared contract covers the pre-flight refusals; what is specific
// here is the create/update split, the SEPARATE policies-host-groups endpoint
// deploy converges afterwards, and the live prior values it must write down
// before overwriting anything.

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
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/it-automation\/queries\/policies\/v1/
const ENTITY = /\/it-automation\/entities\/policies\/v1/
const HOST_GROUPS = /\/it-automation\/entities\/policies-host-groups\/v1/

const EXECUTION_CONFIG = JSON.stringify({
  execution: { enable_script_execution: true, execution_timeout: 4, execution_timeout_unit: 'Hours' },
  concurrency: { concurrent_host_limit: 50 },
})

/**
 * One declared policy. `extractITPolicySpecs` reads a FLAT `fields` record —
 * `name`, `platform`, `enabled`, `description`, `executionConfig`, `hostGroups`.
 */
const POLICY = item('Windows automation', {
  name: 'win-it-automation',
  platform: 'Windows',
  enabled: true,
  description: 'Tier 1 automation policy',
  executionConfig: EXECUTION_CONFIG,
  hostGroups: 'hg-prod-1, hg-prod-2',
})

/**
 * The policy as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_POLICY = {
  id: 'pol-live-1',
  name: 'win-it-automation',
  platform: 'Windows',
  description: 'legacy description nobody updated',
  is_enabled: false,
  config: {
    execution: { enable_script_execution: false, execution_timeout: 1, execution_timeout_unit: 'Minutes' },
    concurrency: { concurrent_host_limit: 5 },
  },
  host_group_ids: ['hg-legacy-9'],
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

/** PATCHes against the policy entity, excluding the host-group assignment. */
const policyPatches = (calls: RecordedCall[]) =>
  callsOfMethod(calls, 'PATCH').filter((call) => ENTITY.test(call.url))

/** PATCHes against the separate policies-host-groups endpoint. */
const hostGroupPatches = (calls: RecordedCall[]) =>
  callsOfMethod(calls, 'PATCH').filter((call) => HOST_GROUPS.test(call.url))

registerDeployGuardContract({ label: 'it-automation-policies', handler: deploy, items: [POLICY] })

test('it-automation-policies deploy: creates a policy that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'win-it-automation')
    assert.equal(body?.platform, 'Windows', 'platform is immutable and only sent on create')
    assert.equal(body?.is_enabled, true)
    assert.equal(body?.description, 'Tier 1 automation policy')
    assert.deepEqual(body?.config, {
      execution: { enable_script_execution: true, execution_timeout: 4, execution_timeout_unit: 'Hours' },
      concurrency: { concurrent_host_limit: 50 },
    })

    assert.equal(policyPatches(calls).length, 0, 'a policy that did not exist must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: assigns the declared host groups to a policy it created', async () => {
  // Host-group assignment is a SEPARATE endpoint — a create that skipped it
  // would leave an enabled policy covering no hosts at all.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const assigns = hostGroupPatches(calls)
    assert.equal(assigns.length, 1, `expected one host-group assignment, got ${describeCalls(assigns)}`)
    const body = bodyOf(assigns[0])
    assert.equal(body?.policy_id, 'pol-new-1', 'the assignment must address the new policy by its id')
    assert.deepEqual(body?.host_group_ids, ['hg-prod-1', 'hg-prod-2'])
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: records the created policy so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'win-it-automation')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'pol-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: records the created policy BEFORE assigning host groups', async () => {
  // The policy exists the moment the POST returns. If the assignment that
  // follows fails, the record of what to delete must already be captured.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: forbidden('access denied, authorization failed') },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /failed to assign host groups/)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the policy was in fact created')

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1)
    assert.equal(state[0].id, 'pol-new-1', 'the created policy must be recoverable')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: updates a policy that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pol-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing policy must not be created again')

    const patches = policyPatches(calls)
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'pol-live-1', 'the update must address the live policy by its id')
    assert.equal(body?.is_enabled, true)
    assert.equal(body?.description, 'Tier 1 automation policy')
    assert.deepEqual(body?.config, {
      execution: { enable_script_execution: true, execution_timeout: 4, execution_timeout_unit: 'Hours' },
      concurrency: { concurrent_host_limit: 50 },
    })
    assert.equal(body?.platform, undefined, 'platform is immutable — an update must not resend it')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: records the LIVE prior values of a policy it overwrote', async () => {
  // The canvas asks for enabled/4 Hours/50 hosts; the tenant holds
  // disabled/1 Minute/5 hosts. Rollback restores what was there, not what was
  // wanted, so every one of these must come from LIVE_POLICY.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pol-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          name: string
          existed: boolean
          id?: string
          prior?: {
            description?: string
            enabled?: boolean
            config?: Record<string, unknown>
            hostGroups?: string[]
            hostGroupsChanged: boolean
          }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'pol-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false)
    assert.deepEqual(prior.config, LIVE_POLICY.config)
    assert.deepEqual(prior.hostGroups, ['hg-legacy-9'])
    assert.equal(prior.hostGroupsChanged, true, 'this deploy did reassign the host groups')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: leaves host groups alone when the declared set already matches', async () => {
  // Reassigning an unchanged set is a pointless write against a live policy —
  // and it would make rollback believe it has an assignment to reverse.
  const live = { ...LIVE_POLICY, host_group_ids: ['hg-prod-2', 'hg-prod-1'] }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pol-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(hostGroupPatches(calls).length, 0, 'an unchanged host-group set must not be rewritten')
    const state = (
      result.rollbackData as { previousState?: Array<{ prior?: { hostGroupsChanged: boolean } }> }
    )?.previousState
    assert.equal(state?.[0].prior?.hostGroupsChanged, false)
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: never reassigns host groups it could not read', async () => {
  // The live policy exposed neither host_group_ids nor host_groups. Writing the
  // declared list here would silently replace an assignment deploy never saw.
  const live = { id: 'pol-live-1', name: 'win-it-automation', is_enabled: false }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pol-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(
      hostGroupPatches(calls).length,
      0,
      `an unreadable assignment must not be overwritten: ${describeCalls(hostGroupPatches(calls))}`,
    )
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('policy quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: an invalid execution config fails before touching the tenant', async () => {
  const broken = item('Broken', {
    name: 'broken-policy',
    platform: 'Windows',
    enabled: true,
    executionConfig: '{ not json',
  })
  const { calls, restore } = routeFetch([])
  try {
    const result = await deploy(deployContext([broken]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid execution config/)
    assert.equal(calls.length, 0, 'a config the handler cannot parse must not reach Falcon')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: keeps the rollback record of what it wrote when a later policy fails', async () => {
  // The first policy is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Linux automation', {
    name: 'linux-it-automation',
    platform: 'Linux',
    enabled: true,
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'pol-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([POLICY, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /after 1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the policy that WAS created must still be recorded')
    assert.equal(state[0].name, 'win-it-automation')
    assert.equal(state[0].id, 'pol-new-1')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pol-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
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

test('it-automation-policies deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // policy now exists in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the policy was in fact created')
  } finally {
    restore()
  }
})

test('it-automation-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
