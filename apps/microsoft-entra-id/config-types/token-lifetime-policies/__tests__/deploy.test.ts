// ============================================================================
// deploy for Entra token lifetime policies, against a fake Microsoft Graph.
//
// A tokenLifetimePolicy decides how long an issued access/refresh token stays
// valid. Two blast radiuses are worth pinning down on the wire:
//
//   * `isOrganizationDefault` — set by accident, one canvas item silently
//     rewrites token lifetimes for the WHOLE tenant. Every create/update below
//     asserts the exact boolean sent, including that a non-boolean truthy-ish
//     canvas value does NOT become `true`.
//   * the appliesTo set — tokenLifetimePolicy is SERVICE-PRINCIPAL-only, so an
//     application of the same display name must read as unresolvable rather
//     than quietly widening the policy to a target it was never meant for.
//
// These use `routeFetch` rather than a response queue: deploy builds the
// application and service-principal name maps with `Promise.all`, and a queue
// would encode an ordering those parallel listings do not guarantee.
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

const LIST = /\/policies\/tokenLifetimePolicies\?\$select=/
const APPLIES_TO = /\/policies\/tokenLifetimePolicies\/[^/]+\/appliesTo/
const CREATE = /\/v1\.0\/policies\/tokenLifetimePolicies$/
const POLICY = /\/v1\.0\/policies\/tokenLifetimePolicies\/[^/?]+$/
const APP_MAP = /\/applications\?\$select=id,displayName/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName/
/** POST /servicePrincipals/{id}/tokenLifetimePolicies/$ref — assign. */
const ASSIGN = /\/servicePrincipals\/[^/]+\/tokenLifetimePolicies\/\$ref$/
/** DELETE /servicePrincipals/{id}/tokenLifetimePolicies/{policyId}/$ref — de-link. */
const UNASSIGN = /\/servicePrincipals\/[^/]+\/tokenLifetimePolicies\/[^/]+\/\$ref$/

const DEFINITION = '{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"04:00:00"}}'
const OLD_DEFINITION = '{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"23:00:00"}}'

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'Short Access Tokens',
    definition: [DEFINITION],
    isOrganizationDefault: false,
    ...over,
  }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Short Access Tokens', { name: 'Short Access Tokens', definition: DEFINITION, ...fields })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { settings: {} }))

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
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list token lifetime policies/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live policies must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the policy NOT as the organization default', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST' && CREATE.test(c.url))
    assert.ok(post, 'expected a POST creating the policy')

    const body = bodyOf(post)
    assert.deepEqual(body, {
      displayName: 'Short Access Tokens',
      definition: [DEFINITION],
      isOrganizationDefault: false,
    })
    // The default must be explicit and false: a tenant-wide token lifetime
    // change is not something a canvas may acquire by omission.
    assert.equal(body?.isOrganizationDefault, false)

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'p-new')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy sends isOrganizationDefault true only when the canvas explicitly asks for it', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
  ])
  try {
    await deploy(deployContext([policyItem({ isOrganizationDefault: 'true' })]))

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.equal(bodyOf(post)?.isOrganizationDefault, true)
  } finally {
    restore()
  }
})

test('a truthy-looking canvas value that is not a boolean does NOT make the policy the org default', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
  ])
  try {
    await deploy(deployContext([policyItem({ isOrganizationDefault: 'Yes' })]))

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.equal(bodyOf(post)?.isOrganizationDefault, false, 'only true / "true" may set the tenant-wide default')
  } finally {
    restore()
  }
})

test('deploy updates a policy that already exists and records its LIVE prior state', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [OLD_DEFINITION], isOrganizationDefault: true })]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing policy is updated, not duplicated')
    assert.ok(patch.url.endsWith('/policies/tokenLifetimePolicies/p-1'))
    assert.deepEqual(bodyOf(patch), {
      displayName: 'Short Access Tokens',
      definition: [DEFINITION],
      isOrganizationDefault: false,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // Rollback has to restore the lifetime AND the org-default flag the tenant
    // HAD, not what the canvas asked for.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Short Access Tokens',
      definition: [OLD_DEFINITION],
      isOrganizationDefault: true,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(patch))
  } finally {
    restore()
  }
})

test('deploy assigns a declared service principal by $ref and records that IT made the assignment', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso API' }]) },
    { url: ASSIGN, method: 'POST', respond: NO_CONTENT },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso API'] })]))

    const assign = writeCalls(calls).find((c) => c.method === 'POST' && ASSIGN.test(c.url))
    assert.ok(assign, 'expected a POST to /servicePrincipals/{id}/tokenLifetimePolicies/$ref')
    assert.ok(assign.url.endsWith('/servicePrincipals/sp-1/tokenLifetimePolicies/$ref'))
    assert.deepEqual(bodyOf(assign), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/policies/tokenLifetimePolicies/p-1',
    })

    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'sp-1', kind: 'servicePrincipal', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a service principal already carrying the policy is tracked as pre-existing and not re-assigned', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([{ id: 'sp-1', '@odata.type': '#microsoft.graph.servicePrincipal' }]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso API' }]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso API'] })]))

    assert.equal(
      writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length,
      0,
      'an assignment that already exists must not be written again',
    )
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'sp-1', kind: 'servicePrincipal', existed: true }])
  } finally {
    restore()
  }
})

test('an application is not an allowed target — the policy is never widened to one', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: APP_MAP, respond: collection([{ id: 'a-1', displayName: 'Contoso API' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso API'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Contoso API/)
    assert.equal(writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length, 0)
  } finally {
    restore()
  }
})

test('an unresolvable appliesTo name leaves the assignment set completely untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([policyItem({ appliesTo: ['Ghost API'] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'Short Access Tokens',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [{ id: 'sp-1', kind: 'servicePrincipal', existed: false }],
            },
          ],
        },
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Ghost API/)
    assert.equal(
      vendorCalls(calls).filter((c) => /\$ref$/.test(c.url)).length,
      0,
      'assignments must not be half-applied while one target cannot be resolved',
    )
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'sp-1', kind: 'servicePrincipal', existed: false }])
  } finally {
    restore()
  }
})

test('deploy revokes an assignment it added and leaves a pre-existing one alone', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    {
      url: APPLIES_TO,
      respond: collection([
        { id: 'sp-added', '@odata.type': '#microsoft.graph.servicePrincipal' },
        { id: 'sp-preexisting', '@odata.type': '#microsoft.graph.servicePrincipal' },
      ]),
    },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: UNASSIGN, method: 'DELETE', respond: NO_CONTENT },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([policyItem({ appliesTo: [] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'Short Access Tokens',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [
                { id: 'sp-added', kind: 'servicePrincipal', existed: false },
                { id: 'sp-preexisting', kind: 'servicePrincipal', existed: true },
              ],
            },
          ],
        },
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(revokes.length, 1, 'only the assignment this app made may be revoked')
    assert.ok(revokes[0].url.endsWith('/servicePrincipals/sp-added/tokenLifetimePolicies/p-1/$ref'))
    // The trailing /$ref keeps this a de-link, not a delete of the principal.
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
      respond: graphError(400, 'Another object with the same value for property displayName already exists.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /same value for property displayName/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a policy it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: POLICY, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Lifetime', existed: false, id: 'p-old' },
            { name: 'Pre-existing Lifetime', existed: true, id: 'p-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a policy this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/policies/tokenLifetimePolicies/p-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
