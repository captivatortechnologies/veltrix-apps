// ============================================================================
// deploy for Entra claims mapping policies, against a fake Microsoft Graph.
//
// A claimsMappingPolicy decides WHICH CLAIMS an application receives in its
// token — the claim set is an authorization input for the relying party, so the
// assertions here are about the exact definition put on the wire and about
// which service principals end up carrying it. claimsMappingPolicy is
// SERVICE-PRINCIPAL-only, so an application of the same display name must read
// as unresolvable rather than quietly becoming a target.
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

const LIST = /\/policies\/claimsMappingPolicies\?\$select=/
const APPLIES_TO = /\/policies\/claimsMappingPolicies\/[^/]+\/appliesTo/
const CREATE = /\/v1\.0\/policies\/claimsMappingPolicies$/
const POLICY = /\/v1\.0\/policies\/claimsMappingPolicies\/[^/?]+$/
const APP_MAP = /\/applications\?\$select=id,displayName/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName/
/** POST /servicePrincipals/{id}/claimsMappingPolicies/$ref — assign. */
const ASSIGN = /\/servicePrincipals\/[^/]+\/claimsMappingPolicies\/\$ref$/
/** DELETE /servicePrincipals/{id}/claimsMappingPolicies/{policyId}/$ref — de-link. */
const UNASSIGN = /\/servicePrincipals\/[^/]+\/claimsMappingPolicies\/[^/]+\/\$ref$/

/** Emits the employee id as a claim, and nothing else beyond the basic set. */
const DEFINITION =
  '{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"true","ClaimsSchema":[{"Source":"user","ID":"employeeid","JwtClaimType":"employeeid"}]}}'
/** The claim set the tenant had before: group ids instead of the employee id. */
const OLD_DEFINITION =
  '{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"false","ClaimsSchema":[{"Source":"user","ID":"onpremisessamaccountname","JwtClaimType":"samaccountname"}]}}'

function livePolicy(over: Record<string, unknown> = {}) {
  return { id: 'p-1', displayName: 'Employee ID Claims', definition: [DEFINITION], ...over }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Employee ID Claims', { name: 'Employee ID Claims', definition: DEFINITION, ...fields })
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
  // Client-credentials has no token endpoint without the directory (tenant) id.
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
    assert.match(String(result.message), /Failed to list claims mapping policies/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live policies must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the policy with exactly the declared claim set', async () => {
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
    // definition is a SINGLE-ELEMENT ARRAY on the wire, not a bare string, and
    // the claim schema must arrive verbatim — a mangled ClaimsSchema silently
    // changes what the relying party authorizes on.
    assert.deepEqual(body, { displayName: 'Employee ID Claims', definition: [DEFINITION] })
    // claimsMappingPolicy also has an isOrganizationDefault; this app never
    // sends it, so a canvas cannot make one the tenant-wide default.
    assert.equal(body && 'isOrganizationDefault' in body, false)

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'p-new')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy updates a policy that already exists and records its LIVE prior claim set', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [OLD_DEFINITION] })]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing policy is updated, not duplicated')
    assert.ok(patch.url.endsWith('/policies/claimsMappingPolicies/p-1'))
    assert.deepEqual(bodyOf(patch), { displayName: 'Employee ID Claims', definition: [DEFINITION] })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'p-1')
    // Rollback has to restore the claim set the tenant HAD, not the canvas's.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Employee ID Claims',
      definition: [OLD_DEFINITION],
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
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso HR' }]) },
    { url: ASSIGN, method: 'POST', respond: NO_CONTENT },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso HR'] })]))

    const assign = writeCalls(calls).find((c) => c.method === 'POST' && ASSIGN.test(c.url))
    assert.ok(assign, 'expected a POST to /servicePrincipals/{id}/claimsMappingPolicies/$ref')
    assert.ok(assign.url.endsWith('/servicePrincipals/sp-1/claimsMappingPolicies/$ref'))
    assert.deepEqual(bodyOf(assign), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/policies/claimsMappingPolicies/p-1',
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
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso HR' }]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso HR'] })]))

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

test('an application is not an allowed target — the claim set is never widened to one', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: APP_MAP, respond: collection([{ id: 'a-1', displayName: 'Contoso HR' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso HR'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Contoso HR/)
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
      deployContext([policyItem({ appliesTo: ['Ghost HR'] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'Employee ID Claims',
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
    assert.match(String(result.message), /unknown appliesTo target\(s\) Ghost HR/)
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
              name: 'Employee ID Claims',
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
    assert.ok(revokes[0].url.endsWith('/servicePrincipals/sp-added/claimsMappingPolicies/p-1/$ref'))
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
      respond: graphError(400, 'Property ClaimsSchema is invalid in the claims mapping policy definition.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /ClaimsSchema is invalid/)
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
            { name: 'Retired Claims', existed: false, id: 'p-old' },
            { name: 'Pre-existing Claims', existed: true, id: 'p-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a policy this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/policies/claimsMappingPolicies/p-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
