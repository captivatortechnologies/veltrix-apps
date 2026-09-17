// deploy for cloud-suppression-rules.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the create/update split and the two structured filters
// that decide what stops being alerted on: `rule_selection_filter` (which
// findings) and `scope_asset_filter` (over which accounts and resources). A
// suppression written for two sandbox accounts and silently applied tenant-wide
// hides production findings, so both filters are asserted field by field.

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
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/cloud-policies\/queries\/suppression-rules\/v1/
const ENTITY = /\/cloud-policies\/entities\/suppression-rules\/v1/

/**
 * One declared suppression rule. `extractSuppressionSpecs` reads a FLAT `fields`
 * record; the severity list is Title-cased on the way out (the API's casing) and
 * every list field is comma/newline separated.
 */
const RULE = item('Sandbox noise', {
  name: 'suppress-sandbox-noise',
  description: 'Accepted findings in the sandbox accounts',
  ruleSelectionType: 'specific',
  ruleSeverities: 'medium, low',
  ruleProviders: 'AWS',
  ruleServices: 'S3, EC2',
  ruleIds: 'rule-1, rule-2',
  scopeType: 'account',
  accountIds: '111122223333, 444455556666',
  cloudProviders: 'AWS',
  regions: 'us-east-1',
  resourceTypes: 'AWS::S3::Bucket',
  suppressionReason: 'Accepted risk for sandbox accounts',
  expiration: '2027-12-31T00:00:00Z',
  enabled: true,
})

/** A second rule, used where a partial failure needs two objects. */
const SECOND_RULE = item('Lab noise', {
  name: 'suppress-lab-noise',
  ruleSelectionType: 'all',
  ruleSeverities: 'informational',
  scopeType: 'account',
  accountIds: '777788889999',
})

/**
 * The rule as it exists in the tenant BEFORE this deploy — deliberately
 * different in every managed field, so a rollback record that captured the
 * DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_RULE = {
  id: 'sup-live-1',
  name: 'suppress-sandbox-noise',
  description: 'legacy description nobody updated',
  rule_selection_type: 'all',
  rule_selection_filter: { rule_severities: ['Critical'], rule_providers: ['azure'] },
  scope_type: 'resource',
  scope_asset_filter: { account_ids: ['999988887777'], regions: ['eu-west-1'] },
  suppression_reason: 'temporary during the migration',
  suppression_expiration_date: '2026-06-01T00:00:00Z',
  disabled: true,
  modified_by: 'alice@acme.com',
  last_modified_at: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'cloud-suppression-rules', handler: deploy, items: [RULE] })

test('cloud-suppression-rules deploy: creates a rule that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sup-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'suppress-sandbox-noise')
    assert.equal(body?.rule_selection_type, 'specific')
    assert.equal(body?.scope_type, 'account')
    assert.equal(body?.description, 'Accepted findings in the sandbox accounts')
    assert.equal(body?.suppression_reason, 'Accepted risk for sandbox accounts')
    assert.equal(body?.suppression_expiration_date, '2027-12-31T00:00:00Z')

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a rule that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: sends the declared rule selection, Title-cased as the API expects', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sup-new-1' }) },
  ])
  try {
    await deploy(deployContext([RULE]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.rule_selection_filter, {
      rule_severities: ['Medium', 'Low'],
      rule_providers: ['aws'],
      rule_services: ['S3', 'EC2'],
      rule_ids: ['rule-1', 'rule-2'],
    })
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: sends the declared asset scope, and nothing wider', async () => {
  // The scope filter is what keeps the suppression off production. An omitted or
  // emptied account list would suppress the selected findings everywhere.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sup-new-1' }) },
  ])
  try {
    await deploy(deployContext([RULE]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.scope_asset_filter, {
      account_ids: ['111122223333', '444455556666'],
      cloud_providers: ['aws'],
      regions: ['us-east-1'],
      resource_types: ['AWS::S3::Bucket'],
    })
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: omits the filter keys the canvas left blank', async () => {
  // An empty array is not the same as an absent key: sending
  // `rule_services: []` risks the API reading it as "no services match".
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sup-new-2' }) },
  ])
  try {
    await deploy(deployContext([SECOND_RULE]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.rule_selection_filter, { rule_severities: ['Informational'] })
    assert.deepEqual(body?.scope_asset_filter, { account_ids: ['777788889999'] })
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: carries an intentional disable through as disabled:true', async () => {
  const disabled = item('Sandbox noise', {
    name: 'suppress-sandbox-noise',
    ruleSeverities: 'medium',
    scopeType: 'account',
    accountIds: '111122223333',
    enabled: false,
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sup-new-3' }) },
  ])
  try {
    await deploy(deployContext([disabled]))

    assert.equal(bodyOf(callsOfMethod(calls, 'POST')[0])?.disabled, true)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: records the created rule so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sup-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'suppress-sandbox-noise')
    assert.equal(state[0].existed, false, 'a rule this deploy created is not pre-existing')
    assert.equal(state[0].id, 'sup-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: updates a rule that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sup-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing rule must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'sup-live-1', 'the update must address the live rule by its id')
    assert.equal(body?.rule_selection_type, 'specific')
    assert.equal(body?.scope_type, 'account')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: records the LIVE prior values of a rule it overwrote', async () => {
  // The canvas asks for a specific, account-scoped, enabled suppression; the
  // tenant holds an all-selection, resource-scoped, disabled one. Rollback
  // restores what was there, so every value below must come from LIVE_RULE.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sup-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          name: string
          existed: boolean
          id?: string
          prior?: Record<string, unknown>
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'sup-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.rule_selection_type, 'all')
    assert.deepEqual(prior.rule_selection_filter, {
      rule_severities: ['Critical'],
      rule_providers: ['azure'],
    })
    assert.equal(prior.scope_type, 'resource')
    assert.deepEqual(prior.scope_asset_filter, {
      account_ids: ['999988887777'],
      regions: ['eu-west-1'],
    })
    assert.equal(prior.suppression_reason, 'temporary during the migration')
    assert.equal(prior.suppression_expiration_date, '2026-06-01T00:00:00Z')
    assert.equal(prior.disabled, true)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a suppression it never created as deployed — and an
  // operator then believes the findings are suppressed when they are not.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('suppression rule limit reached') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /limit reached/)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sup-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('rule is managed by the console') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /managed by the console/)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: keeps the rollback record of what it wrote when a later rule fails', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'sup-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([RULE, SECOND_RULE]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the rule that WAS created must still be recorded')
    assert.equal(state[0].name, 'suppress-sandbox-noise')
    assert.equal(state[0].id, 'sup-new-1')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sup-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_RULE]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // suppression now exists in the tenant, hiding findings, with nothing recorded
  // to delete it. Only the half that is certainly right is asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the suppression was in fact created')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
