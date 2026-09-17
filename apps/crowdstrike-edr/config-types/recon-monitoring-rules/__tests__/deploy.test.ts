// deploy for recon-monitoring-rules.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is a rule with CHILDREN: the rule itself (created through a
// JSON ARRAY body, updated without its immutable `topic`) plus the notification
// actions that are converged under it — created, updated, deleted — each of
// which has to be recorded so rollback reverses exactly this deploy.
//
// Read `../../../lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache and the 401 FalconClient silently retries.

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
  vendorCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const RULE_QUERIES = /\/recon\/queries\/rules\/v1/
const RULE_ENTITY = /\/recon\/entities\/rules\/v1/
const ACTION_QUERIES = /\/recon\/queries\/actions\/v1/
const ACTION_ENTITY = /\/recon\/entities\/actions\/v1/

const ACTIONS_JSON =
  '[{"type":"email","frequency":"asap","recipients":["soc@acme.com"],"contentFormat":"enhanced"}]'

/**
 * One declared Recon rule. `extractReconRuleSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `topic`, `filter`, `priority`, `permissions`,
 * `breachMonitoring`, `substringMatching`, `actions` (raw JSON text).
 */
const RULE = item('Leaked corporate credentials', {
  name: 'acme-leaked-credentials',
  topic: 'SA_EMAIL',
  filter: "email_domain:'acme.com'",
  priority: 'high',
  permissions: 'public',
  breachMonitoring: true,
  substringMatching: false,
})

/** The same rule with notification actions declared under it. */
const RULE_WITH_ACTIONS = item('Leaked corporate credentials', {
  ...(RULE.fields as Record<string, unknown>),
  actions: ACTIONS_JSON,
})

