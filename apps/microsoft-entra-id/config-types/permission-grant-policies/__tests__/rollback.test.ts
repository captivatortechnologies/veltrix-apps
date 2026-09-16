// ============================================================================
// rollback for Entra permission grant policies, against a fake Microsoft Graph.
//
// The metadata is the easy half. The half that matters is the condition sets:
// restoring the policy's NAME while leaving a widened `includes` in place would
// look like a successful rollback and leave every user in the tenant still able
// to consent to whatever the failed deploy opened up. So the assertions below
// follow the recorded prior sets all the way onto the wire — the live sets torn
// down by id, and the captured ones posted back verbatim.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  graphError,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const POLICY_ID = 'contoso-low-risk'

const INCLUDES = /\/policies\/permissionGrantPolicies\/[^/]+\/includes/
const EXCLUDES = /\/policies\/permissionGrantPolicies\/[^/]+\/excludes/
const BY_ID = /\/policies\/permissionGrantPolicies\/[^/?]+$/

/** The narrow set the tenant had before the deploy widened it. */
const LOW_RISK = {
  permissionType: 'delegated',
  permissionClassification: 'low',
  clientApplicationsFromVerifiedPublisherOnly: true,
}

const PRIOR = {
  displayName: 'Contoso low risk',
  description: 'Self-service low-risk consent',
  includes: [LOW_RISK],
  excludes: [],
}

function updated(over: Record<string, unknown> = {}) {
  return { name: POLICY_ID, existed: true, id: POLICY_ID, prior: PRIOR, ...over }
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }, { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the prior metadata and re-posts the prior condition sets verbatim', async () => {
  const { calls, restore } = routeFetch([
    // What the failed deploy left live: consent to ANY classification.
    {
      url: INCLUDES,
      method: 'GET',
      respond: collection([{ id: 'cs-wide', permissionType: 'delegated', permissionClassification: 'all' }]),
    },
    { url: INCLUDES, method: 'DELETE', respond: NO_CONTENT },
    { url: INCLUDES, method: 'POST', respond: created({ id: 'cs-restored' }) },
    { url: EXCLUDES, method: 'GET', respond: collection([]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const writes = writeCalls(graphCalls)

    const patch = writes.find((c) => c.method === 'PATCH')
    assert.ok(patch)
    assert.ok(patch.url.endsWith(`/policies/permissionGrantPolicies/${POLICY_ID}`))
    assert.deepEqual(bodyOf(patch), {
      displayName: 'Contoso low risk',
      description: 'Self-service low-risk consent',
    })

    const del = writes.find((c) => c.method === 'DELETE')
    assert.ok(del, 'the widened set the deploy left behind has to be torn down')
    assert.ok(del.url.endsWith(`/policies/permissionGrantPolicies/${POLICY_ID}/includes/cs-wide`))

    const post = writes.find((c) => c.method === 'POST')
    assert.ok(post)
    assert.deepEqual(bodyOf(post), LOW_RISK, 'the tenant gets back exactly the set it had')

    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a policy the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'contoso-new', existed: false, id: 'contoso-new' }] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the policy takes its condition sets with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/policies/permissionGrantPolicies/contoso-new'))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a policy the tenant already had is restored, never deleted', async () => {
  const { calls, restore } = routeFetch([
    { url: INCLUDES, method: 'GET', respond: collection([]) },
    { url: INCLUDES, method: 'POST', respond: created({ id: 'cs-restored' }) },
    { url: EXCLUDES, method: 'GET', respond: collection([]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(
      writeCalls(calls).some((c) => c.method === 'DELETE' && BY_ID.test(c.url)),
      false,
      'a pre-existing consent policy must survive its rollback',
    )
  } finally {
    restore()
  }
})

test('a policy already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'contoso-new', existed: false, id: 'contoso-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: BY_ID, method: 'PATCH', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: POLICY_ID, existed: true, id: POLICY_ID }] }))

    assert.equal(writeCalls(calls).length, 0, 'inventing a condition set here would itself widen consent')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than addressed blindly', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: POLICY_ID, existed: false }] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})
