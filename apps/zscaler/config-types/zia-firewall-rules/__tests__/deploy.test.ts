// deploy for zia-firewall-rules.
//
// What is specific to this type:
//   * identity is the rule NAME and the id is numeric, so the update path is a
//     PUT to /firewallFilteringRules/{id} rather than a second POST;
//   * the matching criteria are not first-class fields — they arrive as the
//     `rule_json` escape hatch and are spread into the body FIRST, so the
//     first-class name/order/state/action always win over the JSON;
//   * the predefined default rule is read-only and deploy must refuse it;
//   * ZIA STAGES writes, so a deploy that does not reach /status/activate has
//     changed nothing the customer can see, and one that activates has.

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

const RULE = item('Block Legacy Ports', {
  name: 'Block Legacy Ports',
  order: 20,
  state: 'DISABLED',
  action: 'BLOCK_RESET',
  rule_json: JSON.stringify({
    srcIpGroups: [{ id: 11 }],
    destIpGroups: [{ id: 22 }],
    nwServices: [{ id: 33 }],
    labels: [{ id: 44 }],
  }),
})

/**
 * The live rule, deliberately UNLIKE the canvas: it ALLOWS where the canvas
 * blocks, sits at a different order, and matches a different source group. A
 * rollback entry that mirrors the canvas rather than this has recorded the
 * desired state instead of the prior state.
 */
const LIVE = {
  id: 704,
  name: 'Block Legacy Ports',
  order: 3,
  rank: 7,
  state: 'ENABLED',
  action: 'ALLOW',
  srcIpGroups: [{ id: 99, name: 'Hand-made legacy group' }],
  nwServices: [{ id: 98, name: 'ANY' }],
}

registerDeployGuardContract({ label: 'zia-firewall-rules', handler: deploy, product: 'zia', items: [RULE] })

test('zia-firewall-rules deploy: creates a rule that does not exist, with the criteria it was given', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Something Else', order: 1 }]),
    created({ id: 7001, name: 'Block Legacy Ports' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/firewallFilteringRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/firewallFilteringRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Block Legacy Ports')
    assert.equal(body?.order, 20)
    assert.equal(body?.state, 'DISABLED', 'a rule written ENABLED when the author disabled it is a live rule')
    assert.equal(body?.action, 'BLOCK_RESET')
    assert.deepEqual(body?.srcIpGroups, [{ id: 11 }], 'the declared criteria must reach the vendor')
    assert.deepEqual(body?.destIpGroups, [{ id: 22 }])
    assert.deepEqual(body?.nwServices, [{ id: 33 }])
    assert.deepEqual(body?.labels, [{ id: 44 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: unknown[]; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Block Legacy Ports', existed: false, id: 7001 }])
    assert.deepEqual(rollback.createdIds, [7001])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-firewall-rules deploy: the first-class fields win over the JSON escape hatch', async () => {
  // rule_json supplies the criteria, but a rule authored BLOCK_RESET/DISABLED
  // must not be deployed ALLOW/ENABLED because the JSON says so — drift compares
  // the first-class values, so the two have to agree.
  const overriding = item('Block Legacy Ports', {
    name: 'Block Legacy Ports',
    order: 20,
    state: 'DISABLED',
    action: 'BLOCK_RESET',
    rule_json: JSON.stringify({ name: 'Renamed', order: 1, state: 'ENABLED', action: 'ALLOW', srcIpGroups: [{ id: 11 }] }),
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 7002 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([overriding]))

    const body = bodyOf(calls.find((c) => c.method === 'POST' && c.url.endsWith('/firewallFilteringRules')))
    assert.equal(body?.name, 'Block Legacy Ports', 'the JSON body may never rename the rule')
    assert.equal(body?.action, 'BLOCK_RESET')
    assert.equal(body?.state, 'DISABLED')
    assert.equal(body?.order, 20)
    assert.deepEqual(body?.srcIpGroups, [{ id: 11 }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-firewall-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 704 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/firewallFilteringRules\/704$/)
    assert.equal(bodyOf(tenant[1])?.action, 'BLOCK_RESET')
    assert.deepEqual(bodyOf(tenant[1])?.srcIpGroups, [{ id: 11 }])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 704)
    assert.equal(entry.prior.action, 'ALLOW', 'rollback must restore what was there, not what we wanted')
    assert.equal(entry.prior.state, 'ENABLED')
    assert.equal(entry.prior.order, 3)
    assert.deepEqual(entry.prior.srcIpGroups, [{ id: 99, name: 'Hand-made legacy group' }])
  } finally {
    restore()
  }
})

test('zia-firewall-rules deploy: refuses to overwrite the predefined default rule, and writes nothing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 9, name: 'Block Legacy Ports', isDefaultRule: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined default firewall rule/)
    assert.equal(writeCalls(calls).length, 0, 'the built-in rule must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-firewall-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Network service id 33 does not exist'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Network service id 33 does not exist/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already reached the live rule, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { action?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.action, 'ALLOW')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-firewall-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/firewallFilteringRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list firewall rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-firewall-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 7003 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [7003], 'the staged rule still exists and must be revertible')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOT asserted: a POST that answers 200 with no id. deploy throws that case
// BEFORE pushing the rollback entry, so the staged rule exists in the tenant
// with nothing recorded to revert it. Asserting the empty rollbackData would
// bless it — reported instead.
