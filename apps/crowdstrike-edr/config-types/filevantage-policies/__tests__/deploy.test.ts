// deploy for filevantage-policies.
//
// Host-group and rule-group assignment are NOT fields on the policy body. They
// are separate side endpoints — `…/policies-host-groups`, `…/policies-rule-
// groups` — driven by an `action` query parameter, and rule-group ORDER is
// precedence, set through a third `action=precedence` call on the same path.
//
// That shape is what these tests are about. Nothing in the policy PATCH tells
// rollback which groups moved, so the deltas have to be recorded call by call as
// they succeed; a rollback that instead re-derived them from the canvas would
// detach a host group the customer had attached themselves.
//
// Read `lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache (why every context mints a fresh client secret) and
// the two-call lookup (`GET <queries>` answers with BARE ID STRINGS, then
// `GET <entity>?ids=…` answers with objects).

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
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/filevantage\/queries\/policies\/v1/
const HOST_GROUPS = /\/filevantage\/entities\/policies-host-groups\/v1/
const RULE_GROUPS = /\/filevantage\/entities\/policies-rule-groups\/v1/
const POLICIES = /\/filevantage\/entities\/policies\/v1/

/**
 * One declared policy. `extractPolicySpecs` reads a FLAT `fields` record off
 * each canvas item — `name`, `platform`, `description`, `enabled`, `hostGroups`
 * and `ruleGroups` (both comma-separated; ruleGroups is ORDERED).
 */
const POLICY = item('Windows FIM policy', {
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  description: 'Monitored system paths',
  enabled: true,
  hostGroups: 'hg-prod, hg-dmz',
  ruleGroups: 'rg-system, rg-registry',
})

/**
 * The policy as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, including a REVERSED rule
 * group order, so a rollback record that captured the DESIRED values instead of
 * the LIVE ones fails these assertions.
 */
