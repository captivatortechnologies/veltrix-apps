// ============================================================================
// deploy for home realm discovery policies, against a fake Microsoft Graph.
//
// An HRD policy decides WHERE a user authenticates: accelerate to a federated
// IdP, allow cloud password validation for a federated domain, skip the
// username-first screen. Applied tenant-wide (isOrganizationDefault) it changes
// sign-in for everyone, so the assertions below are about the exact body sent
// and about which service principals the policy was attached to.
//
// These use `routeFetch` rather than a response queue: the appliesTo resolver
// builds its application and service-principal maps with `Promise.all`, and a
// queue would encode an ordering those parallel listings do not guarantee.
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

const BASE = '/policies/homeRealmDiscoveryPolicies'
/** GET the live policies. */
const LIST = /\/policies\/homeRealmDiscoveryPolicies\?\$select=/
/** POST a new policy. */
const CREATE = /\/policies\/homeRealmDiscoveryPolicies$/
/** GET the policy's current assignments. */
const APPLIES_TO = /\/policies\/homeRealmDiscoveryPolicies\/[^/]+\/appliesTo/
/** PATCH / DELETE one policy. */
const POLICY = /\/policies\/homeRealmDiscoveryPolicies\/[^/?]+$/
/** POST an assignment onto a service principal. */
const ASSIGN = /\/servicePrincipals\/[^/]+\/homeRealmDiscoveryPolicies\/\$ref$/
const APPS = /\/applications\?\$select=id,displayName/
const SPS = /\/servicePrincipals\?\$select=id,displayName/

const SP_ID = '7c1f0a3e-5d92-4b18-9c6a-2f3e8b7d4a15'
const APP_ID = '2b9e4c71-8a35-4f60-b1d7-6c0a9e5f3248'

const DEFINITION = JSON.stringify({
  HomeRealmDiscoveryPolicy: { AccelerateToFederatedDomain: true, PreferredDomain: 'contoso.com' },
})

function hrdItem(fields: Record<string, unknown> = {}) {
  return item('Accelerate Contoso', { name: 'Accelerate Contoso', definition: DEFINITION, ...fields })
}

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'hrd-1',
    displayName: 'Accelerate Contoso',
    definition: [JSON.stringify({ HomeRealmDiscoveryPolicy: { AccelerateToFederatedDomain: false } })],
    isOrganizationDefault: false,
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([hrdItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([hrdItem()], { settings: {} }))

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
    const result = await deploy(deployContext([hrdItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list home realm discovery policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live policies must not create a second one',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a policy that does not exist', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'hrd-new' }) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([hrdItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST' && CREATE.test(c.url))
    assert.ok(post, 'expected a POST creating the policy')
    assert.deepEqual(bodyOf(post), {
      displayName: 'Accelerate Contoso',
      // Graph stores the definition as a single-element string array.
      definition: [DEFINITION],
      // Never the organization default unless the canvas says so: that would
      // redirect sign-in for every user in the tenant.
      isOrganizationDefault: false,
    })
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('the policy becomes the organization default only when the canvas asks for it', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'hrd-new' }) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    await deploy(deployContext([hrdItem({ isOrganizationDefault: true })]))

    const post = writeCalls(calls).find((c) => CREATE.test(c.url))
    assert.equal(bodyOf(post)?.isOrganizationDefault, true)
  } finally {
    restore()
  }
})

test('deploy updates a policy that already exists and records its LIVE prior state', async () => {
  const live = livePolicy()
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([live]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([hrdItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing policy is patched, never duplicated')
    assert.ok(patch.url.endsWith(`${BASE}/hrd-1`))
    assert.deepEqual(bodyOf(patch), {
      displayName: 'Accelerate Contoso',
      definition: [DEFINITION],
      isOrganizationDefault: false,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'hrd-1')
    // The tenant's own definition, not the canvas's.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Accelerate Contoso',
      definition: live.definition,
      isOrganizationDefault: false,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(patch))
  } finally {
    restore()
  }
})

test('a policy that was the organization default has that recorded for rollback', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ isOrganizationDefault: true })]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([hrdItem()]))

    const entries = (result.rollbackData as { entries: Array<{ prior: Record<string, unknown> }> }).entries
    assert.equal(entries[0].prior.isOrganizationDefault, true)
  } finally {
    restore()
  }
})

