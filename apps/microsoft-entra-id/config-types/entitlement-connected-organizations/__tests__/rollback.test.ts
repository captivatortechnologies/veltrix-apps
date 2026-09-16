// ============================================================================
// rollback for Entra entitlement-management connected organizations, against a
// fake Microsoft Graph.
//
// A connected organization is an outside company's users being allowed to
// request access from this directory, so what rollback puts back has to be the
// live `state` and `identitySources` deploy read off Graph — not the canvas the
// deploy was trying to apply, and not a guess when nothing was recorded.
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

/** What deploy snapshots off the LIVE organization before it overwrites it. */
const PRIOR = {
  displayName: 'Contoso',
  description: 'Old description',
  state: 'proposed',
  identitySources: [{ '@odata.type': '#microsoft.graph.domainIdentitySource', domainName: 'old.example' }],
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Contoso', existed: false, id: 'org-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the LIVE prior fields captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Contoso', existed: true, id: 'org-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(
      graphCalls[0].url.endsWith('/identityGovernance/entitlementManagement/connectedOrganizations/org-1'),
    )
    // Including the "proposed" state and the original identity source — putting
    // back "configured" would leave the partner able to request access.
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes an organization the deploy created and leaves a pre-existing one alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'New partner', existed: false, id: 'org-new' },
          { name: 'Contoso', existed: true, id: 'org-1', prior: PRIOR },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/connectedOrganizations/org-new'))
    assert.equal(writes[1].method, 'PATCH', 'an organization that pre-dated this deploy is never deleted')
    assert.ok(writes[1].url.endsWith('/connectedOrganizations/org-1'))
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('an organization already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New partner', existed: false, id: 'org-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated organization with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Contoso', existed: true, id: 'org-1' }] }))

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
      rollbackContext({ entries: [{ name: 'Contoso', existed: true, id: 'org-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore Contoso/)
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
