// deploy for zia-firewall-dns-rules.
//
// What is specific to this type:
//   * identity is the rule NAME and the id is numeric, so an existing rule is
//     PUT to /firewallDnsRules/{id} rather than POSTed again;
//   * the DNS matching criteria (request types, source IPs, referenced groups
//     and labels) arrive as the `rule_json` escape hatch — nothing resolves
//     names to ids, so whatever the author declared is what is sent;
//   * REDIR_REQ is an action here, so the action decides whether a query is
//     answered, dropped or silently redirected to another resolver;
//   * ZIA STAGES writes, so nothing is live until /status/activate.

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

const RULE = item('Block Rogue Resolvers', {
  name: 'Block Rogue Resolvers',
  order: 12,
  state: 'DISABLED',
  action: 'BLOCK',
  rule_json: JSON.stringify({
    srcIps: ['10.0.0.0/8'],
    dnsRuleRequestTypes: ['A', 'AAAA'],
    destIpGroups: [{ id: 22 }],
    labels: [{ id: 44 }],
  }),
})

/**
 * The live rule, deliberately UNLIKE the canvas: it ALLOWS where the canvas
 * blocks, is enabled, sits at a different order and matches a different source
 * range. A rollback entry that mirrors the canvas rather than this has recorded
 * the desired state instead of the prior state.
 */
const LIVE = {
  id: 331,
  name: 'Block Rogue Resolvers',
  order: 2,
  rank: 7,
  state: 'ENABLED',
  action: 'ALLOW',
  srcIps: ['192.168.0.0/16'],
  dnsRuleRequestTypes: ['ANY'],
  destIpGroups: [{ id: 99, name: 'Hand-made legacy group' }],
}

registerDeployGuardContract({ label: 'zia-firewall-dns-rules', handler: deploy, product: 'zia', items: [RULE] })

test('zia-firewall-dns-rules deploy: creates a rule that does not exist, with the criteria it was given', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Something Else', order: 1 }]),
    created({ id: 3301, name: 'Block Rogue Resolvers' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/firewallDnsRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/firewallDnsRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Block Rogue Resolvers')
    assert.equal(body?.order, 12)
    assert.equal(body?.state, 'DISABLED', 'a rule written ENABLED when the author disabled it is a live rule')
    assert.equal(body?.action, 'BLOCK')
    assert.deepEqual(body?.srcIps, ['10.0.0.0/8'], 'the declared criteria must reach the vendor')
    assert.deepEqual(body?.dnsRuleRequestTypes, ['A', 'AAAA'])
    assert.deepEqual(body?.destIpGroups, [{ id: 22 }])
    assert.deepEqual(body?.labels, [{ id: 44 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: unknown[]; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Block Rogue Resolvers', existed: false, id: 3301 }])
    assert.deepEqual(rollback.createdIds, [3301])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-firewall-dns-rules deploy: the JSON escape hatch can never rename the rule', async () => {
  // Identity is the name, so a JSON `name` must lose to the first-class field —
  // otherwise the next deploy would not recognise its own rule and would create
  // a duplicate. The other scalars are NOT asserted here: the JSON wins over
  // them while driftDetect compares the first-class values, and asserting that
  // would bless it — reported instead.
  const overriding = item('Block Rogue Resolvers', {
    name: 'Block Rogue Resolvers',
    order: 12,
    state: 'DISABLED',
    action: 'BLOCK',
    rule_json: JSON.stringify({ name: 'Renamed', srcIps: ['10.0.0.0/8'] }),
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 3302 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([overriding]))

    const body = bodyOf(calls.find((c) => c.method === 'POST' && c.url.endsWith('/firewallDnsRules')))
    assert.equal(body?.name, 'Block Rogue Resolvers')
    assert.deepEqual(body?.srcIps, ['10.0.0.0/8'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-firewall-dns-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 331 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/firewallDnsRules\/331$/)
    assert.equal(bodyOf(tenant[1])?.action, 'BLOCK')
    assert.deepEqual(bodyOf(tenant[1])?.srcIps, ['10.0.0.0/8'])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 331)
    assert.equal(entry.prior.action, 'ALLOW', 'rollback must restore what was there, not what we wanted')
    assert.equal(entry.prior.state, 'ENABLED')
    assert.equal(entry.prior.order, 2)
    assert.deepEqual(entry.prior.srcIps, ['192.168.0.0/16'])
    assert.deepEqual(entry.prior.destIpGroups, [{ id: 99, name: 'Hand-made legacy group' }])
  } finally {
    restore()
  }
})

test('zia-firewall-dns-rules deploy: refuses to overwrite the built-in default rule, and writes nothing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 9, name: 'Block Rogue Resolvers', isDefaultRule: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined\/built-in DNS rule/)
    assert.equal(writeCalls(calls).length, 0, 'the built-in rule must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-firewall-dns-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Destination IP group id 22 does not exist'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Destination IP group id 22 does not exist/)
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

test('zia-firewall-dns-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/firewallDnsRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list DNS rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-firewall-dns-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 3303 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [3303], 'the staged rule still exists and must be revertible')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOT asserted: a POST that answers 200 with no id. deploy throws that case
// BEFORE pushing the rollback entry, so the staged rule exists in the tenant
// with nothing recorded to revert it. Asserting the empty rollbackData would
// bless it — reported instead.
