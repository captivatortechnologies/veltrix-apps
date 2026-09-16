// ============================================================================
// deploy for Entra permission grant policies, against a fake Microsoft Graph.
//
// A permission grant policy is the rule that decides what an ordinary user may
// consent to on their own. Its `includes` condition sets are the allow-list —
// widen one and every user in the tenant can hand an unverified app delegated
// access without an administrator ever seeing it. So the assertions here pin the
// exact condition sets that go on the wire, and the exact ones recorded for
// rollback.
//
// The other rule with teeth: ids beginning `microsoft-` are Microsoft's own
// built-in policies. This handler filters them out before it does anything, and
// the test below proves a canvas that names one produces no write at all.
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
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

/** Anything under /policies/permissionGrantPolicies/{id}/includes. */
const INCLUDES = /\/policies\/permissionGrantPolicies\/[^/]+\/includes/
/** Anything under /policies/permissionGrantPolicies/{id}/excludes. */
const EXCLUDES = /\/policies\/permissionGrantPolicies\/[^/]+\/excludes/
const LIST = /\/policies\/permissionGrantPolicies\?\$select=/
/** PATCH or DELETE /policies/permissionGrantPolicies/{id}. */
const BY_ID = /\/policies\/permissionGrantPolicies\/[^/?]+$/
const CREATE = /\/v1\.0\/policies\/permissionGrantPolicies$/

const POLICY_ID = 'contoso-low-risk'

/** One permissionGrantConditionSet — the unit of "what may be consented to". */
const LOW_RISK = {
  permissionType: 'delegated',
  permissionClassification: 'low',
  clientApplicationsFromVerifiedPublisherOnly: true,
}

function livePolicy(over: Record<string, unknown> = {}) {
  return { id: POLICY_ID, displayName: 'Contoso low risk', description: 'Self-service low-risk consent', ...over }
}

function policyItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Contoso low risk',
    { id: POLICY_ID, displayName: 'Contoso low risk', description: 'Self-service low-risk consent', ...fields },
    id,
  )
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
    assert.match(String(result.message), /Failed to list permission grant policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live policies must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first, creates the policy and posts exactly the declared condition sets', async () => {
  const { calls, restore } = routeFetch([
    { url: INCLUDES, method: 'GET', respond: collection([]) },
    { url: INCLUDES, method: 'POST', respond: created({ id: 'cs-new' }) },
    { url: EXCLUDES, method: 'GET', respond: collection([]) },
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: POLICY_ID }) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ includes: JSON.stringify([LOW_RISK]) })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const createCall = graphCalls.find((c) => c.method === 'POST' && c.url.endsWith('/policies/permissionGrantPolicies'))
    assert.ok(createCall, 'expected a POST creating the policy')
    // The client supplies the id — it is the policy's identity, not a server key.
    assert.deepEqual(bodyOf(createCall), {
      id: POLICY_ID,
      displayName: 'Contoso low risk',
      description: 'Self-service low-risk consent',
    })

    const setCall = graphCalls.find((c) => c.method === 'POST' && /\/includes$/.test(c.url))
    assert.ok(setCall, 'expected the include condition set to be posted')
    assert.ok(setCall.url.endsWith(`/policies/permissionGrantPolicies/${POLICY_ID}/includes`))
    // This is the allow-list itself — nothing may be added to or dropped from it.
    assert.deepEqual(bodyOf(setCall), LOW_RISK)

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.deepEqual(entries, [{ itemId: undefined, name: POLICY_ID, existed: false, id: POLICY_ID }])
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a built-in microsoft- policy is filtered out before anything is written', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await deploy(
      deployContext([
        policyItem({ id: 'microsoft-user-default-legacy', displayName: 'Legacy user consent' }),
      ]),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /Deployed 0 permission grant policy\(ies\)/)
    assert.equal(
      writeCalls(calls).length,
      0,
      "Microsoft's own consent policies are reserved — this app must never touch one",
    )
  } finally {
    restore()
  }
})

test('deploy updates an existing policy and records its LIVE prior metadata and condition sets', async () => {
  const liveSet = { id: 'cs-1', ...LOW_RISK }
  const { calls, restore } = routeFetch([
    { url: INCLUDES, method: 'GET', respond: collection([liveSet]) },
    { url: EXCLUDES, method: 'GET', respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([
        policyItem({ displayName: 'Contoso low risk (revised)', includes: JSON.stringify([LOW_RISK]) }),
      ]),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'condition sets that already match must not be torn down and rebuilt')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`/policies/permissionGrantPolicies/${POLICY_ID}`))
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'Contoso low risk (revised)',
      description: 'Self-service low-risk consent',
    })

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    // The prior is the tenant's own state, with the server-assigned id stripped
    // so the recorded set can be POSTed back verbatim on rollback.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Contoso low risk',
      description: 'Self-service low-risk consent',
      includes: [LOW_RISK],
      excludes: [],
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
  } finally {
    restore()
  }
})

test('a changed allow-list replaces the live condition sets, deleting each by id', async () => {
  const liveSet = { id: 'cs-1', permissionType: 'delegated', permissionClassification: 'all' }
  const { calls, restore } = routeFetch([
    { url: INCLUDES, method: 'GET', respond: collection([liveSet]) },
    { url: INCLUDES, method: 'DELETE', respond: NO_CONTENT },
    { url: INCLUDES, method: 'POST', respond: created({ id: 'cs-new' }) },
    { url: EXCLUDES, method: 'GET', respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([policyItem({ includes: JSON.stringify([LOW_RISK]) })]))

    const del = writeCalls(calls).find((c) => c.method === 'DELETE')
    assert.ok(del, 'the superseded condition set has to be removed')
    assert.ok(del.url.endsWith(`/policies/permissionGrantPolicies/${POLICY_ID}/includes/cs-1`))

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(post)
    assert.deepEqual(bodyOf(post), LOW_RISK, 'the narrower set replaces the "all classifications" one')

    // The prior keeps the WIDE live set, so rollback puts the tenant back as it was.
    assert.deepEqual((entriesOf(result)[0].prior as { includes: unknown }).includes, [
      { permissionType: 'delegated', permissionClassification: 'all' },
    ])
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
      respond: graphError(400, 'A permission grant policy with the specified id already exists.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a policy it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: BY_ID, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'contoso-retired', existed: false, id: 'contoso-retired' },
            { name: 'contoso-adopted', existed: true, id: 'contoso-adopted', prior: { includes: [], excludes: [] } },
            // A reserved id can only be here through a corrupted record; the
            // guard has to hold on the delete path too.
            { name: 'microsoft-user-default-legacy', existed: false, id: 'microsoft-user-default-legacy' },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      deletes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/policies/permissionGrantPolicies/contoso-retired'],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