/**
 * The rule as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every mutable field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_RULE = {
  id: 'recon-live-1',
  name: 'acme-leaked-credentials',
  topic: 'SA_EMAIL',
  filter: "email_domain:'legacy.example'",
  priority: 'low',
  permissions: 'private',
  breach_monitoring_enabled: false,
  substring_matching_enabled: true,
  user_name: 'alice@acme.com',
}

registerDeployGuardContract({
  label: 'recon-monitoring-rules',
  handler: deploy,
  items: [RULE],
})

test('recon-monitoring-rules deploy: creates a rule that does not exist yet, carrying its topic', async () => {
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    { url: RULE_ENTITY, method: 'POST', respond: created({ id: 'recon-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    // CreateRulesV1 takes a JSON ARRAY of rule objects, unlike the rest of the
    // catalog's object bodies.
    const body = JSON.parse(posts[0].body) as Array<Record<string, unknown>>
    assert.ok(Array.isArray(body), `create body was not an array: ${posts[0].body}`)
    assert.equal(body.length, 1)
    assert.equal(body[0].name, 'acme-leaked-credentials')
    assert.equal(body[0].topic, 'SA_EMAIL', 'topic is only accepted on create')
    assert.equal(body[0].filter, "email_domain:'acme.com'")
    assert.equal(body[0].priority, 'high')
    assert.equal(body[0].permissions, 'public')
    assert.equal(body[0].breach_monitoring_enabled, true)
    assert.equal(body[0].substring_matching_enabled, false)

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: records the created rule so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    { url: RULE_ENTITY, method: 'POST', respond: created({ id: 'recon-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'acme-leaked-credentials')
    assert.equal(state[0].existed, false)
    assert.equal(state[0].id, 'recon-new-1')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: updates an existing rule and never sends the immutable topic', async () => {
  // The API rejects a topic on update; sending one would fail every update of a
  // rule that is otherwise fine.
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-live-1']) },
    { url: RULE_ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing rule must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.ok(body, 'the update carried no JSON body')
    assert.equal(body.id, 'recon-live-1', 'the update must address the live rule by its id')
    assert.equal(body.filter, "email_domain:'acme.com'")
    assert.equal(body.priority, 'high')
    assert.equal(body.topic, undefined, 'topic is immutable and must never be sent on update')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: records the LIVE prior values of a rule it overwrote', async () => {
  // The canvas asks for high/public/breach-on; the tenant holds
  // low/private/breach-off. Rollback restores what was there, not what was
  // wanted, so every one of these must come from LIVE_RULE.
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-live-1']) },
    { url: RULE_ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'recon-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.filter, "email_domain:'legacy.example'")
    assert.equal(prior.priority, 'low')
    assert.equal(prior.permissions, 'private')
    assert.equal(prior.breach_monitoring_enabled, false)
    assert.equal(prior.substring_matching_enabled, true)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: creates a declared notification action and records its id', async () => {
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    { url: RULE_ENTITY, method: 'POST', respond: created({ id: 'recon-new-1' }) },
    { url: ACTION_QUERIES, respond: EMPTY },
    { url: ACTION_ENTITY, method: 'POST', respond: created({ id: 'action-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE_WITH_ACTIONS]))

    assert.equal(result.success, true)
    const actionPosts = callsOfMethod(calls, 'POST').filter((c) => ACTION_ENTITY.test(c.url))
    assert.equal(actionPosts.length, 1, `expected one action create, got ${describeCalls(actionPosts)}`)

    const body = bodyOf(actionPosts[0])
    assert.ok(body, 'the action create carried no JSON body')
    assert.equal(body.rule_id, 'recon-new-1')
    const actions = body.actions as Array<Record<string, unknown>>
    assert.equal(actions[0].type, 'email')
    assert.equal(actions[0].frequency, 'asap')
    assert.deepEqual(actions[0].recipients, ['soc@acme.com'])
    assert.equal(actions[0].content_format, 'enhanced')

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.deepEqual(
      state?.[0].createdActionIds,
      ['action-new-1'],
      'an action rollback cannot delete is an action that keeps emailing',
    )
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: updates a matching action whose content format differs, recording the prior', async () => {
  // Actions are matched on type + frequency + recipients, so a format-only
  // change is an update rather than a delete and recreate.
  const liveAction = {
    id: 'action-live-1',
    rule_id: 'recon-live-1',
    type: 'email',
    frequency: 'asap',
    recipients: ['soc@acme.com'],
    content_format: 'standard',
  }
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-live-1']) },
    { url: RULE_ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
    { url: ACTION_QUERIES, respond: idsPage(['action-live-1']) },
    { url: ACTION_ENTITY, method: 'GET', respond: entityPage([liveAction]) },
    { url: ACTION_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE_WITH_ACTIONS]))

    assert.equal(result.success, true)
    const actionPatches = callsOfMethod(calls, 'PATCH').filter((c) => ACTION_ENTITY.test(c.url))
    assert.equal(actionPatches.length, 1, `expected one action update, got ${describeCalls(actionPatches)}`)
    assert.equal(bodyOf(actionPatches[0])?.content_format, 'enhanced')
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a matched action is updated in place, never deleted and recreated',
    )

    const state = (
      result.rollbackData as { previousState?: Array<{ updatedActions?: Array<Record<string, unknown>> }> }
    )?.previousState
    const updated = state?.[0].updatedActions
    assert.ok(updated, 'deploy recorded no updated-action state')
    assert.equal(updated[0].id, 'action-live-1')
    assert.equal(
      updated[0].content_format,
      'standard',
      'the recorded format must be the LIVE prior one, not the one just written',
    )
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: records an undeclared action in full before deleting it', async () => {
  // Deleting a notification the customer set up by hand is recoverable only if
  // its recipients and cadence were captured first.
  const strayAction = {
    id: 'action-stray-1',
    rule_id: 'recon-live-1',
    type: 'email',
    frequency: 'weekly',
    recipients: ['legacy-dl@acme.com'],
    content_format: 'standard',
  }
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-live-1']) },
    { url: RULE_ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
    { url: ACTION_QUERIES, respond: idsPage(['action-stray-1']) },
    { url: ACTION_ENTITY, method: 'GET', respond: entityPage([strayAction]) },
    { url: ACTION_ENTITY, method: 'POST', respond: created({ id: 'action-new-1' }) },
    { url: ACTION_ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE_WITH_ACTIONS]))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected one action delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=action-stray-1/)

    const state = (
      result.rollbackData as { previousState?: Array<{ deletedActions?: Array<Record<string, unknown>> }> }
    )?.previousState
    const deleted = state?.[0].deletedActions
    assert.ok(deleted, 'deploy deleted an action without recording it')
    assert.equal(deleted[0].frequency, 'weekly')
    assert.deepEqual(deleted[0].recipients, ['legacy-dl@acme.com'])
    assert.equal(deleted[0].contentFormat, 'standard')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: leaves existing actions alone when the canvas declares none', async () => {
  // A blank actions field means "not managed here" — converging it to an empty
  // set would silently switch off a customer's notifications.
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-live-1']) },
    { url: RULE_ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([RULE]))

    assert.equal(
      calls.filter((c) => ACTION_QUERIES.test(c.url) || ACTION_ENTITY.test(c.url)).length,
      0,
      'an undeclared actions field must not be read or converged',
    )
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: refuses malformed actions JSON without touching the tenant', async () => {
  const BAD = item('Leaked corporate credentials', {
    ...(RULE.fields as Record<string, unknown>),
    actions: '[{"type":"email","frequency":"hourly","recipients":["soc@acme.com"]}]',
  })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], EMPTY)
  try {
    const result = await deploy(deployContext([BAD]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /frequency/)
    assert.equal(vendorCalls(calls).length, 0, 'the rule must not be written before its actions parse')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    { url: RULE_ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a rule it never created as deployed.
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    { url: RULE_ENTITY, method: 'POST', respond: partialFailure('monitoring rule quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: keeps the rollback record of what it wrote when a later rule fails', async () => {
  const SECOND = item('Brand impersonation', {
    name: 'acme-brand-impersonation',
    topic: 'SA_BRAND_PRODUCT',
    filter: "brand:'ACME'",
  })
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    {
      url: RULE_ENTITY,
      method: 'POST',
      respond: [created({ id: 'recon-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([RULE, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the rule that WAS created must still be recorded')
    assert.equal(state[0].id, 'recon-new-1')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-live-1']) },
    { url: RULE_ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createRule` throws here AFTER the POST
  // succeeded and BEFORE `rollbackState.push` — so the rule now exists in the
  // tenant with nothing recorded to delete it. What is asserted is only the
  // half that is certainly right: the deploy does not claim success. The
  // rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: EMPTY },
    { url: RULE_ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the rule was in fact created')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
