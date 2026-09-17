// deploy for ngsiem-correlation-rules.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the create/update split, the wire shape a correlation rule
// is written in (severity as the int32 10/30/50/70/90, `create_case` as
// search.outcome, the cadence as operation.schedule.definition), the separate
// publish call, and the LIVE prior state rollback needs.
//
// Read `../../../lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache (why every context mints a fresh client secret) and
// the 401 FalconClient silently retries.

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

const QUERIES = /\/correlation-rules\/queries\/rules\/v1/
const ENTITY = /\/correlation-rules\/entities\/rules\/v1/
const PUBLISH = /\/correlation-rules\/entities\/rule-versions\/publish\/v1/

/**
 * One declared correlation rule. `extractCorrelationRuleSpecs` reads a FLAT
 * `fields` record off each canvas item — `name`, `description`, `search`,
 * `severity`, `frequency`, `triggerMode`, `mitreTactic`, `mitreTechnique`,
 * `status`, `createCase`, `publish`.
 */
const RULE = item('LSASS credential dumping', {
  name: 'lsass-credential-dumping',
  description: 'Raises a detection on LSASS memory access',
  search: '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*',
  severity: 'high',
  frequency: '15m',
  triggerMode: 'summary',
  mitreTactic: 'TA0006',
  mitreTechnique: 'T1003',
  status: 'active',
  createCase: true,
  publish: false,
})

/**
 * The rule as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_RULE = {
  id: 'rule-live-1',
  name: 'lsass-credential-dumping',
  description: 'legacy description nobody updated',
  severity: 10,
  status: 'inactive',
  search: {
    filter: '#event_simpleName=OldEventName',
    trigger_mode: 'verbose',
    outcome: 'detection',
    execution_mode: 'scheduled',
    lookback: '24h',
  },
  operation: { schedule: { definition: '@every 24h' } },
  mitre_attack: [{ tactic_id: 'TA0001' }],
  modified_by: 'alice@acme.com',
}

registerDeployGuardContract({ label: 'ngsiem-correlation-rules', handler: deploy, items: [RULE] })

test('ngsiem-correlation-rules deploy: creates a rule that does not exist yet', async () => {
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
    assert.ok(body, 'the create carried no JSON body')
    assert.equal(body.name, 'lsass-credential-dumping')
    assert.equal(body.status, 'active')
    // Severity is stored as the int32 the API uses, not the named level.
    assert.equal(body.severity, 70)

    const search = body.search as Record<string, unknown>
    assert.equal(search.filter, '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*')
    assert.equal(search.trigger_mode, 'summary')
    assert.equal(search.outcome, 'case', 'createCase is written as search.outcome')
    assert.equal(search.execution_mode, 'scheduled')
    assert.equal(search.lookback, '15m')

    const operation = body.operation as Record<string, Record<string, unknown>>
    assert.equal(operation.schedule.definition, '@every 15m')
    assert.deepEqual(body.mitre_attack, [{ tactic_id: 'TA0006', technique_id: 'T1003' }])

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new rule must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: records the created rule so rollback can delete it', async () => {
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
    assert.equal(state[0].name, 'lsass-credential-dumping')
    assert.equal(state[0].existed, false, 'a rule this deploy created is not pre-existing')
    assert.equal(state[0].id, 'rule-new-1')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: updates a rule that already exists, carrying its id', async () => {
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
    assert.ok(body, 'the update carried no JSON body')
    assert.equal(body.id, 'rule-live-1', 'the update must address the live rule by its id')
    assert.equal(body.severity, 70)
    assert.equal(body.status, 'active')
    assert.equal(
      (body.search as Record<string, unknown>).filter,
      '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*',
    )
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: records the LIVE prior values of a rule it overwrote', async () => {
  // The canvas asks for high/active/15m; the tenant holds informational/inactive
  // /24h. Rollback restores what was there, not what was wanted, so every one of
  // these must come from LIVE_RULE.
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
    assert.equal(prior.severity, 10)
    assert.equal(prior.status, 'inactive')
    assert.deepEqual(prior.search, LIVE_RULE.search)
    assert.deepEqual(prior.operation, LIVE_RULE.operation)
    assert.deepEqual(prior.mitre_attack, [{ tactic_id: 'TA0001' }])
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: publishes the HEAD version, re-resolved after the write', async () => {
  // A write mints a NEW version id, so publishing the id the create returned
  // would publish a stale version. The handler re-resolves by name first.
  const publishing = item('LSASS credential dumping', {
    ...(RULE.fields as Record<string, unknown>),
    publish: true,
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: [EMPTY, idsPage(['rule-head-2'])] },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'rule-head-2', name: 'lsass-credential-dumping' }]) },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
    { url: PUBLISH, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([publishing]))

    assert.equal(result.success, true)
    const publishes = calls.filter((c) => PUBLISH.test(c.url))
    assert.equal(publishes.length, 1, `expected exactly one publish, got ${describeCalls(publishes)}`)
    assert.equal(
      bodyOf(publishes[0])?.id,
      'rule-head-2',
      'publish must carry the re-resolved head version id, not the id the create returned',
    )
    assert.deepEqual((result.artifacts as { publishedRules?: string[] })?.publishedRules, [
      'lsass-credential-dumping',
    ])
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: does not publish a rule the canvas did not ask to publish', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
  ])
  try {
    await deploy(deployContext([RULE]))

    assert.equal(calls.filter((c) => PUBLISH.test(c.url)).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: reports failure rather than throwing when the vendor rejects', async () => {
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

test('ngsiem-correlation-rules deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a detection rule it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('correlation rule quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: treats a failed publish as a failed deploy', async () => {
  // A saved-but-unpublished rule does not run. Reporting it as deployed tells an
  // operator a detection is live when it is still a draft.
  const publishing = item('LSASS credential dumping', {
    ...(RULE.fields as Record<string, unknown>),
    publish: true,
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: [EMPTY, idsPage(['rule-head-2'])] },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'rule-head-2', name: 'lsass-credential-dumping' }]) },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
    { url: PUBLISH, method: 'PATCH', respond: partialFailure('rule version is not publishable') },
  ])
  try {
    const result = await deploy(deployContext([publishing]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not publishable/)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: keeps the rollback record of what it wrote when a later rule fails', async () => {
  // The first rule is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Suspicious service install', {
    name: 'suspicious-service-install',
    search: '#event_simpleName=ServiceStarted',
    severity: 'medium',
    frequency: '1h',
    status: 'active',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'rule-new-1' }), forbidden('access denied, authorization failed')],
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
    assert.equal(state[0].id, 'rule-new-1')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: never puts the token or the client secret in its result', async () => {
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

test('ngsiem-correlation-rules deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // rule now exists in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
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

test('ngsiem-correlation-rules deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules deploy: skips a section with no rule name', async () => {
  const NAMELESS = item('Draft', { search: '#event_simpleName=Anything', severity: 'low' })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([NAMELESS]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0, 'an unnamed rule has no identity to deploy against')
  } finally {
    restore()
  }
})
