// ============================================================================
// rollback for Entra token lifetime policies, against a fake Microsoft Graph.
//
// The prior snapshot deploy recorded carries `isOrganizationDefault` alongside
// the definition, so a rollback has to put the tenant-wide default flag back
// exactly as it was — restoring the lifetime but not the flag would leave the
// tenant in a state neither the canvas nor the operator ever chose.
//
// The other rule: an assignment is revoked only when THIS app made it, and the
// trailing "/$ref" is what keeps the revoke a de-link rather than a delete of
// the service principal.
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

const PRIOR = {
  displayName: 'Short Access Tokens',
  definition: ['{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"23:00:00"}}'],
  isOrganizationDefault: true,
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Short Access Tokens', existed: false, id: 'p-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior state, org-default flag included', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Short Access Tokens', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/policies/tokenLifetimePolicies/p-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a policy the deploy created, without chasing its assignments', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'New Lifetime',
            existed: false,
            id: 'p-new',
            appliesTo: [{ id: 'sp-1', kind: 'servicePrincipal', existed: false }],
          },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the policy takes its assignments with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/policies/tokenLifetimePolicies/p-new'))
    assert.ok(!writes[0].url.includes('$ref'))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback revokes only the assignments this deploy made', async () => {
  const { calls, restore } = routeFetch([{ url: /\$ref$/, method: 'DELETE', respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'Short Access Tokens',
            existed: true,
            id: 'p-1',
            prior: PRIOR,
            appliesTo: [
              { id: 'sp-added', kind: 'servicePrincipal', existed: false },
              { id: 'sp-preexisting', kind: 'servicePrincipal', existed: true },
            ],
          },
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/servicePrincipals/sp-added/tokenLifetimePolicies/p-1/$ref'],
      'an assignment that pre-dated this deploy must survive the rollback',
    )
    assert.ok(revokes[0].url.endsWith('/$ref'))
    assert.match(String(result.message), /1 assignment\(s\) removed/)
  } finally {
    restore()
  }
})

test('a policy already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New Lifetime', existed: false, id: 'p-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Short Access Tokens', existed: true, id: 'p-1' }] }),
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
      rollbackContext({ entries: [{ name: 'Short Access Tokens', existed: true, id: 'p-1', prior: PRIOR }] }),
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
