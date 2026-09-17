// deploy for zia-sandbox-rules.
//
// This is a POLICY RULE type, so the things worth driving end to end are the
// ones that decide whether traffic is blocked:
//   * the body ZIA actually receives — `{ name, order, state }` merged with the
//     rule_json escape hatch that carries the Sandbox action (`ba_rule_action`),
//     the policy categories and the file types;
//   * `order` and `state`: a rule written at the wrong order is evaluated after
//     something that already matched, and a rule written DISABLED blocks nothing;
//   * the built-in DEFAULT rule must never be overwritten — deploy has to refuse
//     before it writes;
//   * ZIA STAGES writes, so nothing is visible until `/status/activate`;
//   * the update path must record the WHOLE live prior rule, because rollback
//     PUTs it back verbatim.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const RULE_JSON = JSON.stringify({
  ba_rule_action: 'BLOCK',
  ba_policy_categories: ['ADWARE_BLOCK', 'ANONYMIZER'],
  fileTypes: ['FTCATEGORY_MS_EXE'],
})

const RULE = item('Block Malicious Files', {
  name: 'Block Malicious Files',
  order: '2',
  state: 'ENABLED',
  rule_json: RULE_JSON,
})

/**
 * The live rule, deliberately UNLIKE the canvas: a different order, the opposite
 * state and the opposite Sandbox action. A rollback entry that mirrors the canvas
 * rather than this has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 9001,
  name: 'Block Malicious Files',
  order: 7,
  rank: 0,
  state: 'DISABLED',
  ba_rule_action: 'ALLOW',
  ba_policy_categories: ['ADWARE_BLOCK'],
}

registerDeployGuardContract({ label: 'zia-sandbox-rules', handler: deploy, product: 'zia', items: [RULE] })

test('zia-sandbox-rules deploy: creates a rule that does not exist, with its action and order, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 9000, name: 'Default Sandbox Rule', defaultRule: true }]),
    created({ id: 9009, name: 'Block Malicious Files' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/sandboxRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/sandboxRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Block Malicious Files')
    assert.equal(body?.order, 2, 'the evaluation order decides which rule matches first')
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.ba_rule_action, 'BLOCK', 'the Sandbox action is what the rule actually does')
    assert.deepEqual(body?.ba_policy_categories, ['ADWARE_BLOCK', 'ANONYMIZER'])
    assert.deepEqual(body?.fileTypes, ['FTCATEGORY_MS_EXE'])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Block Malicious Files', existed: false, id: 9009 }])
    assert.deepEqual(rollback.createdIds, [9009])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOTE: the branch where ZIA answers the POST without an id is deliberately not
// asserted. deploy throws there BEFORE pushing the rollback entry, so the rule it
// just created exists in the tenant with nothing recorded to delete it — see the
// report accompanying these tests. Asserting it would bless it.

test('zia-sandbox-rules deploy: sends the state the author chose, and defaults the order to 1', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 9010 }), ACTIVATED])
  try {
    const result = await deploy(
      deployContext([item('Staged Rule', { name: 'Staged Rule', state: 'disabled', rule_json: RULE_JSON })]),
    )

    const tenant = assertAuthenticatedFirst(assert, calls)
    const body = bodyOf(tenant[1])
    assert.equal(body?.state, 'DISABLED', 'a rule the author staged disabled must not be created enabled')
    assert.equal(body?.order, 1)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules deploy: rule_json cannot rename the rule or move it in the evaluation order', async () => {
  // NOTE: `state` is deliberately not asserted here. The escape-hatch JSON is
  // spread OVER the first-class fields and only name/order are re-applied, so a
  // `state` key in rule_json silently wins over the canvas State field — see the
  // report accompanying these tests. Asserting it would bless it.
  const hostile = JSON.stringify({ name: 'Attacker Rename', order: 99, ba_rule_action: 'BLOCK' })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 9011 }), ACTIVATED])
  try {
    await deploy(
      deployContext([item('Block Malicious Files', { name: 'Block Malicious Files', order: '2', rule_json: hostile })]),
    )

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[1])
    assert.equal(body?.name, 'Block Malicious Files', 'the canvas identity always wins')
    assert.equal(body?.order, 2, 'the canvas evaluation order always wins')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules deploy: updates an existing rule and records its WHOLE live prior rule', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 9001 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/sandboxRules\/9001$/)
    assert.equal(bodyOf(tenant[1])?.ba_rule_action, 'BLOCK')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 9001)
    assert.equal(entry.prior.order, 7, 'rollback must restore the order that was there')
    assert.equal(entry.prior.state, 'DISABLED', 'rollback must restore the state that was there')
    assert.equal(entry.prior.ba_rule_action, 'ALLOW', 'rollback must restore the action that was there')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules deploy: refuses to overwrite the built-in default rule, and writes nothing', async () => {
  for (const marker of ['defaultRule', 'isDefaultRule', 'predefined']) {
    const { calls, restore } = recordFetch([
      TOKEN,
      ziaList([{ id: 9000, name: 'Block Malicious Files', [marker]: true }]),
    ])
    try {
      const result = await deploy(deployContext([RULE]))

      assert.equal(result.success, false, `${marker} must protect the rule`)
      assert.match(String(result.message), /default sandbox rule/)
      assert.equal(writeCalls(calls).length, 0, 'the default rule must never be written to')
      const rollback = result.rollbackData as { previousState: unknown[] }
      assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
    } finally {
      restore()
    }
  }
})

test('zia-sandbox-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Rule order 2 is already taken by another sandbox rule'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already taken by another sandbox rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live rule, so the prior rule deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.ba_rule_action, 'ALLOW')
    assert.equal(rollback.previousState[0].prior?.state, 'DISABLED')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  // Without the listing deploy cannot tell an existing rule from a new one, and
  // cannot tell the protected default rule from one of ours.
  const { calls, restore } = routeFetch([{ url: /\/sandboxRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list sandbox rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 9009 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [9009], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})
