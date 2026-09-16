// ============================================================================
// rollback for PIM role activation policies.
//
// These rules decide what an admin must do to activate a privileged role — MFA,
// justification, approval, how long the activation lasts. Rules are never
// created or deleted, only edited, so rollback is always a PATCH of the bodies
// deploy captured, addressed by the policy id it resolved at the time.
//
// The failure that matters is a rollback that writes something it did not
// capture: restoring a rule with no recorded prior would weaken an activation
// requirement on a privileged role, which is the exact direction this config
// type exists to control.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  recordFetch,
  resource,
  rollbackContext,
  TOKEN,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const POLICY_ID = 'DirectoryRole_7b2f0c11_policy'
const ROLE = '62e90394-69f5-4237-9190-012177145e10' // Global Administrator

const ENABLEMENT = 'Enablement_EndUser_Assignment'
const EXPIRATION = 'Expiration_EndUser_Assignment'

/** What deploy records: the rule bodies as they were before it wrote. */
const ENTRY = {
  name: ROLE,
  existed: true,
  policyId: POLICY_ID,
  priorRules: {
    [ENABLEMENT]: {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule',
      id: ENABLEMENT,
      enabledRules: ['MultiFactorAuthentication', 'Justification'],
    },
    [EXPIRATION]: {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
      id: EXPIRATION,
      isExpirationRequired: true,
      maximumDuration: 'PT4H',
    },
  },
}

const rulePath = (ruleId: string) => `/policies/roleManagementPolicies/${POLICY_ID}/rules/${ruleId}`

test('refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('restores every captured rule body by PATCH', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({}), resource({})])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(result.success, true)
    const graph = assertAuthenticatedFirst(assert, calls)
    assert.equal(graph.length, 2)
    assert.deepEqual(
      graph.map((c) => c.method),
      ['PATCH', 'PATCH'],
      'a rule is edited in place — it is never created or deleted',
    )
    assert.deepEqual(
      graph.map((c) => c.url.replace(/^https:\/\/[^/]+\/v1\.0/, '')),
      [rulePath(ENABLEMENT), rulePath(EXPIRATION)],
    )
  } finally {
    restore()
  }
})

test('restores the captured body verbatim, @odata.type included', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({}), resource({})])
  try {
    await rollback(rollbackContext({ entries: [ENTRY] }))

    // Graph rejects a rule PATCH without the subtype discriminator, so dropping
    // it would turn every rollback into a 400.
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), ENTRY.priorRules[ENABLEMENT])
    assert.deepEqual(bodyOf(writeCalls(calls)[1]), ENTRY.priorRules[EXPIRATION])
  } finally {
    restore()
  }
})

test('addresses the policy id deploy resolved, never the role id', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({}), resource({})])
  try {
    await rollback(rollbackContext({ entries: [ENTRY] }))

    // The policy id is not the role id, and re-resolving it here would make the
    // rollback depend on a lookup that may now answer differently.
    for (const call of vendorCalls(calls)) {
      assert.equal(call.url.includes(POLICY_ID), true)
      assert.equal(call.url.includes(ROLE), false)
    }
  } finally {
    restore()
  }
})

test('does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: [] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('does nothing when there is no rollbackData at all', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an entry with no captured rules is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    // Writing a plausible default here would relax an activation requirement on
    // a privileged role. Leaving it is visible; weakening it silently is not.
    const result = await rollback(
      rollbackContext({ entries: [{ name: ROLE, existed: true, policyId: POLICY_ID }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an entry with no policy id is skipped rather than written to a blank path', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: ROLE, existed: true, priorRules: ENTRY.priorRules }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an entry deploy marked as not pre-existing is skipped', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: [{ ...ENTRY, existed: false }] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a rejected restore is reported as a failed result naming the rule', async () => {
  const { restore } = recordFetch([TOKEN, resource({}), graphError(403, 'Insufficient privileges.')])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(result.success, false)
    assert.match(result.message, new RegExp(EXPIRATION))
    assert.match(result.message, /Insufficient privileges/)
  } finally {
    restore()
  }
})

test('one rejected rule does not stop the others being restored', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(400, 'Bad rule'), resource({})])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(result.success, false)
    // A partial restore that stopped at the first failure would leave the rest
    // of this role's rules holding the deployed values with no record of why.
    assert.equal(writeCalls(calls).length, 2)
  } finally {
    restore()
  }
})

test('several roles are each restored', async () => {
  const OTHER_POLICY = 'DirectoryRole_44ab1e90_policy'
  const { calls, restore } = recordFetch([TOKEN, resource({}), resource({}), resource({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          ENTRY,
          {
            name: '194ae4cb-b126-40b2-bd5b-6091b380977d',
            existed: true,
            policyId: OTHER_POLICY,
            priorRules: { [ENABLEMENT]: { id: ENABLEMENT, enabledRules: [] } },
          },
        ],
      }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 3)
    assert.equal(writeCalls(calls)[2].url.includes(OTHER_POLICY), true)
  } finally {
    restore()
  }
})

test('neither the token nor the client secret reaches the result', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.'), resource({})])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
