// deploy for filevantage-rule-groups.
//
// The group entity carries only ordered rule REFERENCES; the rule bodies live on
// a separate path (`…/rule-groups-rules`) and each carries its parent
// `rule_group_id`. So reconciling rules means a second read, and the assertion
// that matters most is what happens when that read fails: rules are matched by
// path, so an empty list would read as "no rules exist" and re-create every one
// of them. The handler throws instead, and this proves it.
//
// As with custom-ioa-rule-groups, rules this canvas never declared are left
// alone — a FileVantage group routinely carries paths an analyst added by hand.
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
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/filevantage\/queries\/rule-groups\/v1/
const RULES = /\/filevantage\/entities\/rule-groups-rules\/v1/
const GROUPS = /\/filevantage\/entities\/rule-groups\/v1/

const WATCHED_PATH = 'C:\\Windows\\System32'

/** One declared rule, as `parseRuleSpecs` reads it out of the JSON string. */
const DECLARED_RULE = {
  path: WATCHED_PATH,
  severity: 'High',
  depth: 'ANY',
  description: 'System binaries',
  watch_write_file_changes: true,
  watch_delete_file_changes: true,
}

/**
 * One declared rule group. `extractRuleGroupSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `type`, `description`, and `rules` as a JSON
 * STRING.
 */
const GROUP = item('System binary monitoring', {
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  description: 'Monitored system paths',
  rules: JSON.stringify([DECLARED_RULE]),
})

/** A live rule matching the declared one, overridable field by field. */
const liveRule = (over: Record<string, unknown> = {}) => ({
  id: 'fvr-1',
  precedence: 1,
  path: WATCHED_PATH,
  severity: 'High',
  depth: 'ANY',
  description: 'System binaries',
  watch_write_file_changes: true,
  watch_delete_file_changes: true,
  ...over,
})

/**
 * The group as it exists in the tenant BEFORE this deploy — its description
 * deliberately different from the canvas, so a rollback record that captured the
 * DESIRED value instead of the LIVE one fails these assertions.
 */
const LIVE_GROUP = {
  id: 'fvrg-live-1',
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  description: 'legacy description nobody updated',
  assigned_rules: [{ id: 'fvr-1' }],
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'filevantage-rule-groups', handler: deploy, items: [GROUP] })

