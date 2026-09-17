// deploy for cloud-iom-custom-rules.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the create/update split and the fields that decide what a
// custom IOM rule evaluates: the cloud provider and resource type it targets,
// the Rego logic it runs, and the compliance controls it reports under. The
// update path is the one that silently overwrites a rule an operator tuned by
// hand, so the PATCH body and the prior state it records are asserted in detail.

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

const QUERIES = /\/cloud-policies\/queries\/rules\/v1/
const ENTITY = /\/cloud-policies\/entities\/rules\/v1/

/**
 * One declared IOM custom rule. `extractCloudIomRuleSpecs` reads a FLAT `fields`
 * record — `name`, `description`, `cloudProvider`, `resourceType`, `severity`,
 * `logic`, `controls` (a JSON array as a string) and `parentRuleId`.
 */
const RULE = item('Public S3 buckets', {
  name: 'block-public-s3',
  description: 'Flags S3 buckets that allow public read access',
  cloudProvider: 'aws',
  resourceType: 'AWS::S3::Bucket',
  severity: 'high',
  logic: 'package veltrix\ndeny { input.public_read }',
  controls: '[{"authority":"CIS","code":"2.1.5"}]',
})

/** A second rule, used where a partial failure needs two objects. */
const SECOND_RULE = item('Open security groups', {
  name: 'block-open-sg',
  description: 'Flags security groups open to 0.0.0.0/0',
  cloudProvider: 'aws',
  resourceType: 'AWS::EC2::SecurityGroup',
  severity: 'critical',
  logic: 'package veltrix\ndeny { input.cidr == "0.0.0.0/0" }',
})

/**
 * The rule as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_RULE = {
  id: 'rule-live-1',
  name: 'block-public-s3',
  description: 'legacy description nobody updated',
  cloud_provider: 'azure',
  resource_type: 'Microsoft.Storage/storageAccounts',
  severity: 'informational',
  logic: 'package legacy\ndeny { false }',
  controls: [{ authority: 'NIST', code: 'AC-2' }],
  parent_rule_id: 'parent-legacy-1',
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'cloud-iom-custom-rules', handler: deploy, items: [RULE] })

test('cloud-iom-custom-rules deploy: creates a rule that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'block-public-s3')
    assert.equal(body?.description, 'Flags S3 buckets that allow public read access')
    assert.equal(body?.cloud_provider, 'aws')
    assert.equal(body?.resource_type, 'AWS::S3::Bucket')
    assert.equal(body?.severity, 'high')
    assert.equal(body?.logic, 'package veltrix\ndeny { input.public_read }')
    assert.deepEqual(body?.controls, [{ authority: 'CIS', code: '2.1.5' }])

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

test('cloud-iom-custom-rules deploy: omits logic, controls and parent when the canvas declared none', async () => {
  // A rule that inherits from a parent has no logic of its own; sending an empty
  // string would replace the inherited policy with one that evaluates nothing.
  const inherited = item('Inherited rule', {
    name: 'inherited-rule',
    description: 'Inherits its logic from a built-in rule',
    cloudProvider: 'gcp',
    resourceType: 'compute.googleapis.com/Instance',
    severity: 'medium',
    parentRuleId: 'parent-1',
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-2' }) },
  ])
  try {
    await deploy(deployContext([inherited]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.equal('logic' in (body ?? {}), false)
    assert.equal('controls' in (body ?? {}), false)
    assert.equal(body?.parent_rule_id, 'parent-1')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: records the created rule so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'block-public-s3')
    assert.equal(state[0].existed, false, 'a rule this deploy created is not pre-existing')
    assert.equal(state[0].id, 'rule-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: updates a rule that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-live-1']) },
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
    assert.equal(body?.id, 'rule-live-1', 'the update must address the live rule by its id')
    assert.equal(body?.cloud_provider, 'aws')
    assert.equal(body?.resource_type, 'AWS::S3::Bucket')
    assert.equal(body?.severity, 'high')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: records the LIVE prior values of a rule it overwrote', async () => {
  // The canvas asks for an AWS S3 rule at high severity; the tenant holds an
  // Azure storage rule at informational. Rollback restores what was there, not
  // what was wanted, so every value below must come from LIVE_RULE.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-live-1']) },
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
    assert.equal(state[0].id, 'rule-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.cloud_provider, 'azure')
    assert.equal(prior.resource_type, 'Microsoft.Storage/storageAccounts')
    assert.equal(prior.severity, 'informational')
    assert.equal(prior.logic, 'package legacy\ndeny { false }')
    assert.deepEqual(prior.controls, [{ authority: 'NIST', code: 'AC-2' }])
    assert.equal(prior.parent_rule_id, 'parent-legacy-1')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
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

test('cloud-iom-custom-rules deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a rule it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('rego policy failed to compile') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /failed to compile/)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-live-1']) },
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

test('cloud-iom-custom-rules deploy: keeps the rollback record of what it wrote when a later rule fails', async () => {
  // The first rule is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'rule-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([RULE, SECOND_RULE]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the rule that WAS created must still be recorded')
    assert.equal(state[0].name, 'block-public-s3')
    assert.equal(state[0].id, 'rule-new-1')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-live-1']) },
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

test('cloud-iom-custom-rules deploy: recovers the id of a create whose response carried none', async () => {
  // The POST succeeded, so the rule exists in the tenant. `createEntity` used to
  // throw straight from the missing-id check, and the caller's
  // `rollbackState.push` is the line AFTER it — so the deploy reported "failed,
  // nothing to undo" about a live rule. It now re-resolves by the identity it
  // just sent, which recovers the id in the ordinary case.
  const { calls, restore } = routeFetch([
    // The name query answers twice: empty before the create, then finding it.
    { url: QUERIES, respond: [EMPTY, idsPage(['rule-recovered'])] },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'rule-recovered', name: 'block-public-s3' }]) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the rule was created exactly once')
    const state = (result.rollbackData as { previousState: Array<Record<string, unknown>> }).previousState
    assert.deepEqual(state, [{ name: 'block-public-s3', existed: false, id: 'rule-recovered' }])
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: a create it cannot find afterwards says the rule EXISTS', async () => {
  // The residual case: created, no id, and the re-resolve comes back empty too.
  // Nothing can record it — but the message must not imply nothing was written,
  // because something was, and only the operator can clean it up.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.match(String(result.message), /EXISTS in the tenant/)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the rule was in fact created')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
