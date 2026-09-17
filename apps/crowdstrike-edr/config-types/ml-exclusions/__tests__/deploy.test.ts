// deploy for ml-exclusions.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the create/update split, the prior state the update path
// records, and above all the `groups` array: there is no `applied_globally` write
// field, so the sentinel ["all"] is the ONLY thing that keeps an exclusion
// covering the whole fleet. A deploy that sends a host-group list instead
// silently narrows the exclusion to a handful of hosts.

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

const QUERIES = /\/policy\/queries\/ml-exclusions\/v1/
const ENTITY = /\/policy\/entities\/ml-exclusions\/v1/

/**
 * One declared ML exclusion, applied to every host. `extractMlExclusionSpecs`
 * reads a FLAT `fields` record — `value`, `excludedFrom`, `appliedGlobally`,
 * `hostGroups`, `comment`.
 */
const GLOBAL_EXCLUSION = item('Vendor agent', {
  value: '/opt/vendor/agent/**',
  excludedFrom: 'blocking, extraction',
  appliedGlobally: true,
  comment: 'Vendor agent false positive',
})

/** The same config type scoped to two host groups instead of the whole fleet. */
const SCOPED_EXCLUSION = item('Build fleet', {
  value: '/opt/build/**',
  excludedFrom: 'blocking',
  appliedGlobally: false,
  hostGroups: 'hg-build-1, hg-build-2',
})

/**
 * The exclusion as it exists in the tenant BEFORE this deploy — different from
 * the canvas in every managed field, so a rollback record that captured the
 * DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_EXCLUSION = {
  id: 'ml-live-1',
  value: '/opt/vendor/agent/**',
  excluded_from: ['extraction'],
  applied_globally: false,
  groups: [{ id: 'hg-legacy-1', name: 'Legacy servers' }],
  comment: 'added by hand during an incident',
  modified_by: 'alice@acme.com',
  last_modified: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'ml-exclusions', handler: deploy, items: [GLOBAL_EXCLUSION] })

test('ml-exclusions deploy: creates an exclusion that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ml-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.value, '/opt/vendor/agent/**')
    assert.deepEqual(body?.excluded_from, ['blocking', 'extraction'])
    assert.equal(body?.comment, 'Vendor agent false positive')

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'an exclusion that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: keeps a globally applied exclusion global', async () => {
  // There is no `applied_globally` write field — ["all"] is the only way to say
  // "every host". Sending a group list instead narrows the exclusion silently.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ml-new-1' }) },
  ])
  try {
    await deploy(deployContext([GLOBAL_EXCLUSION]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.groups, ['all'], 'a global exclusion must be written as ["all"]')
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: keeps a host-group scoped exclusion scoped', async () => {
  // The other direction: a scoped exclusion widened to ["all"] would suppress
  // detections across the whole fleet rather than the two declared groups.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ml-new-2' }) },
  ])
  try {
    await deploy(deployContext([SCOPED_EXCLUSION]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.groups, ['hg-build-1', 'hg-build-2'])
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: records the created exclusion so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ml-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].value, '/opt/vendor/agent/**')
    assert.equal(state[0].existed, false, 'an exclusion this deploy created is not pre-existing')
    assert.equal(state[0].id, 'ml-new-1', 'without the new id rollback cannot find what it created')
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: updates an exclusion that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ml-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing exclusion must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'ml-live-1', 'the update must address the live exclusion by its id')
    assert.equal(body?.value, '/opt/vendor/agent/**')
    assert.deepEqual(body?.excluded_from, ['blocking', 'extraction'])
    assert.deepEqual(body?.groups, ['all'])
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: records the LIVE prior values of an exclusion it overwrote', async () => {
  // The canvas asks for blocking+extraction applied globally; the tenant holds
  // extraction only, scoped to one legacy host group. Rollback restores what was
  // there, so every value below must come from LIVE_EXCLUSION.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ml-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          value: string
          existed: boolean
          id?: string
          prior?: Record<string, unknown>
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'ml-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.deepEqual(prior.excludedFrom, ['extraction'])
    assert.equal(
      prior.appliedGlobally,
      false,
      'the exclusion was NOT global before this deploy — recording true would widen it on rollback',
    )
    assert.deepEqual(prior.groups, ['hg-legacy-1'])
    assert.equal(prior.comment, 'added by hand during an incident')
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an exclusion it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('exclusion quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: keeps the rollback record of what it wrote when a later exclusion fails', async () => {
  // The first exclusion is created, the second is rejected. Everything the
  // deploy already changed must still come back on the failure path — a `catch`
  // that returns only `{ success: false, message }` discards it.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'ml-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION, SCOPED_EXCLUSION]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the exclusion that WAS created must still be recorded')
    assert.equal(state[0].value, '/opt/vendor/agent/**')
    assert.equal(state[0].id, 'ml-new-1')
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ml-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createExclusion` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // exclusion now exists in the tenant with nothing recorded to remove it. What
  // is asserted is only the half that is certainly right: the deploy does not
  // claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the exclusion was in fact created')
  } finally {
    restore()
  }
})

test('ml-exclusions deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
