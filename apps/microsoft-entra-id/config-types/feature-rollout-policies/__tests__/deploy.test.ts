// ============================================================================
// deploy for Entra feature rollout policies, against a fake Microsoft Graph.
//
// A featureRolloutPolicy switches an authentication feature (seamless SSO,
// pass-through auth, password hash sync...) on for a set of directory objects.
// Everything worth asserting here is about the SIZE of that set:
//
//   * `isAppliedToOrganization` turns a targeted pilot into a tenant-wide
//     change with one boolean, so every write asserts the exact value sent —
//     including that a truthy-looking non-boolean canvas value stays false;
//   * the appliesTo `$ref` set only ever gains the groups the canvas declares,
//     and only ever loses references THIS app added — the trailing "/$ref" on
//     the DELETE is what keeps that a de-link rather than deleting the group.
//
// `feature` is immutable after creation: it belongs in the POST body and must
// not appear in the PATCH body, which is asserted below.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const LIST = /\/policies\/featureRolloutPolicies\?\$select=/
/** GET {base}/{id}/appliesTo?$select=id — the policy's current group references. */
const APPLIES_TO_LIST = /\/policies\/featureRolloutPolicies\/[^/]+\/appliesTo\?\$select=id$/
/** POST {base}/{id}/appliesTo/$ref — add a group. */
const APPLIES_TO_ADD = /\/policies\/featureRolloutPolicies\/[^/]+\/appliesTo\/\$ref$/
/** DELETE {base}/{id}/appliesTo/{groupId}/$ref — de-link a group. */
const APPLIES_TO_DEL = /\/policies\/featureRolloutPolicies\/[^/]+\/appliesTo\/[^/]+\/\$ref$/
const CREATE = /\/v1\.0\/policies\/featureRolloutPolicies$/
const POLICY = /\/v1\.0\/policies\/featureRolloutPolicies\/[^/?]+$/
const GROUP_MAP = /\/groups\?\$select=id,displayName/

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'Seamless SSO Rollout',
    feature: 'seamlessSso',
    isEnabled: true,
    isAppliedToOrganization: false,
    ...over,
  }
}

function rolloutItem(fields: Record<string, unknown> = {}) {
  return item('Seamless SSO Rollout', {
    name: 'Seamless SSO Rollout',
    feature: 'seamlessSso',
    isEnabled: true,
    ...fields,
  })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([rolloutItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([rolloutItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed policy listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([rolloutItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list feature rollout policies/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live policies must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a rollout that is NOT applied org-wide', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
  ])
  try {
    const result = await deploy(deployContext([rolloutItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST' && CREATE.test(c.url))
    assert.ok(post, 'expected a POST creating the policy')

    // The immutable `feature` belongs in the create body, and the rollout is
    // scoped to nobody until a group is declared — never the whole tenant.
    assert.deepEqual(bodyOf(post), {
      displayName: 'Seamless SSO Rollout',
      feature: 'seamlessSso',
      isEnabled: true,
      isAppliedToOrganization: false,
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'p-new')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy applies a rollout org-wide only when the canvas explicitly asks', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
  ])
  try {
    await deploy(deployContext([rolloutItem({ isAppliedToOrganization: 'true' })]))

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.equal(bodyOf(post)?.isAppliedToOrganization, true)
  } finally {
    restore()
  }
})

test('a truthy-looking canvas value that is not a boolean does NOT widen the rollout tenant-wide', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
  ])
  try {
    await deploy(deployContext([rolloutItem({ isAppliedToOrganization: 'Yes' })]))

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.equal(
      bodyOf(post)?.isAppliedToOrganization,
      false,
      'only true / "true" may switch a feature on for the whole directory',
    )
  } finally {
    restore()
  }
})

test('deploy updates an existing rollout without resending the immutable feature', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ isEnabled: false, isAppliedToOrganization: true })]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([rolloutItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing policy is updated, not duplicated')
    assert.ok(patch.url.endsWith('/policies/featureRolloutPolicies/p-1'))
    const body = bodyOf(patch)
    assert.deepEqual(body, {
      displayName: 'Seamless SSO Rollout',
      isEnabled: true,
      isAppliedToOrganization: false,
    })
    assert.equal(body && 'feature' in body, false, 'feature is immutable — a PATCH must not carry it')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // Rollback has to restore the tenant's own enablement + org-wide flag.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Seamless SSO Rollout',
      isEnabled: false,
      isAppliedToOrganization: true,
    })
    assert.notDeepEqual(entries[0].prior, body)
  } finally {
    restore()
  }
})

test('deploy adds a declared group by $ref and records that IT added it', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
    { url: GROUP_MAP, respond: collection([{ id: 'g-1', displayName: 'SSO Pilot' }]) },
    { url: APPLIES_TO_ADD, method: 'POST', respond: NO_CONTENT },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([rolloutItem({ appliesTo: ['SSO Pilot'] })]))

    const add = writeCalls(calls).find((c) => c.method === 'POST' && APPLIES_TO_ADD.test(c.url))
    assert.ok(add, 'expected a POST to {policy}/appliesTo/$ref')
    assert.ok(add.url.endsWith('/policies/featureRolloutPolicies/p-1/appliesTo/$ref'))
    assert.deepEqual(bodyOf(add), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/g-1',
    })

    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'g-1', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a group already in the rollout is tracked as pre-existing and not re-added', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO_LIST, respond: collection([{ id: 'g-1' }]) },
    { url: GROUP_MAP, respond: collection([{ id: 'g-1', displayName: 'SSO Pilot' }]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([rolloutItem({ appliesTo: ['SSO Pilot'] })]))

    assert.equal(
      writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length,
      0,
      'a reference that already exists must not be written again',
    )
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    // existed:true is what stops rollback revoking a group someone added by hand.
    assert.deepEqual(entries[0].appliesTo, [{ id: 'g-1', existed: true }])
  } finally {
    restore()
  }
})

test('an unresolvable group name leaves the rollout audience completely untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([rolloutItem({ appliesTo: ['Ghost Group'] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'Seamless SSO Rollout',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [{ id: 'g-1', existed: false }],
            },
          ],
        },
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo group\(s\) Ghost Group/)
    assert.equal(
      vendorCalls(calls).filter((c) => /appliesTo/.test(c.url)).length,
      0,
      'the audience must not be half-applied while one group cannot be resolved',
    )
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'g-1', existed: false }])
  } finally {
    restore()
  }
})

test('deploy revokes a group reference it added and leaves a pre-existing one alone', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO_LIST, respond: collection([{ id: 'g-added' }, { id: 'g-preexisting' }]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: APPLIES_TO_DEL, method: 'DELETE', respond: NO_CONTENT },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([rolloutItem({ appliesTo: [] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'Seamless SSO Rollout',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [
                { id: 'g-added', existed: false },
                { id: 'g-preexisting', existed: true },
              ],
            },
          ],
        },
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(revokes.length, 1, 'only the reference this app added may be revoked')
    assert.ok(revokes[0].url.endsWith('/policies/featureRolloutPolicies/p-1/appliesTo/g-added/$ref'))
    // Without the trailing /$ref this would delete the GROUP, not the reference.
    assert.ok(revokes[0].url.endsWith('/$ref'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    {
      url: CREATE,
      method: 'POST',
      respond: graphError(400, 'A feature rollout policy for this feature already exists.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([rolloutItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a rollout it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: POLICY, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Rollout', existed: false, id: 'p-old' },
            { name: 'Pre-existing Rollout', existed: true, id: 'p-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a rollout this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/policies/featureRolloutPolicies/p-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
