// deploy for custom-ioa-rule-groups.
//
// Two things make this config type different from a flat resource. The rules
// live INSIDE the group, so "update" means reconciling a collection rather than
// overwriting fields; and the group is VERSIONED — every write bumps
// `version`, and a PATCH echoing a stale `rulegroup_version` is rejected by
// Falcon, so the handler has to re-read the group between writes and carry the
// version it just saw. Both are asserted here.
//
// The other load-bearing assertion is the one about rules this app did not
// declare: reconciliation must never remove them. A group in a customer's tenant
// routinely carries rules an analyst added by hand, and silently deleting them
// turns a deploy into an outage of somebody else's detection.
//
// Read `lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache (why every context mints a fresh client secret) and
// the 401 that `FalconClient` silently retries.

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
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const COMBINED = /\/ioarules\/combined\/rule-groups\/v1/
const GROUPS = /\/ioarules\/entities\/rule-groups\/v1/
const RULES = /\/ioarules\/entities\/rules\/v1/

const FIELD_VALUES = [
  { name: 'CommandLine', type: 'excludable', values: [{ label: 'include', value: 'encodedcommand' }] },
]

/**
 * One declared rule, as `parseRuleSpecs` reads it out of the `rules` field's
 * JSON string — camelCase there, snake_case on the wire.
 */
const DECLARED_RULE = {
  name: 'Encoded PowerShell',
  ruletypeId: '5',
  dispositionId: 30,
  patternSeverity: 'critical',
  fieldValues: FIELD_VALUES,
  enabled: true,
  description: 'Block encoded PowerShell',
}

/**
 * One declared rule group. `extractRuleGroupSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `platform`, `description`, `enabled`,
 * `comment`, and `rules` as a JSON STRING.
 */
const GROUP = item('Encoded PowerShell detection', {
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  description: 'Managed IOA rules',
  enabled: true,
  comment: 'Managed by Veltrix',
  rules: JSON.stringify([DECLARED_RULE]),
})

/** A live rule matching the declared one, overridable field by field. */
const liveRule = (over: Record<string, unknown> = {}) => ({
  instance_id: 'ri-1',
  name: 'Encoded PowerShell',
  description: 'Block encoded PowerShell',
  ruletype_id: '5',
  disposition_id: 30,
  pattern_severity: 'critical',
  field_values: FIELD_VALUES,
  enabled: true,
  ...over,
})

