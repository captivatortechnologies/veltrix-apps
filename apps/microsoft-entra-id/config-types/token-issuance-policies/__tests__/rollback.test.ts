// ============================================================================
// rollback for Entra token issuance policies, against a fake Microsoft Graph.
//
// Two rules carry the weight here. The policy body is restored from the LIVE
// prior snapshot deploy captured, so a rollback puts the tenant's own signing
// definition back rather than the canvas's. And an assignment is revoked only
// when THIS app made it — a tokenIssuancePolicy attached to an application by
// hand must survive a rollback, and the trailing "/$ref" is what keeps the
// revoke a de-link instead of a delete of the application object.
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
  displayName: 'SAML Token Issuance',
  definition: ['{"TokenIssuancePolicy":{"Version":1,"SigningAlgorithm":"http://www.w3.org/2000/09/xmldsig#rsa-sha1"}}'],
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'SAML Token Issuance', existed: false, id: 'p-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior definition captured at deploy, not the canvas value', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'SAML Token Issuance', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/policies/tokenIssuancePolicies/p-1'))
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
            name: 'New Issuance',
            existed: false,
            id: 'p-new',
            appliesTo: [{ id: 'a-1', kind: 'application', existed: false }],
          },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the policy takes its assignments with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/policies/tokenIssuancePolicies/p-new'))
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
            name: 'SAML Token Issuance',
            existed: true,
            id: 'p-1',
            prior: PRIOR,
            appliesTo: [
              { id: 'a-added', kind: 'application', existed: false },
              { id: 'a-preexisting', kind: 'application', existed: true },
            ],
          },
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/applications/a-added/tokenIssuancePolicies/p-1/$ref'],
      'an assignment that pre-dated this deploy must survive the rollback',
    )
    // The trailing /$ref keeps this a de-link, not a delete of the application.
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
      rollbackContext({ entries: [{ name: 'New Issuance', existed: false, id: 'p-new' }] }),
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
      rollbackContext({ entries: [{ name: 'SAML Token Issuance', existed: true, id: 'p-1' }] }),
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

    assert.equal(vendorCalls(calls).length, 0, 'there is nothing to address without an id')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'SAML Token Issuance', existed: true, id: 'p-1', prior: PRIOR }] }),
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
