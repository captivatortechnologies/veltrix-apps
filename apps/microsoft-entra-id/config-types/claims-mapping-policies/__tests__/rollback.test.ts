// ============================================================================
// rollback for Entra claims mapping policies, against a fake Microsoft Graph.
//
// Restoring the LIVE prior definition matters more than usual here: the claim
// set is what the relying party authorizes on, so a rollback that re-applied
// the canvas's claims instead of the tenant's would leave applications reading
// a claim set nobody asked for.
//
// The provenance rule is the other half: a claimsMappingPolicy attached to a
// service principal by hand must survive the rollback, and the trailing "/$ref"
// keeps a revoke a de-link rather than a delete of the principal.
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
  displayName: 'Employee ID Claims',
  definition: ['{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"false"}}'],
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Employee ID Claims', existed: false, id: 'p-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior claim set captured at deploy, not the canvas value', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Employee ID Claims', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/policies/claimsMappingPolicies/p-1'))
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
            name: 'New Claims',
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
    assert.ok(writes[0].url.endsWith('/policies/claimsMappingPolicies/p-new'))
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
            name: 'Employee ID Claims',
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
      ['/servicePrincipals/sp-added/claimsMappingPolicies/p-1/$ref'],
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
    const result = await rollback(rollbackContext({ entries: [{ name: 'New Claims', existed: false, id: 'p-new' }] }))

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
      rollbackContext({ entries: [{ name: 'Employee ID Claims', existed: true, id: 'p-1' }] }),
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
      rollbackContext({ entries: [{ name: 'Employee ID Claims', existed: true, id: 'p-1', prior: PRIOR }] }),
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