/**
 * The group as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_GROUP = {
  id: 'rg-live-1',
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  description: 'legacy description nobody updated',
  enabled: false,
  comment: 'created by hand in 2024',
  version: 3,
  rules: [liveRule()],
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'custom-ioa-rule-groups', handler: deploy, items: [GROUP] })

test('custom-ioa-rule-groups deploy: creates a group and its rules when none exists', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: created({ id: 'rg-new-1', version: 1 }) },
    { url: RULES, method: 'POST', respond: created(liveRule()) },
    {
      url: GROUPS,
      method: 'GET',
      respond: entityPage([{ id: 'rg-new-1', version: 7, enabled: false, rules: [liveRule()] }]),
    },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.equal(result.success, true)

    const groupPosts = callsOfMethod(calls, 'POST').filter((c) => GROUPS.test(c.url))
    assert.equal(groupPosts.length, 1, `expected one group create, got ${describeCalls(groupPosts)}`)
    const groupBody = bodyOf(groupPosts[0])
    assert.equal(groupBody?.name, 'veltrix-ioa-windows')
    assert.equal(groupBody?.platform, 'windows')
    assert.equal(groupBody?.comment, 'Managed by Veltrix')

    const rulePosts = callsOfMethod(calls, 'POST').filter((c) => RULES.test(c.url))
    assert.equal(rulePosts.length, 1, `expected one rule create, got ${describeCalls(rulePosts)}`)
    const ruleBody = bodyOf(rulePosts[0])
    assert.equal(ruleBody?.rulegroup_id, 'rg-new-1', 'a rule is created under its parent group')
    assert.equal(ruleBody?.name, 'Encoded PowerShell')
    assert.equal(ruleBody?.disposition_id, 30)
    assert.equal(ruleBody?.pattern_severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: enables a new group with the version it just re-read', async () => {
  // A group is always created DISABLED, so enablement is a second PATCH — and
  // that PATCH must echo the version the create left behind, not the one the
  // create response carried, or Falcon rejects it as stale.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: created({ id: 'rg-new-1', version: 1 }) },
    { url: RULES, method: 'POST', respond: created(liveRule()) },
    {
      url: GROUPS,
      method: 'GET',
      respond: entityPage([{ id: 'rg-new-1', version: 7, enabled: false, rules: [liveRule()] }]),
    },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([GROUP]))

    const patches = callsOfMethod(calls, 'PATCH').filter((c) => GROUPS.test(c.url))
    assert.equal(patches.length, 1, `expected one group update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'rg-new-1')
    assert.equal(body?.enabled, true)
    assert.equal(body?.rulegroup_version, 7, 'the PATCH must carry the LIVE version, not the create one')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: created({ id: 'rg-new-1', version: 1 }) },
    { url: RULES, method: 'POST', respond: created(liveRule()) },
    {
      url: GROUPS,
      method: 'GET',
      respond: entityPage([{ id: 'rg-new-1', version: 7, enabled: false, rules: [liveRule()] }]),
    },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'veltrix-ioa-windows')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'rg-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: converges an existing group, carrying its live version', async () => {
  // The re-read between the rule writes and the group write is the whole point:
  // deleting/creating rules bumps the group version, and the group PATCH has to
  // echo the value from AFTER those writes.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    {
      url: GROUPS,
      method: 'GET',
      respond: [
        entityPage([{ ...LIVE_GROUP, version: 9, rules: [liveRule({ disposition_id: 10 })] }]),
        entityPage([{ ...LIVE_GROUP, version: 11, rules: [liveRule()] }]),
      ],
    },
    { url: RULES, method: 'PATCH', respond: ok() },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing group and an existing rule must not be created again',
    )

    const rulePatch = callsOfMethod(calls, 'PATCH').find((c) => RULES.test(c.url))
    assert.ok(rulePatch, `expected a rule update, got ${describeCalls(vendorCalls(calls))}`)
    const ruleBody = bodyOf(rulePatch)
    assert.equal(ruleBody?.rulegroup_id, 'rg-live-1')
    assert.equal(ruleBody?.rulegroup_version, 9, 'the rule PATCH carries the version it just read')
    const updates = ruleBody?.rule_updates as Array<Record<string, unknown>>
    assert.equal(updates?.length, 1)
    assert.equal(updates[0].instance_id, 'ri-1', 'the update must address the live rule by its instance id')
    assert.equal(updates[0].disposition_id, 30, 'the declared disposition replaces the weakened live one')

    const groupPatch = callsOfMethod(calls, 'PATCH').find((c) => GROUPS.test(c.url))
    assert.ok(groupPatch)
    const groupBody = bodyOf(groupPatch)
    assert.equal(groupBody?.id, 'rg-live-1')
    assert.equal(groupBody?.enabled, true)
    assert.equal(
      groupBody?.rulegroup_version,
      11,
      'the group PATCH must carry the version left by the rule write, not the stale one',
    )
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: leaves a live rule this canvas never declared alone', async () => {
  // An analyst's own rule on the same group is not this app's to remove. A
  // reconciliation that treats the canvas as the complete rule set would delete
  // somebody else's detection without saying so.
  const withExtra = {
    ...LIVE_GROUP,
    version: 9,
    rules: [liveRule(), liveRule({ instance_id: 'ri-analyst', name: 'Analyst rule' })],
  }
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([withExtra]) },
    { url: GROUPS, method: 'GET', respond: entityPage([withExtra]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      `deploy deleted something: ${describeCalls(callsOfMethod(calls, 'DELETE'))}`,
    )
    const rulePatch = callsOfMethod(calls, 'PATCH').find((c) => RULES.test(c.url))
    assert.equal(rulePatch, undefined, 'no declared rule differed, so no rule write was needed')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: creates a declared rule missing from an existing group and records it', async () => {
  // Rollback deletes exactly the rules THIS deploy added under a pre-existing
  // group — it cannot delete the group itself, which it did not create.
  const empty = { ...LIVE_GROUP, version: 9, rules: [] }
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([empty]) },
    { url: RULES, method: 'POST', respond: created(liveRule({ instance_id: 'ri-new' })) },
    {
      url: GROUPS,
      method: 'GET',
      respond: entityPage([{ ...empty, version: 10, rules: [liveRule({ instance_id: 'ri-new' })] }]),
    },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').filter((c) => RULES.test(c.url)).length, 1)

    const state = (
      result.rollbackData as { previousState?: Array<{ createdRuleInstanceIds?: string[] }> }
    )?.previousState
    assert.ok(state)
    assert.deepEqual(
      state[0].createdRuleInstanceIds,
      ['ri-new'],
      'a rule this deploy added to somebody else’s group must be recorded for removal',
    )
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: records the LIVE prior name, description, enablement and comment', async () => {
  // The canvas asks for enabled/Managed IOA rules; the tenant holds disabled/a
  // legacy description. Rollback restores what was there, not what was wanted.
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: GROUPS, method: 'GET', respond: entityPage([{ ...LIVE_GROUP, version: 9 }]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'rg-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.name, 'veltrix-ioa-windows')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false, 'the group was disabled before this deploy enabled it')
    assert.equal(prior.comment, 'created by hand in 2024')
    assert.equal(prior.version, 3)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: refuses invalid rules JSON before touching the tenant', async () => {
  const BROKEN = item('Encoded PowerShell detection', {
    name: 'veltrix-ioa-windows',
    platform: 'windows',
    enabled: true,
    rules: '[{"name":"no rule type","patternSeverity":"critical","dispositionId":30}]',
  })
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([BROKEN]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid rules/)
    assert.equal(calls.length, 0, 'a canvas that cannot be parsed must not reach Falcon at all')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as detecting attacks.
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: partialFailure('rule group quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: treats a stale-version rejection on the group PATCH as a failure', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: GROUPS, method: 'GET', respond: entityPage([{ ...LIVE_GROUP, version: 9 }]) },
    { url: GROUPS, method: 'PATCH', respond: partialFailure('rule group version is out of date') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /out of date/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: a create that returns no id is recorded before it is reported as failed', async () => {
  // The POST succeeded, so the group exists in the tenant. This handler pushes
  // the rollback entry BEFORE throwing on the missing id, which is the correct
  // order — what it CANNOT do is give rollback an id to delete by, so the entry
  // is recorded but not actionable. That gap is reported, not blessed.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no group id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the group was in fact created')

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'a group that now exists in the tenant was not recorded at all')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: GROUPS, method: 'GET', respond: entityPage([{ ...LIVE_GROUP, version: 9 }]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
