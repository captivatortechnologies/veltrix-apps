// deploy for zia-forwarding-control-rules.
//
// What is specific to this type:
//   * it carries FOUR first-class scalars, not three — `type` and
//     `forwardMethod` on top of order/state — and forwardMethod is the field
//     that decides whether traffic goes DIRECT, through ZPA, or is DROPped;
//   * the forwarding targets (zpaGateway, zpaAppSegments, proxyGateway) arrive
//     as the `rule_json` escape hatch, so nothing resolves names to ids;
//   * protection is BY NAME here — this endpoint returns no `predefined` flag,
//     so deploy refuses ZIA's four predefined rule names whether or not the
//     tenant listing contains them;
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

const RULE = item('Route Branch To ZPA', {
  name: 'Route Branch To ZPA',
  order: 8,
  state: 'DISABLED',
  type: 'FORWARDING',
  forward_method: 'ZPA',
  rule_json: JSON.stringify({
    srcIps: ['10.0.0.0/8'],
    zpaGateway: { id: 501 },
    zpaAppSegments: [{ id: 601 }],
    destCountries: ['COUNTRY_US'],
  }),
})

/**
 * The live rule, deliberately UNLIKE the canvas: it forwards DIRECT where the
 * canvas routes through ZPA, is enabled, sits at a different order and points at
 * a different gateway. A rollback entry that mirrors the canvas rather than this
 * has recorded the desired state instead of the prior state.
 */
const LIVE = {
  id: 907,
  name: 'Route Branch To ZPA',
  order: 2,
  rank: 7,
  state: 'ENABLED',
  type: 'FORWARDING',
  forwardMethod: 'DIRECT',
  srcIps: ['192.168.0.0/16'],
  zpaGateway: { id: 599, name: 'Hand-made legacy gateway' },
}

registerDeployGuardContract({
  label: 'zia-forwarding-control-rules',
  handler: deploy,
  product: 'zia',
  items: [RULE],
})

test('zia-forwarding-control-rules deploy: creates a rule that does not exist, with its forwarding targets', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Something Else', order: 1 }]),
    created({ id: 9001, name: 'Route Branch To ZPA' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/forwardingRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/forwardingRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Route Branch To ZPA')
    assert.equal(body?.order, 8)
    assert.equal(body?.state, 'DISABLED', 'a rule written ENABLED when the author disabled it is a live rule')
    assert.equal(body?.type, 'FORWARDING')
    assert.equal(body?.forwardMethod, 'ZPA', 'the forward method decides where the traffic actually goes')
    assert.deepEqual(body?.srcIps, ['10.0.0.0/8'], 'the declared criteria must reach the vendor')
    assert.deepEqual(body?.zpaGateway, { id: 501 })
    assert.deepEqual(body?.zpaAppSegments, [{ id: 601 }])
    assert.deepEqual(body?.destCountries, ['COUNTRY_US'])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: unknown[]; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Route Branch To ZPA', existed: false, id: 9001 }])
    assert.deepEqual(rollback.createdIds, [9001])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: the JSON escape hatch can never rename the rule', async () => {
  // Identity is the name, so a JSON `name` must lose to the first-class field —
  // otherwise the next deploy would not recognise its own rule and would create
  // a duplicate. The other scalars are NOT asserted here: the JSON wins over
  // them while driftDetect compares the first-class values, and asserting that
  // would bless it — reported instead.
  const overriding = item('Route Branch To ZPA', {
    name: 'Route Branch To ZPA',
    order: 8,
    state: 'DISABLED',
    type: 'FORWARDING',
    forward_method: 'ZPA',
    rule_json: JSON.stringify({ name: 'Renamed', srcIps: ['10.0.0.0/8'] }),
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 9002 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([overriding]))

    const body = bodyOf(calls.find((c) => c.method === 'POST' && c.url.endsWith('/forwardingRules')))
    assert.equal(body?.name, 'Route Branch To ZPA')
    assert.deepEqual(body?.srcIps, ['10.0.0.0/8'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 907 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/forwardingRules\/907$/)
    assert.equal(bodyOf(tenant[1])?.forwardMethod, 'ZPA')
    assert.deepEqual(bodyOf(tenant[1])?.zpaGateway, { id: 501 })

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 907)
    assert.equal(
      entry.prior.forwardMethod,
      'DIRECT',
      'rollback must restore what was there, not what we wanted',
    )
    assert.equal(entry.prior.state, 'ENABLED')
    assert.equal(entry.prior.order, 2)
    assert.deepEqual(entry.prior.srcIps, ['192.168.0.0/16'])
    assert.deepEqual(entry.prior.zpaGateway, { id: 599, name: 'Hand-made legacy gateway' })
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: refuses a predefined rule NAME even when the tenant listing is empty', async () => {
  // This endpoint exposes no `predefined` marker, so the refusal cannot depend
  // on the live rule being found — it has to come off the name alone.
  const predefined = item('ZPA Pool For Stray Traffic', {
    name: 'ZPA Pool For Stray Traffic',
    order: 8,
    state: 'DISABLED',
    type: 'FORWARDING',
    forward_method: 'ZPA',
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([])])
  try {
    const result = await deploy(deployContext([predefined]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined ZIA forwarding control rule/)
    assert.equal(writeCalls(calls).length, 0, 'a predefined rule must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'a predefined rule is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: refuses a live rule flagged predefined, and writes nothing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 9, name: 'Route Branch To ZPA', predefined: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined ZIA forwarding control rule/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'ZPA gateway id 501 does not exist'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /ZPA gateway id 501 does not exist/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already reached the live rule, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { forwardMethod?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.forwardMethod, 'DIRECT')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/forwardingRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list forwarding rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 9003 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [9003], 'the staged rule still exists and must be revertible')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOT asserted: a POST that answers 200 with no id. deploy throws that case
// BEFORE pushing the rollback entry, so the staged rule exists in the tenant
// with nothing recorded to revert it. Asserting the empty rollbackData would
// bless it — reported instead.
