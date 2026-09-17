// deploy for zia-ip-source-groups.
//
// What is specific to this type:
//   * the whole object is three fields — name, description and the source IP
//     list — and the IP list is the thing firewall rules scope on, so an
//     overwrite here silently widens or narrows a rule's source;
//   * `ip_addresses` is a textarea, split on either line ending;
//   * description is always sent, even blank, so clearing it converges;
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

const GROUP = item('Branch sources', {
  name: 'Branch sources',
  description: 'desired description',
  ip_addresses: '203.0.113.0/24\n198.51.100.7',
})

/**
 * The live group, deliberately UNLIKE the canvas: a different description and a
 * far wider source range. A rollback entry that mirrors the canvas rather than
 * this has recorded the desired state, not the prior one.
 */
const LIVE = {
  id: 5511,
  name: 'Branch sources',
  description: 'live description set by hand',
  ipAddresses: ['10.0.0.0/8'],
}

registerDeployGuardContract({ label: 'zia-ip-source-groups', handler: deploy, product: 'zia', items: [GROUP] })

test('zia-ip-source-groups deploy: creates a group that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 5500, name: 'Something Else' }]),
    created({ id: 5512, name: 'Branch sources' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/ipSourceGroups\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/ipSourceGroups$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Branch sources')
    assert.equal(body?.description, 'desired description')
    assert.deepEqual(body?.ipAddresses, ['203.0.113.0/24', '198.51.100.7'])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Branch sources', existed: false, id: 5512 }])
    assert.deepEqual(rollback.createdIds, [5512])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ip-source-groups deploy: updates an existing group and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 5511 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a group that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/ipSourceGroups\/5511$/)
    assert.deepEqual(bodyOf(tenant[1])?.ipAddresses, ['203.0.113.0/24', '198.51.100.7'])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 5511)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.deepEqual(entry.prior.ipAddresses, ['10.0.0.0/8'])
  } finally {
    restore()
  }
})

test('zia-ip-source-groups deploy: sends a blank description so clearing it converges', async () => {
  const noDescription = item('Branch sources', {
    name: 'Branch sources',
    ip_addresses: '203.0.113.0/24',
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 5512 }), ACTIVATED])
  try {
    await deploy(deployContext([noDescription]))

    assert.equal(bodyOf(assertAuthenticatedFirst(assert, calls)[1])?.description, '')
  } finally {
    restore()
  }
})

test('zia-ip-source-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ziaError(400, 'Invalid IP range in source group')])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Invalid IP range in source group/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live group, so the prior address list deploy
    // read beforehand has to survive on the failure path or it can never be
    // restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.ipAddresses, ['10.0.0.0/8'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ip-source-groups deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/ipSourceGroups/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list IP source groups/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-ip-source-groups deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 5512 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [5512], 'the staged group still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-ip-source-groups deploy: a create whose response carries no id fails the deploy', async () => {
  // NOTE: what this path RECORDS is deliberately not asserted. The POST
  // succeeded — the group exists in the tenant — but deploy throws on the
  // missing id BEFORE pushing its rollback entry, so the created group is
  // returned as nothing to roll back. Asserting that would bless it; see the
  // report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ name: 'Branch sources' })])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
