// deploy for zpa-policy-rules.
//
// Specific to this config type: ZPA models policy as one policy SET per policy
// type, so every write is preceded by TWO reads — `GET /policySet/policyType/
// {type}` for the set id, then that set's rules to match by name. Identity is
// the (policy_type, name) PAIR, and the CRUD path is keyed by the resolved set
// id, so a test that does not pin the set id in the URL proves nothing. The
// catch-all DEFAULT rule of a set is protected and must never be written.
//
// The authored `conditions_json` is the ZPA operand DSL and is passed through as
// the parsed array — this config type resolves no names into operand ids, so
// there is no reference-resolution path to exercise here.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  TOKEN,
  ZPA_CUSTOMER_ID,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  ok,
  recordFetch,
  resourceCalls,
  resourceWrites,
  routeFetch,
  serverError,
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const POLICY_SET_ID = '216196257331370370'

const CONDITIONS = [
  { operator: 'OR', operands: [{ objectType: 'APP', lhs: 'id', rhs: '216196257331370500' }] },
  { operator: 'OR', operands: [{ objectType: 'SCIM_GROUP', lhs: 'idp-1', rhs: 'Finance' }] },
]

const RULE = item('Allow Finance to ERP', {
  name: 'Allow Finance to ERP',
  policy_type: 'ACCESS_POLICY',
  description: 'desired description',
  action: 'ALLOW',
  rule_order: 2,
  conditions_json: JSON.stringify(CONDITIONS),
})

/** The live rule, deliberately unlike the canvas in action, text and operands. */
const LIVE = {
  id: '216196257331370700',
  name: 'Allow Finance to ERP',
  description: 'live description set by hand',
  action: 'DENY',
  policySetId: POLICY_SET_ID,
  operator: 'AND',
  conditions: [{ operator: 'OR', operands: [{ objectType: 'APP', lhs: 'id', rhs: '999999999' }] }],
}

registerDeployGuardContract({ label: 'zpa-policy-rules', handler: deploy, product: 'zpa', items: [RULE] })

