// ============================================================================
// rollback for the Entra tenant authorization policy.
//
// The policy is a singleton, so there is nothing to delete — rollback's only
// job is to PATCH back the snapshot deploy captured from the live tenant. Two
// things matter: the body must be the RECORDED prior verbatim (a reconstructed
// "probably it was off" would quietly harden or loosen guest access), and an
// entry with no prior must produce no call at all.
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
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const PATH = '/policies/authorizationPolicy'

/** The snapshot shape deploy records — every managed key, with concrete values. */
const PRIOR = {
  allowInvitesFrom: 'everyone',
  allowedToUseSSPR: true,
  allowUserConsentForRiskyApps: true,
  blockMsolPowerShell: false,
  allowEmailVerifiedUsersToJoinOrganization: true,
  allowedToSignUpEmailBasedSubscriptions: true,
  guestUserRoleId: 'a0b1b346-4d3e-4e8b-98f8-753987be4970',
  defaultUserRolePermissions: {
    allowedToCreateApps: true,
    permissionGrantPoliciesAssigned: ['managePermissionGrantsForSelf.microsoft-user-default-legacy'],
  },
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the LIVE prior snapshot captured at deploy, verbatim', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(PATH))
    // Including the nested consent-policy assignments — restoring the flat
    // fields but dropping defaultUserRolePermissions would leave the tenant
    // half rolled back.
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('an entry with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true }] }))

    assert.equal(writeCalls(calls).length, 0, 'guessing here would rewrite tenant-wide guest and consent settings')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 restored/)
  } finally {
    restore()
  }
})

test('an entry the deploy did not mark as pre-existing is skipped, not deleted', async () => {
  // There is no create/delete for a singleton, so `existed: false` can only be
  // a malformed record — the safe reading is "do nothing".
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: false, prior: PRIOR }] }))

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

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
