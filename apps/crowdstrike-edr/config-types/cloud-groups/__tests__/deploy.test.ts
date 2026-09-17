// ============================================================================
// Handler tests against a FAKE VENDOR — the pattern the catalog was missing.
//
// Across 96 apps and 1170 configuration types, `validate` is tested everywhere
// and the five handlers that actually talk to the vendor are not: deploy,
// rollback, healthCheck and driftDetect sat near zero, getStatus at zero. The
// untested part is precisely the part that performs real actions against a
// customer's infrastructure.
//
// Nothing exotic is needed to close that. 89 of 96 apps reach the vendor through
// global `fetch`, so stubbing `globalThis.fetch` exercises a handler end to end
// — its request sequence, its body, its error handling and the rollback state it
// records — with no module mocking, no new dependency, and plain `node --test`.
//
// This file is the worked example for this app. The harness itself now lives in
// `apps/crowdstrike-edr/lib/__tests__/fakeFalcon.ts` so all 44 configuration
// types drive ONE fake Falcon rather than 44 hand-copied stubs, and the shared
// refusals live in `falconContracts.ts` beside it. Read `fakeFalcon.ts` first —
// its header explains the two things that make this vendor awkward to fake: a
// module-scope token cache (which is why every context mints a fresh client
// secret) and a 401 that `FalconClient` silently retries.
// ============================================================================

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
  createdId,
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

const QUERIES = /\/cloud-security\/queries\/cloud-groups\/v1/
const ENTITY = /\/cloud-security\/entities\/cloud-groups\/v1/

/**
 * One declared cloud group. `extractCloudGroupSpecs` reads a FLAT `fields`
 * record off each canvas item — `name`, `businessImpact`, `businessUnit`,
 * `environment`, `owners`, `description`, `scoping`.
 */
const GROUP = item('Production workloads', {
  name: 'prod-workloads',
  description: 'Tier 1 production estate',
  businessImpact: 'high',
  businessUnit: 'Payments',
  environment: 'prod',
  owners: 'sec@acme.com, cloudops@acme.com',
})

/**
 * The group as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_GROUP = {
  id: 'grp-live-1',
  name: 'prod-workloads',
  description: 'legacy description nobody updated',
  business_impact: 'low',
  business_unit: 'Shared Services',
  environment: 'dev',
  owners: ['retired-owner@acme.com'],
  updated_by: 'alice@acme.com',
  updated_at: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'cloud-groups', handler: deploy, items: [GROUP] })

test('cloud-groups deploy: creates a group that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: createdId('grp-new-1') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'prod-workloads')
    assert.equal(body?.business_impact, 'high')
    assert.equal(body?.environment, 'prod')
    assert.equal(body?.business_unit, 'Payments')
    assert.deepEqual(body?.owners, ['sec@acme.com', 'cloudops@acme.com'])

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a group that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: createdId('grp-new-1') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'prod-workloads')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'grp-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-groups deploy: updates a group that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['grp-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing group must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'grp-live-1', 'the update must address the live group by its id')
    assert.equal(body?.business_impact, 'high')
    assert.equal(body?.environment, 'prod')
  } finally {
    restore()
  }
})

test('cloud-groups deploy: records the LIVE prior values of a group it overwrote', async () => {
  // The canvas asks for high/prod/Payments; the tenant holds low/dev/Shared
  // Services. Rollback restores what was there, not what was wanted, so every
  // one of these must come from LIVE_GROUP.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['grp-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

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
    assert.equal(state[0].id, 'grp-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.business_impact, 'low')
    assert.equal(prior.business_unit, 'Shared Services')
    assert.equal(prior.environment, 'dev')
    assert.deepEqual(prior.owners, ['retired-owner@acme.com'])
  } finally {
    restore()
  }
})

test('cloud-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
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

test('cloud-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('cloud group quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('cloud-groups deploy: keeps the rollback record of what it wrote when a later group fails', async () => {
  // The first group is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Staging workloads', {
    name: 'stage-workloads',
    businessImpact: 'moderate',
    environment: 'stage',
    owners: 'sec@acme.com',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [createdId('grp-new-1'), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([GROUP, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the group that WAS created must still be recorded')
    assert.equal(state[0].name, 'prod-workloads')
    assert.equal(state[0].id, 'grp-new-1')
  } finally {
    restore()
  }
})

test('cloud-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['grp-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('cloud-groups deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createCloudGroup` throws here AFTER the
  // POST succeeded, and `rollbackState.push` only runs on the line below it —
  // so the group now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no group id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the group was in fact created')
  } finally {
    restore()
  }
})

test('cloud-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
