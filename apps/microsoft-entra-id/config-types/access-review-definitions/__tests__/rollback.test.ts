// ============================================================================
// rollback for Entra access review schedule definitions, against a fake
// Microsoft Graph.
//
// The prior state deploy recorded is the live scope, reviewers, fallback
// reviewers AND settings. Restoring anything else leaves the tenant attesting
// to the wrong population, or with a different answer for the users nobody
// reviews — so the PATCH body is asserted byte for byte against the recorded
// prior, and a review this deploy created is deleted rather than patched.
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
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const REVIEWER_USER = '44444444-4444-4444-4444-444444444444'

/** What deploy snapshots off the LIVE definition before it overwrites it. */
const PRIOR = {
  displayName: 'Quarterly Engineering review',
  descriptionForAdmins: 'Old description',
  scope: {
    '@odata.type': '#microsoft.graph.accessReviewQueryScope',
    query: '/groups/old-group-id/transitiveMembers',
    queryType: 'MicrosoftGraph',
  },
  instanceEnumerationScope: null,
  reviewers: [{ query: `/users/${REVIEWER_USER}`, queryType: 'MicrosoftGraph' }],
  fallbackReviewers: [],
  settings: { defaultDecision: 'Approve', autoApplyDecisionsEnabled: false },
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Quarterly Engineering review', existed: false, id: 'def-1' }] },
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

test('rollback restores the LIVE prior scope, reviewers and settings captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: 'Quarterly Engineering review', existed: true, id: 'def-1', prior: PRIOR }],
      }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/identityGovernance/accessReviews/definitions/def-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a review the deploy created and leaves a pre-existing one alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'New review', existed: false, id: 'def-new' },
          { name: 'Quarterly Engineering review', existed: true, id: 'def-1', prior: PRIOR },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/definitions/def-new'))
    assert.equal(writes[1].method, 'PATCH', 'a review that pre-dated this deploy is never deleted')
    assert.ok(writes[1].url.endsWith('/definitions/def-1'))
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a review already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New review', existed: false, id: 'def-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated review with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Quarterly Engineering review', existed: true, id: 'def-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, 'no prior means nothing safe to write')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than deleting something at random', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Never created', existed: false }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: 'Quarterly Engineering review', existed: true, id: 'def-1', prior: PRIOR }],
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore Quarterly Engineering review/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no rollbackData at all', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing to undo means the vendor is never called')
  } finally {
    restore()
  }
})
