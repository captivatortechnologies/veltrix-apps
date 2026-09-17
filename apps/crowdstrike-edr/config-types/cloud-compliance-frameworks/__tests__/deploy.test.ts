// deploy for cloud-compliance-frameworks.
//
// The frameworks collection is close to lib/entityAdapter but differs in three
// ways the assertions below pin down: the id is `uuid` rather than `id`, the
// update carries that uuid in the `ids` QUERY param (not the body), and the
// query filter field is `compliance_framework_name` while the identity pin is on
// the entity's `name`. Get any of those wrong and the handler silently patches
// the wrong framework — or none.

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
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/cloud-policies\/queries\/compliance\/frameworks\/v1/
const ENTITY = /\/cloud-policies\/entities\/compliance\/frameworks\/v1/

/**
 * One declared framework. `extractFrameworkSpecs` reads a FLAT `fields` record —
 * `name`, `description`, `version` and a `sections` JSON string.
 */
const FRAMEWORK = item('ACME cloud baseline', {
  name: 'ACME Cloud Baseline',
  description: 'Internal cloud control baseline',
  sections: '[{"name":"Access Control"},{"name":"Logging"}]',
})

/**
 * The framework as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_FRAMEWORK = {
  uuid: 'fw-live-1',
  name: 'ACME Cloud Baseline',
  description: 'legacy description nobody updated',
  active: false,
  version: '0.9',
}

registerDeployGuardContract({
  label: 'cloud-compliance-frameworks',
  handler: deploy,
  items: [FRAMEWORK],
})

test('cloud-compliance-frameworks deploy: creates a framework that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ uuid: 'fw-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.match(
      tenantCalls[0].url,
      /filter=compliance_framework_name/,
      'the frameworks query filters on compliance_framework_name, not name',
    )

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'ACME Cloud Baseline')
    assert.equal(body?.description, 'Internal cloud control baseline')
    assert.equal(body?.active, true)

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a framework that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: records the created framework so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ uuid: 'fw-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'ACME Cloud Baseline')
    assert.equal(state[0].existed, false, 'a framework this deploy created is not pre-existing')
    assert.equal(state[0].uuid, 'fw-new-1', 'without the new uuid rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: updates a framework that already exists, addressing it by uuid', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fw-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_FRAMEWORK]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing framework must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=fw-live-1/, 'the uuid travels in the ids query, not the body')
    const body = bodyOf(patches[0])
    assert.equal(body?.name, 'ACME Cloud Baseline')
    assert.equal(body?.description, 'Internal cloud control baseline')
    assert.equal(body?.active, true, 'a deployed framework is activated')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: records the LIVE prior values of a framework it overwrote', async () => {
  // The canvas asks for the new description and an active framework; the tenant
  // holds the legacy description and an INACTIVE one. Rollback restores what was
  // there, so both of these must come from LIVE_FRAMEWORK.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fw-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_FRAMEWORK]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; uuid?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].uuid, 'fw-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.active, false)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: does not adopt a framework whose name merely resembles the declared one', async () => {
  // The query filter is a Falcon-side match; the identity pin is client-side. A
  // near-miss must be created fresh, never patched over.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fw-other-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ uuid: 'fw-other-1', name: 'ACME Cloud Baseline (draft)' }]),
    },
    { url: ENTITY, method: 'POST', respond: created({ uuid: 'fw-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a near-miss framework must never be patched')
    assert.equal(callsOfMethod(calls, 'POST').length, 1)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a framework it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('custom framework quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: a failed search fails the deploy without writing', async () => {
  // A 500 on the lookup is "I could not tell whether this framework exists".
  // Treating it as absent would create a duplicate custom framework.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: serverError() }])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    assert.equal(result.success, false)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'nothing may be created on an unreadable tenant')
    assert.match(String(result.message), /Failed to search framework/)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: keeps the rollback record of what it wrote when a later framework fails', async () => {
  // The first framework is created, the second is rejected. Everything the
  // deploy already changed must still come back on the failure path — a `catch`
  // that returns only `{ success: false, message }` discards it.
  const SECOND = item('ACME staging baseline', { name: 'ACME Staging Baseline' })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ uuid: 'fw-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the framework that WAS created must still be recorded')
    assert.equal(state[0].name, 'ACME Cloud Baseline')
    assert.equal(state[0].uuid, 'fw-new-1')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: a create that returns no uuid is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createFramework` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // framework now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no uuid/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the framework was in fact created')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fw-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_FRAMEWORK]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([FRAMEWORK]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
