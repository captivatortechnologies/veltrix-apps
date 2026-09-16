// ============================================================================
// rollback for Entra authentication strength policies, against a fake Graph.
//
// Restoring a strength takes two calls, because Graph splits it that way: the
// metadata through PATCH and the allowed combinations through their own action.
// Only the second one puts the tenant's original MFA bar back, so a rollback
// that stopped after the PATCH would report success while leaving the weakened
// (or tightened) combination list in force.
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
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const BASE = '/policies/authenticationStrengthPolicies'

/** What deploy read off the live strength before overwriting it. */
const PRIOR = {
  displayName: 'Phishing-resistant MFA',
  description: 'Hardware-backed factors only',
  allowedCombinations: ['fido2', 'password,microsoftAuthenticatorPush'],
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: PRIOR }] },
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

test('rollback refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: PRIOR }] },
        { settings: {} },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the prior metadata AND the prior allowed combinations', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)

    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/s-1`))
    assert.deepEqual(bodyOf(graphCalls[0]), {
      displayName: 'Phishing-resistant MFA',
      description: 'Hardware-backed factors only',
    })

    // The combination list is the actual security control — this is the call
    // that puts the tenant's original bar back.
    assert.equal(graphCalls[1].method, 'POST')
    assert.ok(graphCalls[1].url.endsWith(`${BASE}/s-1/updateAllowedCombinations`))
    assert.deepEqual(bodyOf(graphCalls[1]), { allowedCombinations: PRIOR.allowedCombinations })

    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a prior with a null description restores it as null, not as the string "null"', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, NO_CONTENT])
  try {
    await rollback(
      rollbackContext({
        entries: [
          { name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: { ...PRIOR, description: null } },
        ],
      }),
    )

    assert.equal(bodyOf(writeCalls(calls)[0])?.description, null)
  } finally {
    restore()
  }
})

test('a prior with no recorded combinations does not issue the combinations action', async () => {
  // An empty list is not a meaningful strength — sending it would be inventing
  // a bar the tenant never had.
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: { ...PRIOR, allowedCombinations: [] } },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback deletes a strength the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: false, id: 's-new' }] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/s-new`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a strength already gone (404) is treated as already undone, not as an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: false, id: 's-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a 404 on the restore PATCH is likewise not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound(), NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an updated strength with no recorded prior state is left alone, never guessed at', async () => {
  // Inventing a combination list here is the one thing rollback must never do:
  // the wrong guess rewrites the MFA bar for every policy that references it.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped — rollback never invents a target', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: false }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing at all when the deploy recorded no rollbackData', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /restore Phishing-resistant MFA: .*Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected combinations action is reported even though the metadata PATCH succeeded', async () => {
  // The half-restored state is the dangerous one: the name is back but the bar
  // is not, so the failure must not be swallowed by the earlier success.
  const { restore } = recordFetch([TOKEN, NO_CONTENT, graphError(400, 'Invalid combination.', 'Request_BadRequest')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Invalid combination/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
