// ============================================================================
// deploy for Entra app management policies, against a fake Microsoft Graph.
//
// An appManagementPolicy restricts what secrets and certificates an application
// may carry — how long a password credential may live, whether one may be added
// at all. Two things therefore have to be exact on the wire: `isEnabled`, the
// switch that decides whether the restrictions are enforced or merely recorded,
// and the `restrictions` object itself, which is the policy.
//
// The other half of this handler is assignment. A policy only bites where it is
// assigned, so `appliesTo` is reconciled with provenance: an assignment THIS app
// made is removed again when the canvas drops it, one that was already there is
// left alone.
//
// These use `routeFetch`: deploy builds the application/service-principal target
// maps with `Promise.all`, which a response queue would falsely order.
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

/** GET /policies/appManagementPolicies/{id}/appliesTo — current assignments. */
const APPLIES_TO = /\/policies\/appManagementPolicies\/[^/]+\/appliesTo/
/** GET /policies/appManagementPolicies?$select=… — the live listing. */
const LIST = /\/policies\/appManagementPolicies\?\$select=/
/** PATCH or DELETE /policies/appManagementPolicies/{id}. */
const BY_ID = /\/policies\/appManagementPolicies\/[^/?]+$/
/** POST /policies/appManagementPolicies. */
const CREATE = /\/v1\.0\/policies\/appManagementPolicies$/
/** POST/DELETE {targetBase}/{id}/appManagementPolicies[/{policyId}]/$ref. */
const ASSIGN = /\/(applications|servicePrincipals)\/[^/]+\/appManagementPolicies/
const APP_MAP = /\/applications\?\$select=id,displayName$/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName$/

/** A minimal, realistic appManagementConfiguration. */
const RESTRICTIONS = { passwordCredentials: [{ restrictionType: 'passwordAddition', state: 'enabled' }] }

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'No app passwords',
    description: 'Block password credentials',
    isEnabled: true,
    restrictions: RESTRICTIONS,
    ...over,
  }
}

function policyItem(fields: Record<string, unknown> = {}, id?: string) {
  return item('No app passwords', { name: 'No app passwords', ...fields }, id)
}

type Entries = Array<Record<string, unknown>>
const entriesOf = (result: { rollbackData?: unknown }): Entries =>
  (result.rollbackData as { entries: Entries }).entries

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
  // Client credentials has no token endpoint without the directory (tenant) id.
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
    assert.match(String(result.message), /Failed to list app management policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see live policies must not create a duplicate one',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the policy with the declared restrictions', async () => {
  const { calls, restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([
        policyItem({
          description: 'Block password credentials',
          isEnabled: true,
          restrictions: JSON.stringify(RESTRICTIONS),
        }),
      ]),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the policy')
    assert.ok(post.url.endsWith('/policies/appManagementPolicies'))
    assert.deepEqual(bodyOf(post), {
      displayName: 'No app passwords',
      description: 'Block password credentials',
      isEnabled: true,
      restrictions: RESTRICTIONS,
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'p-new')
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a policy the canvas does not enable is created disabled, and restrictions default to none', async () => {
  const { calls, restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'p-new' }) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    await deploy(deployContext([policyItem()]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    // isEnabled is the enforcement switch — it must never default to on.
    assert.equal(body.isEnabled, false)
    assert.deepEqual(body.restrictions, {}, 'an undeclared restrictions object is empty, not undefined')
    assert.equal(body.description, null)
  } finally {
    restore()
  }
})

test('deploy updates an existing policy and records its LIVE prior state', async () => {
  const { calls, restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ isEnabled: false })]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing policy is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/policies/appManagementPolicies/p-1'))

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    // Rollback has to restore what the tenant HAD, not what the canvas wanted.
    assert.deepEqual(entries[0].prior, {
      displayName: 'No app passwords',
      description: 'Block password credentials',
      isEnabled: true,
      restrictions: RESTRICTIONS,
    })
    assert.notDeepEqual(bodyOf(writes[0]), entries[0].prior)
    assert.equal(bodyOf(writes[0])?.isEnabled, false)
  } finally {
    restore()
  }
})

test('deploy assigns the policy to a declared application and records that IT assigned it', async () => {
  const { calls, restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: ASSIGN, method: 'POST', respond: NO_CONTENT },
    { url: APP_MAP, respond: collection([{ id: 'app-1', displayName: 'Contoso API' }]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso API'] })]))

    const assign = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(assign, 'expected a POST assigning the policy')
    // The assignment is written on the TARGET, referencing the policy.
    assert.ok(assign.url.endsWith('/applications/app-1/appManagementPolicies/$ref'))
    assert.deepEqual(bodyOf(assign), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/policies/appManagementPolicies/p-1',
    })

    assert.deepEqual(entriesOf(result)[0].appliesTo, [{ id: 'app-1', kind: 'application', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an assignment that already exists is tracked as pre-existing and not written again', async () => {
  const { calls, restore } = routeFetch([
    {
      url: APPLIES_TO,
      respond: collection([{ id: 'app-1', '@odata.type': '#microsoft.graph.application' }]),
    },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: APP_MAP, respond: collection([{ id: 'app-1', displayName: 'Contoso API' }]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Contoso API'] })]))

    assert.equal(writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length, 0)
    // existed:true is what stops rollback unassigning a policy it never assigned.
    assert.deepEqual(entriesOf(result)[0].appliesTo, [{ id: 'app-1', kind: 'application', existed: true }])
  } finally {
    restore()
  }
})

test('deploy unassigns only the target IT assigned once the canvas drops it', async () => {
  const { calls, restore } = routeFetch([
    {
      url: APPLIES_TO,
      respond: collection([
        { id: 'app-assigned', '@odata.type': '#microsoft.graph.application' },
        { id: 'sp-preexisting', '@odata.type': '#microsoft.graph.servicePrincipal' },
      ]),
    },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: ASSIGN, method: 'DELETE', respond: NO_CONTENT },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    await deploy(
      deployContext([policyItem({}, 'ci-1')], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'ci-1',
              name: 'No app passwords',
              existed: true,
              id: 'p-1',
              prior: {},
              appliesTo: [
                { id: 'app-assigned', kind: 'application', existed: false },
                { id: 'sp-preexisting', kind: 'servicePrincipal', existed: true },
              ],
            },
          ],
        },
      }),
    )

    const unassigns = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(unassigns.length, 1, 'an assignment made by hand must survive')
    // The trailing /$ref removes the assignment, not the application itself.
    assert.ok(unassigns[0].url.endsWith('/applications/app-assigned/appManagementPolicies/p-1/$ref'))
  } finally {
    restore()
  }
})

test('an unresolvable appliesTo target fails the item and leaves assignments untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ appliesTo: ['Ghost App'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown appliesTo target\(s\) Ghost App/)
    assert.equal(
      vendorCalls(calls).filter((c) => /appliesTo|\$ref/.test(c.url)).length,
      0,
      'assignment must not be half-applied while one target is unknown',
    )
    assert.deepEqual(entriesOf(result)[0].appliesTo, [])
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    {
      url: CREATE,
      method: 'POST',
      respond: graphError(400, 'The restrictions property contains an unsupported restrictionType.', 'Request_BadRequest'),
    },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unsupported restrictionType/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a policy it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: BY_ID, method: 'DELETE', respond: NO_CONTENT },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired policy', existed: false, id: 'p-old' },
            { name: 'Adopted policy', existed: true, id: 'p-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a policy this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/policies/appManagementPolicies/p-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
