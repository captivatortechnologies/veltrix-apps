// deploy for cloud-kac-policies.
//
// The Admission Control Policy API is multi-step: the id query is a CONTAINS
// match (`name:~`), so the identity has to be pinned client-side against the
// fetched entities; create accepts only name + description; and enablement — the
// field that decides whether the policy admits or blocks anything — is always a
// second PATCH. Every assertion below is about one of those three.

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

const QUERIES = /\/admission-control-policies\/queries\/policies\/v1/
const ENTITY = /\/admission-control-policies\/entities\/policies\/v1/

/**
 * One declared KAC policy. `extractKacPolicySpecs` reads a FLAT `fields` record
 * — `name`, `description`, `enabled`, `defaultAction`, a comma/newline separated
 * `hostGroups` and a `ruleGroups` JSON string.
 */
const POLICY = item('Cluster admission', {
  name: 'Cluster admission',
  description: 'Block unsigned images at admission',
  enabled: true,
  defaultAction: 'Prevent',
  hostGroups: 'hg-1, hg-2',
  ruleGroups: '[{"name":"Baseline"}]',
})

/**
 * The policy as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every field deploy writes, so a rollback record
 * that captured the DESIRED values instead of the LIVE ones fails here.
 */
const LIVE_POLICY = {
  id: 'kac-live-1',
  name: 'Cluster admission',
  description: 'legacy description nobody updated',
  is_enabled: false,
  host_groups: ['hg-legacy'],
  rule_groups: [],
}

registerDeployGuardContract({ label: 'cloud-kac-policies', handler: deploy, items: [POLICY] })

test('cloud-kac-policies deploy: creates a policy that does not exist yet, then converges its enablement', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'kac-new-1' }) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    // Create accepts only name + description — enablement is the follow-up PATCH.
    assert.deepEqual(bodyOf(posts[0]), {
      name: 'Cluster admission',
      description: 'Block unsigned images at admission',
    })

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one converge, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=kac-new-1/, 'the converge must address the new policy by id')
    assert.equal(bodyOf(patches[0])?.is_enabled, true, 'a created policy is left disabled without this')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: records the created policy BEFORE converging it', async () => {
  // The converge is a second write. If the record were pushed after it, a
  // rejected converge would leave a policy in the tenant with nothing to delete
  // it by.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'kac-new-1' }) },
    { url: ENTITY, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'Cluster admission')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'kac-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: updates a policy that already exists, addressing it by id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['kac-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing policy must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=kac-live-1/, 'the id travels in the ids query, not the body')
    const body = bodyOf(patches[0])
    assert.equal(body?.name, 'Cluster admission')
    assert.equal(body?.description, 'Block unsigned images at admission')
    assert.equal(body?.is_enabled, true)
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: records the LIVE prior values of a policy it overwrote', async () => {
  // The canvas asks for an enabled policy with the new description; the tenant
  // holds a disabled one with the legacy description. Rollback restores what was
  // there, not what was wanted.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['kac-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'kac-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.name, 'Cluster admission')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false)
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: does not adopt a policy whose name merely CONTAINS the declared one', async () => {
  // The id query is a contains match, so the staging policy comes back for a
  // search on "Cluster admission". Converging it would enable somebody else's
  // admission policy against production clusters.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['kac-other-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'kac-other-1', name: 'Cluster admission (staging)' }]),
    },
    { url: ENTITY, method: 'POST', respond: created({ id: 'kac-new-1' }) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'a near-miss policy must be created fresh')
    for (const call of writeCalls(calls)) {
      assert.equal(
        call.url.includes('kac-other-1'),
        false,
        `a differently-named policy was written to: ${call.method} ${call.url}`,
      )
    }
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: refuses a malformed rule groups payload without touching the tenant', async () => {
  // The rule groups are parsed before the first request, so a canvas that cannot
  // be turned into a policy never reaches the customer's tenant at all.
  const malformed = item('Cluster admission', {
    name: 'Cluster admission',
    enabled: true,
    ruleGroups: '[{"name":"Baseline"',
  })
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([malformed]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid rule groups/)
    assert.equal(calls.length, 0, 'an unparseable canvas means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: an unreadable search fails the deploy without writing', async () => {
  // A 500 on the id query is "I could not tell whether this policy exists".
  // Treating it as absent would create a second admission policy for the same
  // clusters.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: serverError() }])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
    assert.match(String(result.message), /Failed to search KAC policy/)
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy that was never enabled as deployed, and the
  // operator believes their clusters are gated.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['kac-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('policy is locked by another operation') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /locked/)
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: a create that returns no policy id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createKacPolicy` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // policy now exists in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no policy id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the policy was in fact created')
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: keeps the rollback record of what it wrote when a later policy fails', async () => {
  const SECOND = item('Staging admission', { name: 'Staging admission', enabled: false })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'kac-new-1' }), forbidden('access denied, authorization failed')],
    },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the policy that WAS created must still be recorded')
    assert.equal(state[0].id, 'kac-new-1')
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['kac-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('cloud-kac-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
