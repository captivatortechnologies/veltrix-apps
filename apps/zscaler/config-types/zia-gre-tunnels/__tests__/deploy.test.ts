// deploy for zia-gre-tunnels.
//
// What is specific to this type:
//   * identity is the SOURCE IP, not a name — the listing is matched on
//     `sourceIp` and that is what the rollback entry is keyed on;
//   * the advanced tunnel fields (primaryDestVip/secondaryDestVip/withinCountry/
//     ipUnnumbered) arrive through the `gre_json` escape hatch and are MERGED
//     ON TOP of sourceIp + comment, so the request body is the thing to assert;
//   * the update path captures those same VIP/flag fields as the prior state —
//     the only record of which Zscaler VIP the tunnel used to point at;
//   * ZIA stages writes, so a deploy that never reaches /status/activate has
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
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const TUNNEL = item('HQ tunnel', {
  source_ip: '203.0.113.10',
  comment: 'desired comment',
  gre_json: '{"primaryDestVip":{"id":12345},"withinCountry":true}',
})

/**
 * The live tunnel, deliberately UNLIKE the canvas: a different comment, a
 * different primary VIP and both flags inverted. A rollback entry that mirrors
 * the canvas rather than this has recorded the desired state, not the prior one.
 */
const LIVE = {
  id: 4411,
  sourceIp: '203.0.113.10',
  comment: 'live comment set by hand',
  primaryDestVip: { id: 99999, virtualIp: '165.225.1.1' },
  secondaryDestVip: { id: 88888, virtualIp: '165.225.2.2' },
  withinCountry: false,
  ipUnnumbered: true,
}

registerDeployGuardContract({ label: 'zia-gre-tunnels', handler: deploy, product: 'zia', items: [TUNNEL] })

test('zia-gre-tunnels deploy: creates a tunnel whose source IP is not provisioned yet, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 4400, sourceIp: '198.51.100.1' }]),
    created({ id: 4412, sourceIp: '203.0.113.10' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([TUNNEL]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/greTunnels\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/greTunnels$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.sourceIp, '203.0.113.10')
    assert.equal(body?.comment, 'desired comment')
    assert.deepEqual(body?.primaryDestVip, { id: 12345 }, 'gre_json keys are merged into the payload')
    assert.equal(body?.withinCountry, true)

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ sourceIp: '203.0.113.10', existed: false, id: 4412 }])
    assert.deepEqual(rollback.createdIds, [4412])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels deploy: updates the tunnel matched by source IP and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 4411 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([TUNNEL]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a provisioned source IP is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/greTunnels\/4411$/)
    assert.equal(bodyOf(tenant[1])?.comment, 'desired comment')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ sourceIp: string; existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.sourceIp, '203.0.113.10', 'rollback entries are keyed on the source IP')
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 4411)
    assert.equal(entry.prior.comment, 'live comment set by hand', 'rollback must restore what was there')
    assert.deepEqual(entry.prior.primaryDestVip, { id: 99999, virtualIp: '165.225.1.1' })
    assert.deepEqual(entry.prior.secondaryDestVip, { id: 88888, virtualIp: '165.225.2.2' })
    assert.equal(entry.prior.withinCountry, false)
    assert.equal(entry.prior.ipUnnumbered, true)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Source IP is not a provisioned static IP'),
  ])
  try {
    const result = await deploy(deployContext([TUNNEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Source IP is not a provisioned static IP/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live tunnel, so the VIP/flag values deploy
    // read beforehand have to survive on the failure path or the tunnel can
    // never be pointed back at its original VIP.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.primaryDestVip, { id: 99999, virtualIp: '165.225.1.1' })
    assert.equal(rollback.previousState[0].prior?.comment, 'live comment set by hand')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/greTunnels/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([TUNNEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list GRE tunnels/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 4412 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([TUNNEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [4412], 'the staged tunnel still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-gre-tunnels deploy: a create whose response carries no id fails the deploy', async () => {
  // NOTE: what this path RECORDS is deliberately not asserted. The POST
  // succeeded — the tunnel exists in the tenant — but deploy throws on the
  // missing id BEFORE pushing its rollback entry, so the created tunnel is
  // returned as nothing to roll back. Asserting that would bless it; see the
  // report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ sourceIp: '203.0.113.10' })])
  try {
    const result = await deploy(deployContext([TUNNEL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