const LIVE_POLICY = {
  id: 'fvp-live-1',
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  description: 'legacy description nobody updated',
  enabled: false,
  host_groups: ['hg-legacy'],
  rule_groups: ['rg-registry', 'rg-system'],
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

/** Actions applied to one side endpoint, in the order the handler issued them. */
function actions(calls: Array<{ url: string }>, path: RegExp): string[] {
  return calls
    .filter((c) => path.test(c.url))
    .map((c) => {
      const url = new URL(c.url)
      return `${url.searchParams.get('action')}:${url.searchParams.getAll('ids').join('>')}`
    })
}

registerDeployGuardContract({ label: 'filevantage-policies', handler: deploy, items: [POLICY] })

test('filevantage-policies deploy: creates a policy that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'POST', respond: created({ id: 'fvp-new-1' }) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.equal(result.success, true)

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'veltrix-fim-windows')
    assert.equal(body?.platform, 'Windows')
    assert.equal(body?.description, 'Monitored system paths')
    assert.equal(
      'enabled' in (body ?? {}),
      false,
      'FileVantage creates a policy disabled — enablement is a follow-up PATCH',
    )
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: attaches groups and sets precedence before enabling a new policy', async () => {
  // A policy enabled before its rule groups are attached monitors nothing for
  // the window in between, so the order of these calls is the point.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'POST', respond: created({ id: 'fvp-new-1' }) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([POLICY]))

    assert.deepEqual(actions(calls, HOST_GROUPS), ['assign:hg-prod', 'assign:hg-dmz'])
    assert.deepEqual(actions(calls, RULE_GROUPS), [
      'assign:rg-system',
      'assign:rg-registry',
      'precedence:rg-system>rg-registry',
    ])

    const enable = callsOfMethod(calls, 'PATCH').find((c) => POLICIES.test(c.url))
    assert.ok(enable, 'a new policy must be enabled by a follow-up PATCH')
    assert.equal(bodyOf(enable)?.id, 'fvp-new-1')
    assert.equal(bodyOf(enable)?.enabled, true)

    const enableIndex = calls.indexOf(enable)
    const lastRuleGroup = calls.map((c) => RULE_GROUPS.test(c.url)).lastIndexOf(true)
    assert.ok(lastRuleGroup < enableIndex, 'rule groups must be attached before the policy is enabled')
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: records the created policy so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'POST', respond: created({ id: 'fvp-new-1' }) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'veltrix-fim-windows')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'fvp-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: converges an existing policy, its groups and their precedence', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing policy must not be created again')

    assert.deepEqual(actions(calls, HOST_GROUPS), [
      'assign:hg-prod',
      'assign:hg-dmz',
      'unassign:hg-legacy',
    ])
    assert.deepEqual(
      actions(calls, RULE_GROUPS),
      ['precedence:rg-system>rg-registry'],
      'both rule groups are already attached — only their precedence differs',
    )

    const body = bodyOf(callsOfMethod(calls, 'PATCH').find((c) => POLICIES.test(c.url)))
    assert.equal(body?.id, 'fvp-live-1', 'the update must address the live policy by its id')
    assert.equal(body?.name, 'veltrix-fim-windows')
    assert.equal(body?.description, 'Monitored system paths')
    assert.equal(body?.enabled, true)
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: records the exact assignment deltas it applied', async () => {
  // Rollback reverses these one by one. Anything derived from the canvas instead
  // would detach a group the customer attached by hand.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'GET', respond: entityPage([{ ...LIVE_POLICY, rule_groups: ['rg-old'] }]) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
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
    assert.equal(state[0].id, 'fvp-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.deepEqual(prior.hostGroupsAdded, ['hg-prod', 'hg-dmz'])
    assert.deepEqual(prior.hostGroupsRemoved, ['hg-legacy'])
    assert.deepEqual(prior.ruleGroupsAdded, ['rg-system', 'rg-registry'])
    assert.deepEqual(prior.ruleGroupsRemoved, ['rg-old'])
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: records the LIVE prior name, description, enablement and rule order', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const prior = (
      result.rollbackData as { previousState?: Array<{ prior?: Record<string, unknown> }> }
    )?.previousState?.[0].prior
    assert.ok(prior)
    assert.equal(prior.name, 'veltrix-fim-windows')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false, 'the policy was disabled before this deploy enabled it')
    assert.deepEqual(
      prior.ruleGroupsPriorOrder,
      ['rg-registry', 'rg-system'],
      'precedence is order, so the LIVE order is what rollback has to restore',
    )
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: reads host and rule groups given as objects, not just ids', async () => {
  // The FileVantage policy entity returns these either way; reading only strings
  // would make every already-attached group look absent and re-assign it.
  const asObjects = {
    ...LIVE_POLICY,
    host_groups: [{ id: 'hg-prod' }, { id: 'hg-dmz' }],
    rule_groups: [{ id: 'rg-system' }, { id: 'rg-registry' }],
  }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'GET', respond: entityPage([asObjects]) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([POLICY]))

    assert.deepEqual(actions(calls, HOST_GROUPS), [], 'nothing needed to move')
    assert.deepEqual(actions(calls, RULE_GROUPS), [], 'the order already matches, so no precedence call')
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: POLICIES, method: 'POST', respond: forbidden('access denied, authorization failed') },
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

test('filevantage-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy it never created as monitoring files.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: POLICIES, method: 'POST', respond: partialFailure('policy quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: treats a rejected group assignment as a failure, naming the group', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: partialFailure('host group not found') },
    { url: POLICIES, method: 'GET', respond: entityPage([LIVE_POLICY]) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /failed to assign host group hg-prod/)
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: keeps the assignment deltas it already applied when a later call fails', async () => {
  // The first host group attached, the second was rejected. Rollback still has
  // to detach the first — a `catch` that returns only a message would leave it.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: [ok(), forbidden('access denied, authorization failed')] },
    { url: POLICIES, method: 'GET', respond: entityPage([LIVE_POLICY]) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    const prior = (
      result.rollbackData as { previousState?: Array<{ prior?: Record<string, unknown> }> }
    )?.previousState?.[0].prior
    assert.ok(prior, 'the failure path discarded the rollback state deploy had captured')
    assert.deepEqual(prior.hostGroupsAdded, ['hg-prod'], 'the group that WAS attached must be recorded')
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createFileVantage` throws here AFTER the
  // POST succeeded, and `rollbackState.push` is the statement below its call —
  // so the policy now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: POLICIES, method: 'POST', respond: CREATED_WITHOUT_ID },
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

test('filevantage-policies deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvp-live-1']) },
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('filevantage-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
