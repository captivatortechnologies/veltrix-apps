// ============================================================================
// rollback for Entra feature rollout policies, against a fake Microsoft Graph.
//
// Undoing a rollout has to shrink it back to exactly what it was: the live
// prior `isEnabled` / `isAppliedToOrganization` pair is restored verbatim, and
// only the group references THIS deploy added are revoked. A group someone put
// into the rollout by hand must still be there afterwards, and the trailing
// "/$ref" on the DELETE is what keeps a revoke a de-link rather than deleting
// the group object itself.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const PRIOR = { displayName: 'Seamless SSO Rollout', isEnabled: false, isAppliedToOrganization: true }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Seamless SSO Rollout', existed: false, id: 'p-1' }] },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior enablement captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Seamless SSO Rollout', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/policies/featureRolloutPolicies/p-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a rollout the deploy created, without chasing its group references', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'New Rollout', existed: false, id: 'p-new', appliesTo: [{ id: 'g-1', existed: false }] },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the policy takes its references with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/policies/featureRolloutPolicies/p-new'))
    assert.ok(!writes[0].url.includes('$ref'))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback revokes only the group references this deploy added', async () => {
  const { calls, restore } = routeFetch([{ url: /\$ref$/, method: 'DELETE', respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'Seamless SSO Rollout',
            existed: true,
            id: 'p-1',
            prior: PRIOR,
            appliesTo: [
              { id: 'g-added', existed: false },
              { id: 'g-preexisting', existed: true },
            ],
          },
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/policies/featureRolloutPolicies/p-1/appliesTo/g-added/$ref'],
      'a group that pre-dated this deploy must survive the rollback',
    )
    // Without the trailing /$ref this would delete the group, not the reference.
    assert.ok(revokes[0].url.endsWith('/$ref'))
    assert.match(String(result.message), /1 appliesTo group\(s\) revoked/)
  } finally {
    restore()
  }
})

test('a rollout already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'New Rollout', existed: false, id: 'p-new' }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated rollout with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Seamless SSO Rollout', existed: true, id: 'p-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped entirely', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Never Created', existed: false, prior: PRIOR }] }),
    )

    assert.equal(vendorCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Seamless SSO Rollout', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
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
