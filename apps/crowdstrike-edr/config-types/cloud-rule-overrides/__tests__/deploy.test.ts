// deploy for cloud-rule-overrides.
//
// The shared contract covers the pre-flight refusals every config type has. Two
// things make this config type different from the rest of the cloud-policies
// family, and both are asserted here:
//
//   * there is NO queries endpoint — an existing override is read directly by
//     `GET <entity>?ids=<rule_id>`, a single call rather than the usual two;
//   * the write body is WRAPPED as `{ overrides: [ { … } ] }`, so an unwrapped
//     body would be silently accepted as an empty batch.
//
// An override suppresses a built-in Cloud Security rule for a scope, so the
// `crn` that scopes it is load-bearing: an override meant for one cloud account
// that lands on all of them turns a built-in rule off tenant-wide.

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
  notFound,
  ok,
  partialFailure,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/cloud-policies\/entities\/rule-overrides\/v1/

/**
 * One declared rule override. `extractOverrideSpecs` reads a FLAT `fields`
 * record — `ruleId`, `overrideType`, `overrideDetails`, `reason`, `comment`,
 * `crn`, `targetRegion`, `expiresAt`.
 */
const OVERRIDE = item('Public bucket exception', {
  ruleId: 'rule-1234',
  overrideType: 'exception',
  overrideDetails: 'Bucket is a public website origin',
  reason: 'Approved by the cloud security review board',
  comment: 'Ticket SEC-4412',
  crn: 'crn:aws:111122223333',
  targetRegion: 'us-east-1',
  expiresAt: '2027-12-31T00:00:00Z',
})

/** A second override, used where a partial failure needs two objects. */
const SECOND_OVERRIDE = item('Lab exception', {
  ruleId: 'rule-9876',
  overrideType: 'exception',
})

/** The first entry of the wrapped `{ overrides: [ … ] }` write body. */
function overrideEntry(body: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const overrides = body?.overrides
  return Array.isArray(overrides) ? (overrides[0] as Record<string, unknown>) : undefined
}

/**
 * The override as it exists in the tenant BEFORE this deploy — deliberately
 * different in every managed field, so a rollback record that captured the
 * DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_OVERRIDE = {
  id: 'ov-live-1',
  rule_id: 'rule-1234',
  crn: 'crn:aws:111122223333',
  override_type: 'suppression',
  overrides_details: 'legacy details nobody updated',
  reason: 'temporary during the migration',
  comment: 'added by hand during an incident',
  target_region: 'eu-west-1',
  expires_at: '2026-06-01T00:00:00Z',
  modified_by: 'alice@acme.com',
  modified_at: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'cloud-rule-overrides', handler: deploy, items: [OVERRIDE] })

test('cloud-rule-overrides deploy: creates an override that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ov-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.match(tenantCalls[0].url, /ids=rule-1234/, 'the existing override is read by its rule id')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const entry = overrideEntry(bodyOf(posts[0]))
    assert.ok(entry, 'the write body must be wrapped as { overrides: [ … ] }')
    assert.equal(entry.rule_id, 'rule-1234')
    assert.equal(entry.override_type, 'exception')
    assert.equal(entry.overrides_details, 'Bucket is a public website origin')
    assert.equal(entry.reason, 'Approved by the cloud security review board')
    assert.equal(entry.comment, 'Ticket SEC-4412')
    assert.equal(entry.target_region, 'us-east-1')
    assert.equal(entry.expires_at, '2027-12-31T00:00:00Z')

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'an override that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: carries the cloud-account scope into the write body', async () => {
  // The crn is what keeps the override on one account. Dropping it turns off a
  // built-in Cloud Security rule for the whole tenant.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ov-new-1' }) },
  ])
  try {
    await deploy(deployContext([OVERRIDE]))

    assert.equal(overrideEntry(bodyOf(callsOfMethod(calls, 'POST')[0]))?.crn, 'crn:aws:111122223333')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: omits the optional fields the canvas left blank', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ov-new-2' }) },
  ])
  try {
    await deploy(deployContext([SECOND_OVERRIDE]))

    const entry = overrideEntry(bodyOf(callsOfMethod(calls, 'POST')[0])) ?? {}
    assert.equal('crn' in entry, false)
    assert.equal('expires_at' in entry, false)
    assert.equal('target_region' in entry, false)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: does not adopt an override scoped to a different cloud account', async () => {
  // The tenant holds an override for the same rule on another account. Patching
  // that one would move the exception onto an account nobody scoped it to.
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ ...LIVE_OVERRIDE, crn: 'crn:aws:999988887777' }]),
    },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ov-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'another account’s override must not be patched')
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'a scoped override is created for this account')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: records the created override so rollback can remove it', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ov-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].ruleId, 'rule-1234')
    assert.equal(state[0].crn, 'crn:aws:111122223333')
    assert.equal(state[0].existed, false, 'an override this deploy created is not pre-existing')
    assert.equal(state[0].id, 'ov-new-1')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: updates an override that already exists', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_OVERRIDE]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing override must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const entry = overrideEntry(bodyOf(patches[0]))
    assert.ok(entry, 'the update body must be wrapped as { overrides: [ … ] }')
    assert.equal(entry.rule_id, 'rule-1234', 'the update must address the override by its rule id')
    assert.equal(entry.crn, 'crn:aws:111122223333')
    assert.equal(entry.override_type, 'exception')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: records the LIVE prior values of an override it overwrote', async () => {
  // The canvas asks for an exception in us-east-1 expiring in 2027; the tenant
  // holds a suppression in eu-west-1 expiring in 2026. Rollback restores what
  // was there, so every value below must come from LIVE_OVERRIDE.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_OVERRIDE]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          ruleId: string
          existed: boolean
          id?: string
          prior?: Record<string, unknown>
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'ov-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.override_type, 'suppression')
    assert.equal(prior.overrides_details, 'legacy details nobody updated')
    assert.equal(prior.reason, 'temporary during the migration')
    assert.equal(prior.comment, 'added by hand during an incident')
    assert.equal(prior.target_region, 'eu-west-1')
    assert.equal(prior.expires_at, '2026-06-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: refuses to write when the current override cannot be read', async () => {
  // A 500 on the read is "I could not tell", not "there is none". Creating on
  // that basis would duplicate an override that already exists.
  const { calls, restore } = routeFetch(
    [{ url: /oauth2\/token/, respond: TOKEN }],
    serverError('internal server error'),
  )
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /internal server error/)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: treats a 404 on the read as "no override yet", not as an error', async () => {
  // Unlike a 5xx, "gone" is a known answer — the override simply does not exist.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: notFound() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ov-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 1)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an exception it never created as deployed.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('unknown rule id') },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /unknown rule id/)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_OVERRIDE]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('override is managed by the console') },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /managed by the console/)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: keeps the rollback record of what it wrote when a later override fails', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'ov-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE, SECOND_OVERRIDE]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the override that WAS created must still be recorded')
    assert.equal(state[0].ruleId, 'rule-1234')
    assert.equal(state[0].id, 'ov-new-1')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: records a create whose response carried no id', async () => {
  // This API does not always echo an id. The entry must still be recorded — it
  // carries the rule id, which is what rollback re-resolves the override by.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'an override was created with nothing recorded to remove it')
    assert.equal(state[0].ruleId, 'rule-1234')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_OVERRIDE]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([OVERRIDE]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