test('deploy assigns the policy to a declared service principal, by object id', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: SPS, respond: collection([{ id: SP_ID, displayName: 'Contoso Portal' }]) },
    { url: APPS, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'hrd-new' }) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: ASSIGN, method: 'POST', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(deployContext([hrdItem({ appliesTo: ['Contoso Portal'] })]))

    const assign = writeCalls(calls).find((c) => ASSIGN.test(c.url))
    assert.ok(assign, 'expected the policy to be attached to the service principal')
    assert.ok(assign.url.endsWith(`/servicePrincipals/${SP_ID}/homeRealmDiscoveryPolicies/$ref`))
    assert.deepEqual(bodyOf(assign), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/policies/homeRealmDiscoveryPolicies/hrd-new',
    })

    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown[] }> }).entries
    // existed:false is what lets rollback revoke this assignment later.
    assert.deepEqual(entries[0].appliesTo, [{ id: SP_ID, kind: 'servicePrincipal', existed: false }])
  } finally {
    restore()
  }
})

test('an assignment that is already in place is tracked as pre-existing, not re-made', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([{ id: SP_ID, displayName: 'Contoso Portal' }]) },
    { url: APPS, respond: collection([]) },
    {
      url: APPLIES_TO,
      respond: collection([{ id: SP_ID, '@odata.type': '#microsoft.graph.servicePrincipal' }]),
    },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([hrdItem({ appliesTo: [SP_ID] })]))

    assert.equal(writeCalls(calls).filter((c) => ASSIGN.test(c.url)).length, 0)
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown[] }> }).entries
    // existed:true is what stops rollback detaching an assignment made by hand.
    assert.deepEqual(entries[0].appliesTo, [{ id: SP_ID, kind: 'servicePrincipal', existed: true }])
  } finally {
    restore()
  }
})

test('an unresolvable appliesTo name fails the item without assigning anything', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([]) },
    { url: APPS, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([hrdItem({ appliesTo: ['Ghost App'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Ghost App/)
    assert.equal(
      writeCalls(calls).filter((c) => /\$ref/.test(c.url)).length,
      0,
      'assignments must not be half-applied while one target cannot be resolved',
    )
  } finally {
    restore()
  }
})

test('an APPLICATION target is refused — this policy attaches to service principals only', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([]) },
    { url: APPS, respond: collection([{ id: APP_ID, displayName: 'Contoso App Registration' }]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([hrdItem({ appliesTo: ['Contoso App Registration'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Contoso App Registration/)
    assert.equal(
      writeCalls(calls).filter((c) => /\/applications\//.test(c.url)).length,
      0,
      'nothing may be written to an application by this policy type',
    )
  } finally {
    restore()
  }
})

test('an unresolvable target leaves the previously tracked assignments untouched', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([]) },
    { url: APPS, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const tracked = [{ id: SP_ID, kind: 'servicePrincipal', existed: false }]
    const result = await deploy(
      deployContext([hrdItem({ appliesTo: ['Ghost App'] })], {
        priorRollbackData: {
          entries: [{ name: 'Accelerate Contoso', existed: true, id: 'hrd-1', prior: {}, appliesTo: tracked }],
        },
      }),
    )

    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown[] }> }).entries
    assert.deepEqual(entries[0].appliesTo, tracked, 'provenance must survive a failed resolution')
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
      respond: graphError(400, 'Policy definition is not valid JSON.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([hrdItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some home realm discovery policies failed/)
    assert.match(String(result.message), /not valid JSON/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected assignment is reported without losing the policy that was written', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([{ id: SP_ID, displayName: 'Contoso Portal' }]) },
    { url: APPS, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
    {
      url: ASSIGN,
      method: 'POST',
      respond: graphError(400, 'Only one HRD policy can be assigned to a service principal.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([hrdItem({ appliesTo: [SP_ID] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Only one HRD policy can be assigned/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].id, 'hrd-1', 'the policy edit still needs undoing, so it stays in rollbackData')
    assert.deepEqual(entries[0].appliesTo, [], 'an assignment that failed is not recorded as made')
  } finally {
    restore()
  }
})

test('deploy deletes a policy it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: POLICY, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 'hrd-old' },
            { name: 'Pre-existing', existed: true, id: 'hrd-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'a policy that pre-dated this app must survive the reconcile')
    assert.ok(deletes[0].url.endsWith(`${BASE}/hrd-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an item with no name at all is skipped rather than written', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await deploy(deployContext([{ name: '', fields: { definition: DEFINITION } }]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
    assert.ok(vendorCalls(calls).length >= 1)
  } finally {
    restore()
  }
})
