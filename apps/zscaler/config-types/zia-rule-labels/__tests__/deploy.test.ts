// deploy for zia-rule-labels.
//
// What is specific to this type and worth driving end to end:
//   * identity is `name` and the id is NUMERIC, so a rollback entry that lost
//     the id cannot be undone at all;
//   * the payload is two fields and `description` is ALWAYS sent, even blank —
//     that is how clearing a description converges the live label;
//   * ZIA STAGES writes, so a deploy that does not reach `/status/activate` has
//     changed nothing the customer can see, and one that activates has;
//   * the update path must record the LIVE prior body, which is the only thing
//     rollback can restore.

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
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const LABEL = item('Critical Egress', { name: 'Critical Egress', description: 'desired description' })

/**
 * The live label, deliberately UNLIKE the canvas: a different description. A
 * rollback entry that mirrors the canvas rather than this has recorded the
 * desired state, not the prior state.
 */
const LIVE = { id: 4001, name: 'Critical Egress', description: 'live description set by hand' }

registerDeployGuardContract({ label: 'zia-rule-labels', handler: deploy, product: 'zia', items: [LABEL] })

test('zia-rule-labels deploy: creates a label that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 4077, name: 'Something Else' }]),
    created({ id: 4009, name: 'Critical Egress' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([LABEL]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/ruleLabels\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/ruleLabels$/)
    assert.deepEqual(bodyOf(tenant[1]), { name: 'Critical Egress', description: 'desired description' })

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Critical Egress', existed: false, id: 4009 }])
    assert.deepEqual(rollback.createdIds, [4009])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOTE: the branch where ZIA answers the POST without an id is deliberately not
// asserted. deploy throws there BEFORE pushing the rollback entry, so the label
// it just created exists in the tenant with nothing recorded to delete it — see
// the report accompanying these tests. Asserting it would bless it.

test('zia-rule-labels deploy: an omitted description is sent as empty, not dropped', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 4010 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([item('Bare Label', { name: 'Bare Label' })]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(bodyOf(tenant[1])?.description, '', 'a blank description must converge the live label')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-rule-labels deploy: updates an existing label and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 4001 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([LABEL]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a label that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/ruleLabels\/4001$/)
    assert.equal(bodyOf(tenant[1])?.description, 'desired description')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
      createdIds: number[]
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 4001)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.name, 'Critical Egress')
    assert.deepEqual(rollback.createdIds, [], 'an update creates nothing to delete')
  } finally {
    restore()
  }
})

test('zia-rule-labels deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ziaError(400, 'Rule label name already in use')])
  try {
    const result = await deploy(deployContext([LABEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rule label name already in use/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live label, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { description?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.description, 'live description set by hand')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-rule-labels deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/ruleLabels/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([LABEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list rule labels/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-rule-labels deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 4009 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([LABEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [4009], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})