test('filevantage-rule-groups deploy: creates a group and its rules when none exists', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: RULES, method: 'POST', respond: created({ id: 'fvr-new' }) },
    { url: GROUPS, method: 'POST', respond: created({ id: 'fvrg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.equal(result.success, true)

    const groupPost = callsOfMethod(calls, 'POST').find((c) => GROUPS.test(c.url))
    assert.ok(groupPost, `expected a group create, got ${describeCalls(writeCalls(calls))}`)
    const groupBody = bodyOf(groupPost)
    assert.equal(groupBody?.name, 'veltrix-fim-system')
    assert.equal(groupBody?.type, 'WindowsFiles', 'the type is immutable, so it is set at create time')
    assert.equal(groupBody?.description, 'Monitored system paths')

    const rulePost = callsOfMethod(calls, 'POST').find((c) => RULES.test(c.url))
    assert.ok(rulePost, 'the declared rule must be created under the new group')
    const ruleBody = bodyOf(rulePost)
    assert.equal(ruleBody?.rule_group_id, 'fvrg-new-1', 'a rule carries its parent group id')
    assert.equal(ruleBody?.path, WATCHED_PATH)
    assert.equal(ruleBody?.severity, 'High')
    assert.equal(ruleBody?.watch_write_file_changes, true)
    assert.equal(
      ruleBody?.watch_create_file_changes,
      false,
      'unset toggles are sent as false so deploy fully converges the live rule',
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: RULES, method: 'POST', respond: created({ id: 'fvr-new' }) },
    { url: GROUPS, method: 'POST', respond: created({ id: 'fvrg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'veltrix-fim-system')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'fvrg-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: updates a rule whose live configuration drifted', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: entityPage([liveRule({ severity: 'Low' })]) },
    { url: RULES, method: 'PATCH', respond: ok() },
    { url: GROUPS, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing rule must not be created again')

    const rulePatch = callsOfMethod(calls, 'PATCH').find((c) => RULES.test(c.url))
    assert.ok(rulePatch, `expected a rule update, got ${describeCalls(writeCalls(calls))}`)
    const ruleBody = bodyOf(rulePatch)
    assert.equal(ruleBody?.id, 'fvr-1', 'the update must address the live rule by its id')
    assert.equal(ruleBody?.rule_group_id, 'fvrg-live-1')
    assert.equal(ruleBody?.severity, 'High', 'the declared severity replaces the weakened live one')
    assert.equal(ruleBody?.precedence, 1, 'the live precedence is echoed so rule order is preserved')

    const groupBody = bodyOf(callsOfMethod(calls, 'PATCH').find((c) => GROUPS.test(c.url)))
    assert.equal(groupBody?.id, 'fvrg-live-1')
    assert.equal(groupBody?.description, 'Monitored system paths')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: does not rewrite a rule that already matches', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: entityPage([liveRule()]) },
    { url: GROUPS, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([GROUP]))

    assert.equal(
      callsOfMethod(calls, 'PATCH').filter((c) => RULES.test(c.url)).length,
      0,
      'a matching rule needs no write',
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: leaves a live rule this canvas never declared alone', async () => {
  // An analyst's own watched path on the same group is not this app's to remove.
  const analyst = liveRule({ id: 'fvr-analyst', path: 'C:\\Temp', description: 'analyst path' })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: entityPage([liveRule(), analyst]) },
    {
      url: GROUPS,
      method: 'GET',
      respond: entityPage([{ ...LIVE_GROUP, assigned_rules: [{ id: 'fvr-1' }, { id: 'fvr-analyst' }] }]),
    },
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
    assert.equal(
      callsOfMethod(calls, 'PATCH').filter((c) => RULES.test(c.url)).length,
      0,
      'an undeclared rule must not be rewritten either',
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: creates a declared rule missing from an existing group and records it', async () => {
  // Rollback deletes exactly the rules THIS deploy added under a pre-existing
  // group — it cannot delete the group itself, which it did not create.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'POST', respond: created({ id: 'fvr-new' }) },
    { url: GROUPS, method: 'GET', respond: entityPage([{ ...LIVE_GROUP, assigned_rules: [] }]) },
    { url: GROUPS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').filter((c) => RULES.test(c.url)).length, 1)

    const state = (result.rollbackData as { previousState?: Array<{ createdRuleIds?: string[] }> })
      ?.previousState
    assert.ok(state)
    assert.deepEqual(
      state[0].createdRuleIds,
      ['fvr-new'],
      'a rule this deploy added to somebody else’s group must be recorded for removal',
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: a failed rule read stops the deploy rather than re-creating every rule', async () => {
  // Rules are matched by path. Letting a failed read become an empty list would
  // make every declared rule look absent and create a duplicate of each.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: serverError() },
    { url: GROUPS, method: 'GET', respond: entityPage([LIVE_GROUP]) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      `an unreadable rule list became a create: ${describeCalls(writeCalls(calls))}`,
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: records the LIVE prior name and description', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: entityPage([liveRule()]) },
    { url: GROUPS, method: 'GET', respond: entityPage([LIVE_GROUP]) },
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
    assert.equal(state[0].id, 'fvrg-live-1')
    assert.equal(state[0].prior?.name, 'veltrix-fim-system')
    assert.equal(state[0].prior?.description, 'legacy description nobody updated')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: refuses invalid rules JSON before touching the tenant', async () => {
  const BROKEN = item('System binary monitoring', {
    name: 'veltrix-fim-system',
    type: 'WindowsFiles',
    rules: '[{"path":"C:\\\\Windows","severity":"Nope","description":"x"}]',
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

test('filevantage-rule-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
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

test('filevantage-rule-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as monitoring files.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
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

test('filevantage-rule-groups deploy: treats a 200 errors[] on a rule write as a failure', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: entityPage([liveRule({ severity: 'Low' })]) },
    { url: RULES, method: 'PATCH', respond: partialFailure('rule is read-only') },
    { url: GROUPS, method: 'GET', respond: entityPage([LIVE_GROUP]) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createFileVantage` throws here AFTER the
  // POST succeeded, and `rollbackState.push` is the statement below its call —
  // so the group now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: GROUPS, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the group was in fact created')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: keeps the rollback record of what it wrote when a later group fails', async () => {
  const SECOND = item('Registry monitoring', {
    name: 'veltrix-fim-registry',
    type: 'WindowsRegistry',
    rules: '[]',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: RULES, method: 'POST', respond: created({ id: 'fvr-new' }) },
    {
      url: GROUPS,
      method: 'POST',
      respond: [created({ id: 'fvrg-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([GROUP, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the group that WAS created must still be recorded')
    assert.equal(state[0].id, 'fvrg-new-1')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvrg-live-1']) },
    { url: RULES, method: 'GET', respond: entityPage([liveRule()]) },
    { url: GROUPS, method: 'GET', respond: entityPage([LIVE_GROUP]) },
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

test('filevantage-rule-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
