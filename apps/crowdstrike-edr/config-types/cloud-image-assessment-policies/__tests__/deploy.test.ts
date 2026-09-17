// deploy for cloud-image-assessment-policies.
//
// The container-security collection has no query endpoint, so identity is pinned
// client-side against a full listing, the id travels in an `id=` (singular)
// query param, and every policy takes TWO writes: a create that accepts only
// name + description, then a PATCH that converges the action, the conditions and
// the enablement. The second write is the one that decides whether an image is
// allowed into a cluster, so it is what most of these assertions are about.

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
  ok,
  partialFailure,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/container-security\/entities\/image-assessment-policies\/v1/

/**
 * One declared policy. `extractImagePolicySpecs` reads a FLAT `fields` record —
 * `name`, `description`, `action`, `enabled` and a `rules` JSON string holding
 * the threshold conditions.
 */
const POLICY = item('Registry gate', {
  name: 'Registry gate',
  description: 'Block critical CVEs at admission',
  action: 'prevent',
  enabled: true,
  rules: '[{"prop":"severity","value":"critical"}]',
})

/**
 * The policy as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_POLICY = {
  id: 'pol-live-1',
  name: 'Registry gate',
  description: 'legacy description nobody updated',
  is_enabled: false,
  policy_data: {
    rules: [{ action: 'alert', policy_rules_data: { conditions: [{ prop: 'severity', value: 'high' }] } }],
  },
}

registerDeployGuardContract({
  label: 'cloud-image-assessment-policies',
  handler: deploy,
  items: [POLICY],
})

test('cloud-image-assessment-policies deploy: creates a policy that does not exist yet, then converges it', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    // The create endpoint accepts only name + description — the rest is the PATCH.
    assert.deepEqual(bodyOf(posts[0]), {
      name: 'Registry gate',
      description: 'Block critical CVEs at admission',
    })

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one converge, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /[?&]id=pol-new-1/, 'the converge must address the new policy by id')
    const body = bodyOf(patches[0]) as { policy_data?: { rules?: Array<Record<string, unknown>> } }
    assert.equal((body as Record<string, unknown>).is_enabled, true)
    assert.equal(body.policy_data?.rules?.[0]?.action, 'prevent')
    assert.deepEqual(
      (body.policy_data?.rules?.[0]?.policy_rules_data as { conditions?: unknown })?.conditions,
      [{ prop: 'severity', value: 'critical' }],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: records the created policy BEFORE converging it', async () => {
  // The converge is a second write. If the record were pushed after it, a
  // rejected converge would leave a policy in the tenant with nothing to delete
  // it by — and an image assessment policy left half-applied gates admission.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
    { url: ENTITY, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'Registry gate')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'pol-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: updates a policy that already exists, addressing it by id', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing policy must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /[?&]id=pol-live-1/, 'the update must address the live policy by its id')
    const body = bodyOf(patches[0]) as { policy_data?: { rules?: Array<Record<string, unknown>> } }
    assert.equal((body as Record<string, unknown>).is_enabled, true)
    assert.equal(body.policy_data?.rules?.[0]?.action, 'prevent')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: records the LIVE prior values of a policy it overwrote', async () => {
  // The canvas asks for an enabled "prevent" policy with a critical threshold;
  // the tenant holds a disabled "alert" policy with a high threshold and the
  // legacy description. Rollback restores what was there, not what was wanted.
  const { restore } = routeFetch([
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
    assert.equal(state[0].id, 'pol-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.name, 'Registry gate')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.is_enabled, false)
    assert.deepEqual(prior.policy_data, LIVE_POLICY.policy_data)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: does not adopt a policy whose name merely resembles the declared one', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([{ ...LIVE_POLICY, name: 'Registry gate (staging)' }]) },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'a near-miss policy must be created fresh')
    for (const call of callsOfMethod(calls, 'PATCH')) {
      assert.equal(
        call.url.includes('pol-live-1'),
        false,
        `a differently-named policy was converged: ${call.url}`,
      )
    }
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: refuses a malformed rules payload without touching the tenant', async () => {
  // The conditions are parsed before the first request, so a canvas that cannot
  // be turned into a policy body never reaches the customer's tenant at all.
  const malformed = item('Registry gate', {
    name: 'Registry gate',
    action: 'prevent',
    enabled: true,
    rules: '[{"prop":"severity"',
  })
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([malformed]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid rules/)
    assert.equal(calls.length, 0, 'an unparseable canvas means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: an unreadable listing fails the deploy without writing', async () => {
  // A 500 listing the policies is "I could not tell whether this policy exists".
  // Treating it as absent would create a duplicate gate on the same registry.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
    assert.match(String(result.message), /Failed to search policy/)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
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

test('cloud-image-assessment-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy whose thresholds never applied as deployed —
  // and the operator believes critical images are being blocked.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_POLICY]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('policy is managed by a policy group') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /policy group/)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: a create that returns no policy id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): deploy throws here AFTER the POST succeeded
  // and BEFORE `rollbackState.push` — so the policy now exists in the tenant
  // with nothing recorded to delete it. What is asserted is only the half that
  // is certainly right: the deploy does not claim success.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
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

test('cloud-image-assessment-policies deploy: keeps the rollback record of what it wrote when a later policy fails', async () => {
  const SECOND = item('Staging gate', { name: 'Staging gate', action: 'alert', enabled: true })
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'pol-new-1' }), forbidden('access denied, authorization failed')],
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
    assert.equal(state[0].id, 'pol-new-1')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
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

test('cloud-image-assessment-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
