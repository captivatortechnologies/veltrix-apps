// ============================================================================
// deploy for Entra token issuance policies, against a fake Microsoft Graph.
//
// A tokenIssuancePolicy decides how SAML tokens are SIGNED and shaped for the
// applications it is assigned to, so the assertions here are about the exact
// definition put on the wire and about WHICH applications end up carrying it.
// Two things must never happen by accident: the policy acquiring an
// `isOrganizationDefault` flag it was never given (that would change token
// issuance tenant-wide), and the assignment set being widened past what the
// canvas declares.
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

/** GET /policies/tokenIssuancePolicies?$select=... — the live policy listing. */
const LIST = /\/policies\/tokenIssuancePolicies\?\$select=/
/** GET /policies/tokenIssuancePolicies/{id}/appliesTo — the policy's current targets. */
const APPLIES_TO = /\/policies\/tokenIssuancePolicies\/[^/]+\/appliesTo/
const CREATE = /\/v1\.0\/policies\/tokenIssuancePolicies$/
const POLICY = /\/v1\.0\/policies\/tokenIssuancePolicies\/[^/?]+$/
const APP_MAP = /\/applications\?\$select=id,displayName/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName/
/** POST /applications/{id}/tokenIssuancePolicies/$ref — assign. */
const ASSIGN = /\/applications\/[^/]+\/tokenIssuancePolicies\/\$ref$/
/** DELETE /applications/{id}/tokenIssuancePolicies/{policyId}/$ref — de-link. */
const UNASSIGN = /\/applications\/[^/]+\/tokenIssuancePolicies\/[^/]+\/\$ref$/

const DEFINITION =
  '{"TokenIssuancePolicy":{"Version":1,"SigningAlgorithm":"http://www.w3.org/2001/04/xmldsig-more#rsa-sha256","TokenResponseSigningPolicy":"TokenOnly"}}'
const OLD_DEFINITION =
  '{"TokenIssuancePolicy":{"Version":1,"SigningAlgorithm":"http://www.w3.org/2000/09/xmldsig#rsa-sha1","TokenResponseSigningPolicy":"TokenOnly"}}'

function livePolicy(over: Record<string, unknown> = {}) {
  return { id: 'p-1', displayName: 'SAML Token Issuance', definition: [DEFINITION], ...over }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('SAML Token Issuance', { name: 'SAML Token Issuance', definition: DEFINITION, ...fields })
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
  // so this must fail closed BEFORE any network call, not half way through.
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
    assert.match(String(result.message), /Failed to list token issuance policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live policies must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the policy with exactly the declared definition', async () => {
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
    // definition is a SINGLE-ELEMENT ARRAY on the wire, not a bare string.
    assert.deepEqual(body, { displayName: 'SAML Token Issuance', definition: [DEFINITION] })
    // Nothing in the canvas can make this the org-wide default: the field is
    // not part of the body at all, so Graph cannot receive it set.
    assert.equal(body && 'isOrganizationDefault' in body, false)

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'p-new')
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('deploy updates a policy that already exists and records its LIVE prior definition', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [OLD_DEFINITION] })]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing policy is updated, not duplicated')
    assert.ok(patch.url.endsWith('/policies/tokenIssuancePolicies/p-1'))
    assert.deepEqual(bodyOf(patch), { displayName: 'SAML Token Issuance', definition: [DEFINITION] })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'p-1')
    // Rollback has to restore the signing algorithm the tenant HAD, not the one
    // the canvas asked for.
    assert.deepEqual(entries[0].prior, {
      displayName: 'SAML Token Issuance',
      definition: [OLD_DEFINITION],
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(patch))
  } finally {
    restore()
  }
})

test('deploy assigns a declared application by $ref and records that IT made the assignment', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: APP_MAP, respond: collection([{ id: 'a-1', displayName: 'Contoso Portal' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: ASSIGN, method: 'POST', respond: NO_CONTENT },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso Portal'] })]))

    const assign = writeCalls(calls).find((c) => c.method === 'POST' && ASSIGN.test(c.url))
    assert.ok(assign, 'expected a POST to /applications/{id}/tokenIssuancePolicies/$ref')
    assert.ok(assign.url.endsWith('/applications/a-1/tokenIssuancePolicies/$ref'))
    assert.deepEqual(bodyOf(assign), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/policies/tokenIssuancePolicies/p-1',
    })

    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'a-1', kind: 'application', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an application already carrying the policy is tracked as pre-existing and not re-assigned', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([{ id: 'a-1', '@odata.type': '#microsoft.graph.application' }]) },
    { url: APP_MAP, respond: collection([{ id: 'a-1', displayName: 'Contoso Portal' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso Portal'] })]))

    assert.equal(
      writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length,
      0,
      'an assignment that already exists must not be written again',
    )
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    // existed:true is what stops rollback revoking an assignment made by hand.
    assert.deepEqual(entries[0].appliesTo, [{ id: 'a-1', kind: 'application', existed: true }])
  } finally {
    restore()
  }
})

test('a service principal is not an allowed target — the rollout is never widened to one', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso Portal' }]) },
    { url: POLICY, method: 'PATCH', respond: ok({}) },
  ])
  try {
    // tokenIssuancePolicy is APPLICATION-only, so a same-named service principal
    // must read as unresolvable rather than silently becoming the target.
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso Portal'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Contoso Portal/)
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
      deployContext([policyItem({ appliesTo: ['Ghost App'] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'SAML Token Issuance',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [{ id: 'a-1', kind: 'application', existed: false }],
            },
          ],
        },
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Ghost App/)
    assert.equal(
      vendorCalls(calls).filter((c) => /\$ref$/.test(c.url)).length,
      0,
      'assignments must not be half-applied while one target cannot be resolved',
    )
    // The tracked set carries forward verbatim, so a later deploy still knows
    // which assignment this app owns.
    const entries = (result.rollbackData as { entries: Array<{ appliesTo: unknown }> }).entries
    assert.deepEqual(entries[0].appliesTo, [{ id: 'a-1', kind: 'application', existed: false }])
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
        { id: 'a-added', '@odata.type': '#microsoft.graph.application' },
        { id: 'a-preexisting', '@odata.type': '#microsoft.graph.application' },
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
              name: 'SAML Token Issuance',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [
                { id: 'a-added', kind: 'application', existed: false },
                { id: 'a-preexisting', kind: 'application', existed: true },
              ],
            },
          ],
        },
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(revokes.length, 1, 'only the assignment this app made may be revoked')
    assert.ok(revokes[0].url.endsWith('/applications/a-added/tokenIssuancePolicies/p-1/$ref'))
    // The trailing /$ref is what keeps this a de-link instead of deleting the
    // application object itself.
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
            { name: 'Retired Issuance', existed: false, id: 'p-old' },
            { name: 'Pre-existing Issuance', existed: true, id: 'p-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a policy this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/policies/tokenIssuancePolicies/p-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
