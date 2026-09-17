// deploy for zia-url-filtering-rules.
//
// What is specific to this type:
//   * it is a JSON-BODY policy rule — the `rule_json` escape hatch carries the
//     object references (urlCategories, locations, labels) verbatim and is
//     spread FIRST, so the first-class name/order/state/action/protocols always
//     overlay it and the JSON can never hijack the rule's identity;
//   * ZIA ships a PROTECTED default rule that must never be written to;
//   * the update path captures the WHOLE live rule, because that is the only
//     thing rollback can PUT back;
//   * ZIA stages writes, so a deploy that does not reach `/status/activate` has
//     changed nothing the customer can see.

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

const RULE = item('Block adult content', {
  name: 'Block adult content',
  order: 3,
  state: 'ENABLED',
  action: 'BLOCK',
  protocols: 'HTTP_RULE\nHTTPS_RULE',
  rule_json:
    '{"name":"hijacked by the JSON","urlCategories":["OTHER_ADULT_MATERIAL"],"locations":[{"id":123}],"labels":[{"id":7}]}',
})

/**
 * The live rule, deliberately UNLIKE the canvas: disabled, allowing, ordered
 * last, pointed at a different category and carrying hand-set fields the canvas
 * never mentions. A rollback entry that mirrors the canvas rather than this has
 * recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 5150,
  name: 'Block adult content',
  order: 9,
  state: 'DISABLED',
  action: 'ALLOW',
  protocols: ['ANY_RULE'],
  urlCategories: ['GAMBLING'],
  locations: [{ id: 999, name: 'HQ' }],
  description: 'hand-tuned in the ZIA console',
}

registerDeployGuardContract({
  label: 'zia-url-filtering-rules',
  handler: deploy,
  product: 'zia',
  items: [RULE],
})

test('zia-url-filtering-rules deploy: creates a rule that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 77, name: 'Something Else' }]),
    created({ id: 6001, name: 'Block adult content' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/urlFilteringRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/urlFilteringRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Block adult content', 'the JSON escape hatch must never override the identity')
    assert.equal(body?.order, 3)
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.action, 'BLOCK')
    assert.deepEqual(body?.protocols, ['HTTP_RULE', 'HTTPS_RULE'])
    assert.deepEqual(body?.urlCategories, ['OTHER_ADULT_MATERIAL'])
    assert.deepEqual(body?.locations, [{ id: 123 }], 'references are sent as { id } lists, verbatim')
    assert.deepEqual(body?.labels, [{ id: 7 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Block adult content', existed: false, id: 6001 }])
    assert.deepEqual(rollback.createdIds, [6001])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: defaults the protocols and the order when they are blank', async () => {
  // A rule with no protocols would never match, and ZIA requires an order.
  const minimal = item('Block gambling', { name: 'Block gambling', protocols: '   ' })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 6002 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([minimal]))

    const body = bodyOf(calls.filter((c) => c.method === 'POST' && c.url.includes('/urlFilteringRules'))[0])
    assert.deepEqual(body?.protocols, ['ANY_RULE'])
    assert.equal(body?.order, 1)
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.action, 'BLOCK')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 5150 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/urlFilteringRules\/5150$/)
    assert.equal(bodyOf(tenant[1])?.action, 'BLOCK')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ name: string; existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 5150)
    assert.equal(entry.prior.action, 'ALLOW', 'rollback must restore what was there')
    assert.equal(entry.prior.state, 'DISABLED')
    assert.equal(entry.prior.order, 9)
    assert.deepEqual(entry.prior.urlCategories, ['GAMBLING'])
    assert.deepEqual(entry.prior.locations, [{ id: 999, name: 'HQ' }])
    assert.equal(entry.prior.description, 'hand-tuned in the ZIA console', 'unmanaged fields are captured too')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: refuses to overwrite the built-in default rule, and writes nothing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Block adult content', defaultRule: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /is the default rule and cannot be modified/)
    assert.equal(writeCalls(calls).length, 0, 'the built-in rule must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: refuses a rule whose JSON escape hatch is malformed', async () => {
  const broken = item('Broken rule', { name: 'Broken rule', rule_json: '{"urlCategories": [' })
  const { calls, restore } = recordFetch([TOKEN, ziaList([])])
  try {
    const result = await deploy(deployContext([broken]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /rule JSON is not a valid JSON object/)
    assert.equal(resourceWrites(calls).length, 0, 'a malformed criteria object must never be sent')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Rule order 3 is already taken by another rule'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already taken by another rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live rule, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { action?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.action, 'ALLOW')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/urlFilteringRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list URL filtering rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 6001 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [6001], 'the staged rule still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules deploy: a create whose response carries no id fails rather than throwing', async () => {
  // NOTE: what rollbackData holds here is deliberately NOT asserted. The POST
  // succeeded, so the rule exists in the tenant, but deploy throws on the missing
  // id BEFORE pushing a rollback entry — see the report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ name: 'Block adult content' })])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
