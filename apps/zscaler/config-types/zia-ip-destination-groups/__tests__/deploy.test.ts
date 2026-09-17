// deploy for zia-ip-destination-groups.
//
// What is specific to this type:
//   * a destination group carries a `type` (DSTN_IP / DSTN_FQDN / …) alongside
//     its address list, and both are rewritten on every deploy — changing the
//     type of a group a firewall rule references re-points that rule;
//   * `addresses` and `countries` come from textareas and are sent as arrays;
//   * `countries` is OMITTED from the body when none are declared, rather than
//     sent empty;
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

const GROUP = item('Partner egress', {
  name: 'Partner egress',
  description: 'desired description',
  type: 'DSTN_IP',
  addresses: '203.0.113.0/24\n198.51.100.7',
  countries: 'CA\nUS',
})

/**
 * The live group, deliberately UNLIKE the canvas: a different description, a
 * different destination category, a different address list and a different
 * country list. A rollback entry that mirrors the canvas rather than this has
 * recorded the desired state, not the prior one.
 */
const LIVE = {
  id: 3311,
  name: 'Partner egress',
  description: 'live description set by hand',
  type: 'DSTN_FQDN',
  addresses: ['legacy.example.com'],
  countries: ['DE'],
}

registerDeployGuardContract({
  label: 'zia-ip-destination-groups',
  handler: deploy,
  product: 'zia',
  items: [GROUP],
})

test('zia-ip-destination-groups deploy: creates a group that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 3300, name: 'Something Else' }]),
    created({ id: 3312, name: 'Partner egress' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/ipDestinationGroups\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/ipDestinationGroups$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Partner egress')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.type, 'DSTN_IP')
    assert.deepEqual(body?.addresses, ['203.0.113.0/24', '198.51.100.7'])
    assert.deepEqual(body?.countries, ['CA', 'US'])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Partner egress', existed: false, id: 3312 }])
    assert.deepEqual(rollback.createdIds, [3312])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups deploy: omits countries when the canvas declares none', async () => {
  const noCountries = item('Partner egress', {
    name: 'Partner egress',
    type: 'DSTN_IP',
    addresses: '203.0.113.0/24',
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 3312 }), ACTIVATED])
  try {
    await deploy(deployContext([noCountries]))

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[1])
    assert.equal(body?.countries, undefined, 'an empty country list is left out, not sent as []')
    assert.equal(body?.description, '', 'a blank description is sent so clearing it converges the group')
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups deploy: updates an existing group and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 3311 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a group that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/ipDestinationGroups\/3311$/)
    assert.equal(bodyOf(tenant[1])?.type, 'DSTN_IP')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 3311)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.type, 'DSTN_FQDN')
    assert.deepEqual(entry.prior.addresses, ['legacy.example.com'])
    assert.deepEqual(entry.prior.countries, ['DE'])
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Address is not valid for destination type DSTN_IP'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Address is not valid for destination type/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live group, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.addresses, ['legacy.example.com'])
    assert.equal(rollback.previousState[0].prior?.type, 'DSTN_FQDN')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/ipDestinationGroups/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list IP destination groups/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 3312 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [3312], 'the staged group still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups deploy: a create whose response carries no id fails the deploy', async () => {
  // NOTE: what this path RECORDS is deliberately not asserted. The POST
  // succeeded — the group exists in the tenant — but deploy throws on the
  // missing id BEFORE pushing its rollback entry, so the created group is
  // returned as nothing to roll back. Asserting that would bless it; see the
  // report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ name: 'Partner egress' })])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
