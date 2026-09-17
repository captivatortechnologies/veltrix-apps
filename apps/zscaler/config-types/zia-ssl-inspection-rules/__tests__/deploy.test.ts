// deploy for zia-ssl-inspection-rules.
//
// This is a POLICY RULE type whose ACTION is an OBJECT, so it has no first-class
// action field — `{"action":{"type":"DECRYPT"}}` rides in the rule_json escape
// hatch. What is worth driving end to end:
//   * the body ZIA actually receives: rule_json first, then name/order/state
//     layered ON TOP so the JSON can never rename a rule or move it in the
//     evaluation order, while the `action` object flows through untouched;
//   * `order` and `state`: a rule written at the wrong order is evaluated after
//     something that already matched, and one written DISABLED inspects nothing;
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
  action: { type: 'DECRYPT' },
  urlCategories: ['FINANCE'],
  deviceTrustLevels: ['HIGH_TRUST'],
})

const RULE = item('Decrypt Finance', {
  name: 'Decrypt Finance',
  order: '3',
  state: 'ENABLED',
  rule_json: RULE_JSON,
})

/**
 * The live rule, deliberately UNLIKE the canvas: a different order, the opposite
 * state and the opposite SSL action. A rollback entry that mirrors the canvas
 * rather than this has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 6001,
  name: 'Decrypt Finance',
  order: 9,
  state: 'DISABLED',
  action: { type: 'DO_NOT_DECRYPT' },
  urlCategories: ['OTHER_MISCELLANEOUS'],
}

registerDeployGuardContract({ label: 'zia-ssl-inspection-rules', handler: deploy, product: 'zia', items: [RULE] })

test('zia-ssl-inspection-rules deploy: creates a rule that does not exist, with its action object, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 6000, name: 'Default SSL Rule', isDefaultRule: true }]),
    created({ id: 6009, name: 'Decrypt Finance' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/sslInspectionRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/sslInspectionRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Decrypt Finance')
    assert.equal(body?.order, 3, 'the evaluation order decides which rule matches first')
    assert.equal(body?.state, 'ENABLED')
    assert.deepEqual(body?.action, { type: 'DECRYPT' }, 'the action object decides whether traffic is inspected')
    assert.deepEqual(body?.urlCategories, ['FINANCE'])
    assert.deepEqual(body?.deviceTrustLevels, ['HIGH_TRUST'])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Decrypt Finance', existed: false, id: 6009 }])
    assert.deepEqual(rollback.createdIds, [6009])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOTE: the branch where ZIA answers the POST without an id is deliberately not
// asserted. deploy throws there BEFORE pushing the rollback entry, so the rule it
// just created exists in the tenant with nothing recorded to delete it — see the
// report accompanying these tests. Asserting it would bless it.

test('zia-ssl-inspection-rules deploy: rule_json can never override name, order or state', async () => {
  const hostile = JSON.stringify({
    name: 'Attacker Rename',
    order: 99,
    state: 'DISABLED',
    action: { type: 'DO_NOT_DECRYPT' },
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 6011 }), ACTIVATED])
  try {
    const result = await deploy(
      deployContext([item('Decrypt Finance', { name: 'Decrypt Finance', order: '3', state: 'ENABLED', rule_json: hostile })]),
    )

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[1])
    assert.equal(body?.name, 'Decrypt Finance', 'the canvas identity always wins')
    assert.equal(body?.order, 3, 'the canvas evaluation order always wins')
    assert.equal(body?.state, 'ENABLED', 'the canvas state always wins')
    assert.deepEqual(body?.action, { type: 'DO_NOT_DECRYPT' }, 'the action is not first-class and passes through')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: a blank order is sent as 1, the same default drift compares against', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 6010 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([item('Unordered', { name: 'Unordered', rule_json: RULE_JSON })]))

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[1])
    assert.equal(body?.order, 1)
    assert.equal(body?.state, 'ENABLED', 'a blank state field deploys an ENABLED rule')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: a rule with no rule_json sends only the first-class fields', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 6012 }), ACTIVATED])
  try {
    await deploy(deployContext([item('Bare Rule', { name: 'Bare Rule', order: '4', state: 'DISABLED' })]))

    assert.deepEqual(bodyOf(assertAuthenticatedFirst(assert, calls)[1]), {
      name: 'Bare Rule',
      order: 4,
      state: 'DISABLED',
    })
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: updates an existing rule and records its WHOLE live prior rule', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 6001 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/sslInspectionRules\/6001$/)
    assert.deepEqual(bodyOf(tenant[1])?.action, { type: 'DECRYPT' })

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 6001)
    assert.equal(entry.prior.order, 9, 'rollback must restore the order that was there')
    assert.equal(entry.prior.state, 'DISABLED', 'rollback must restore the state that was there')
    assert.deepEqual(entry.prior.action, { type: 'DO_NOT_DECRYPT' }, 'rollback must restore the action that was there')
    assert.deepEqual(entry.prior.urlCategories, ['OTHER_MISCELLANEOUS'])
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: refuses to overwrite the built-in default rule, and writes nothing', async () => {
  for (const marker of ['isDefaultRule', 'defaultRule', 'predefined']) {
    const { calls, restore } = recordFetch([TOKEN, ziaList([{ id: 6000, name: 'Decrypt Finance', [marker]: true }])])
    try {
      const result = await deploy(deployContext([RULE]))

      assert.equal(result.success, false, `${marker} must protect the rule`)
      assert.match(String(result.message), /predefined\/built-in SSL inspection rule/)
      assert.equal(writeCalls(calls).length, 0, 'the default rule must never be written to')
      const rollback = result.rollbackData as { previousState: unknown[] }
      assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
    } finally {
      restore()
    }
  }
})

test('zia-ssl-inspection-rules deploy: rule_json that is not a JSON object fails the deploy before writing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([])])
  try {
    const result = await deploy(
      deployContext([item('Broken Rule', { name: 'Broken Rule', rule_json: '{"action": ' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /rule JSON is not a valid JSON object/)
    assert.equal(resourceWrites(calls).length, 0, 'a malformed body must never reach the tenant')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Rule order 3 is already taken by another SSL inspection rule'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already taken by another SSL inspection rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live rule, so the prior rule deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.action, { type: 'DO_NOT_DECRYPT' })
    assert.equal(rollback.previousState[0].prior?.state, 'DISABLED')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  // Without the listing deploy cannot tell an existing rule from a new one, and
  // cannot tell the protected default rule from one of ours.
  const { calls, restore } = routeFetch([{ url: /\/sslInspectionRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list SSL inspection rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 6009 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [6009], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})