test('zpa-policy-rules deploy: resolves the policy set, then creates a rule that does not exist', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID, name: 'Global_Policy_Set' }),
    zpaList([{ id: '1', name: 'Some Other Rule' }]),
    created({ id: '216196257331371001', name: 'Allow Finance to ERP' }),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.ok(
      tenant[0].url.includes(
        `/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/policySet/policyType/ACCESS_POLICY`,
      ),
      `policy set lookup hit ${tenant[0].url}`,
    )
    assert.equal(tenant[1].method, 'GET')
    assert.ok(
      tenant[1].url.includes(`/policySet/rules/policyType/ACCESS_POLICY`),
      `rule listing hit ${tenant[1].url}`,
    )
    assert.equal(tenant[2].method, 'POST')
    assert.ok(
      tenant[2].url.includes(
        `/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/policySet/${POLICY_SET_ID}/rule`,
      ),
      `create hit ${tenant[2].url} — the CRUD path is keyed by the RESOLVED set id`,
    )

    const body = bodyOf(tenant[2])
    assert.equal(body?.name, 'Allow Finance to ERP')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.action, 'ALLOW')
    assert.equal(body?.policySetId, POLICY_SET_ID)
    assert.equal(body?.operator, 'AND')
    assert.deepEqual(body?.conditions, CONDITIONS, 'the authored operand DSL is sent as a parsed array')
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      {
        name: 'Allow Finance to ERP',
        policyType: 'ACCESS_POLICY',
        policySetId: POLICY_SET_ID,
        existed: false,
        ruleId: '216196257331371001',
      },
    ])
    assert.deepEqual(rollback.createdIds, ['216196257331371001'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: records the created rule even when the API returns no id', async () => {
  // The POST succeeded, so the rule is live in the policy set and ZPA is already
  // evaluating it. The id check that follows used to throw BEFORE the rollback
  // entry was pushed, so the deploy reported "failed, nothing to undo" about an
  // access rule it had just created.
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID, name: 'Global_Policy_Set' }),
    zpaList([]),
    created({ name: 'Allow Finance to ERP' }),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(resourceWrites(calls).length, 1, 'the create did happen')

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    assert.deepEqual(rollback.previousState, [
      {
        name: 'Allow Finance to ERP',
        policyType: 'ACCESS_POLICY',
        policySetId: POLICY_SET_ID,
        existed: false,
      },
    ])
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: a rule with no conditions authored is sent with an empty operand list', async () => {
  const bare = item('Catch Contractors', {
    name: 'Catch Contractors',
    policy_type: 'ACCESS_POLICY',
    action: 'DENY',
  })
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID }),
    zpaList([]),
    created({ id: '216196257331371002' }),
  ])
  try {
    const result = await deploy(deployContext([bare]))

    const body = bodyOf(resourceWrites(calls)[0])
    assert.deepEqual(body?.conditions, [])
    assert.equal(body?.description, '')
    assert.equal(body?.action, 'DENY')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID }),
    zpaList([LIVE]),
    ok({ id: LIVE.id }),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[2].method, 'PUT', 'a rule that exists is updated, not created')
    assert.ok(
      tenant[2].url.includes(`/policySet/${POLICY_SET_ID}/rule/${LIVE.id}`),
      `update hit ${tenant[2].url}`,
    )

    const body = bodyOf(tenant[2])
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.action, 'ALLOW')
    assert.equal(body?.policySetId, POLICY_SET_ID)
    assert.deepEqual(body?.conditions, CONDITIONS)

    const rollback = result.rollbackData as {
      previousState: Array<{
        existed: boolean
        ruleId: string
        policySetId: string
        policyType: string
        prior: Record<string, unknown>
      }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.ruleId, LIVE.id)
    assert.equal(entry.policySetId, POLICY_SET_ID, 'rollback needs the set id to rebuild the CRUD path')
    assert.equal(entry.policyType, 'ACCESS_POLICY')
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.action, 'DENY', 'the LIVE action, not the desired one')
    assert.deepEqual(entry.prior.conditions, LIVE.conditions, 'the LIVE operands, not the desired ones')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: refuses to touch the protected default rule of a policy set', async () => {
  // The catch-all rule decides what happens to everything no other rule matched.
  // Rewriting it as if it were an ordinary managed rule changes the posture of
  // the whole policy set.
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID }),
    zpaList([{ ...LIVE, defaultRule: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /is the default rule and cannot be modified/)
    assert.equal(resourceWrites(calls).length, 0, 'the default rule must not be written')
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: resolves a policy set once for several rules that target it', async () => {
  const second = item('Allow HR to Workday', {
    name: 'Allow HR to Workday',
    policy_type: 'ACCESS_POLICY',
    action: 'ALLOW',
  })
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID }),
    zpaList([]),
    created({ id: '216196257331371003' }),
    created({ id: '216196257331371004' }),
  ])
  try {
    const result = await deploy(deployContext([RULE, second]))

    const reads = resourceCalls(calls).filter((c) => c.method === 'GET')
    assert.equal(reads.filter((c) => c.url.includes('/policySet/policyType/')).length, 1)
    assert.equal(reads.filter((c) => c.url.includes('/policySet/rules/policyType/')).length, 1)
    assert.equal(resourceWrites(calls).length, 2)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID }),
    zpaList([LIVE]),
    zpaError(400, 'rule name already exists in this policy set'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /rule name already exists in this policy set/)
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { action?: string } }> }
    assert.equal(
      rollback.previousState[0].prior?.action,
      'DENY',
      'the prior body read before the overwrite must survive the failure path',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: an unresolvable policy set stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/policySet\/rules\/policyType\//, respond: zpaList([]) },
    { url: /\/policySet\/policyType\//, respond: serverError() },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to resolve the ACCESS_POLICY policy set/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: a failed rule listing stops the deploy before it writes anything', async () => {
  // A 500 here is "I could not look". Treating it as an empty set would create a
  // second rule with the same name beside the one already in the policy set.
  const { calls, restore } = routeFetch([
    { url: /\/policySet\/rules\/policyType\//, respond: serverError() },
    { url: /\/policySet\/policyType\//, respond: ok({ id: POLICY_SET_ID }) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list ACCESS_POLICY rules/)
    assert.equal(resourceWrites(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-policy-rules deploy: conditions that are not a JSON array fail the deploy without writing', async () => {
  const malformed = item('Allow Finance to ERP', {
    name: 'Allow Finance to ERP',
    policy_type: 'ACCESS_POLICY',
    action: 'ALLOW',
    conditions_json: '{"operator":"OR"}',
  })
  const { calls, restore } = recordFetch([TOKEN, ok({ id: POLICY_SET_ID }), zpaList([])])
  try {
    const result = await deploy(deployContext([malformed]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /conditions must be a JSON array of condition objects/)
    assert.equal(resourceWrites(calls).length, 0)
  } finally {
    restore()
  }
})
