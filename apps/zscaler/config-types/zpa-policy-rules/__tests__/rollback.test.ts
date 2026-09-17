// rollback for zpa-policy-rules.
//
// This is the one config type of the four that cannot use
// `registerRollbackGuardContract`: a PolicyRuleRollbackEntry is keyed by
// `ruleId` + `policySetId` + `policyType`, not the contract's flat `id`, so the
// contract's fixture drives the handler into resolving a policy set for
// `policyType: undefined` — one GET that has nothing to do with the rule the
// guard is about. The six guards are therefore written here against type-correct
// entries; nothing is weakened (see the report).
//
// Otherwise specific here: the CRUD path is keyed by the policy set id, which
// rollback prefers from the entry and re-resolves from the stored policy type
// only when it was never recorded.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY_CREDENTIAL,
  NO_CONTENT,
  TOKEN,
  ZPA_CUSTOMER_ID,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  resourceWrites,
  rollbackContext,
  routeFetch,
  settingsWithoutCustomerId,
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'

const POLICY_SET_ID = '216196257331370370'

const UPDATED_ENTRY = {
  name: 'Allow Finance to ERP',
  policyType: 'ACCESS_POLICY',
  policySetId: POLICY_SET_ID,
  existed: true,
  ruleId: '216196257331370700',
  prior: {
    name: 'Allow Finance to ERP',
    description: 'live description set by hand',
    action: 'DENY',
    conditions: [{ operator: 'OR', operands: [{ objectType: 'APP', lhs: 'id', rhs: '999999999' }] }],
  },
}

const CREATED_ENTRY = {
  name: 'Allow HR to Workday',
  policyType: 'ACCESS_POLICY',
  policySetId: POLICY_SET_ID,
  existed: false,
  ruleId: '216196257331371001',
}

// --- the shared guards, written out because the contract's entry shape differs -

test('zpa-policy-rules rollback: refuses without a credential, without calling Zscaler', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0, 'must not reach Zscaler without a credential')
    assert.match(String(result.message), /No Zscaler OneAPI credential available/)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: refuses a credential with no secret, without calling Zscaler', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ previousState: [CREATED_ENTRY] }, { credential: EMPTY_CREDENTIAL }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0, 'must not reach Zscaler with an unusable credential')
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: reports there is nothing to undo when deploy recorded nothing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, false)
    assert.match(String(result.message), /No previous state available for rollback/)
    assert.equal(calls.length, 0, 'nothing recorded means nothing to call')
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: reports there is nothing to undo for an empty recording', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ previousState: [] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /No previous state available for rollback/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: makes no call for a created entry whose rule id was never captured', async () => {
  // Deploy created the rule but never recorded its id. There is no safe DELETE to
  // issue, and guessing one would delete somebody else's rule.
  const { calls, restore } = routeFetch([], zpaList([]))
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'Allow HR to Workday', policyType: 'ACCESS_POLICY', policySetId: POLICY_SET_ID, existed: false }],
      }),
    )

    assert.equal(
      resourceCalls(calls).length,
      0,
      `expected no resource call, got ${resourceCalls(calls)
        .map((x) => `${x.method} ${x.url}`)
        .join(', ')}`,
    )
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live rule but recorded no prior body. Restoring an invented
  // default here is strictly worse than leaving the rule alone.
  const { calls, restore } = routeFetch([], zpaList([]))
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'Allow Finance to ERP',
            policyType: 'ACCESS_POLICY',
            policySetId: POLICY_SET_ID,
            existed: true,
            ruleId: '216196257331370700',
          },
        ],
      }),
    )

    assert.equal(
      resourceWrites(calls).length,
      0,
      `expected no resource write, got ${resourceWrites(calls)
        .map((x) => `${x.method} ${x.url}`)
        .join(', ')}`,
    )
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: makes no call without a ZPA customer id', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ previousState: [CREATED_ENTRY] }, { settings: settingsWithoutCustomerId() }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})

// --- what is specific to policy rules -----------------------------------------

test('zpa-policy-rules rollback: restores the prior body of a rule deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant.length, 1, 'the set id was recorded — nothing needs re-resolving')
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(
      tenant[0].url.includes(
        `/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/policySet/${POLICY_SET_ID}/rule/216196257331370700`,
      ),
      `restore hit ${tenant[0].url}`,
    )

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370700', 'the replace-style PUT must echo the id back')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.action, 'DENY', 'the recorded prior action, not a default')
    assert.equal(body?.policySetId, POLICY_SET_ID)
    assert.equal(body?.operator, 'AND')
    assert.deepEqual(body?.conditions, UPDATED_ENTRY.prior.conditions, 'the prior operands go back verbatim')

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: deletes a rule deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes(`/policySet/${POLICY_SET_ID}/rule/216196257331371001`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: re-resolves the policy set when the entry never recorded one', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: POLICY_SET_ID }), NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        previousState: [{ ...CREATED_ENTRY, policySetId: '' }],
      }),
    )

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.ok(tenant[0].url.includes('/policySet/policyType/ACCESS_POLICY'), `lookup hit ${tenant[0].url}`)
    assert.equal(tenant[1].method, 'DELETE')
    assert.ok(tenant[1].url.includes(`/policySet/${POLICY_SET_ID}/rule/216196257331371001`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: a rule already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-policy-rules rollback: a rule ZPA refuses to delete is reported, not thrown', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaError(400, 'rule is referenced by an active policy and cannot be deleted'),
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /referenced by an active policy/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
