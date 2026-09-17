// rollback for zia-ip-destination-groups.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore has to
// put back the prior destination `type` as well as the address list — a group
// left as DSTN_IP when it was DSTN_FQDN is a different rule — and, like deploy,
// it omits `countries` rather than sending an empty list.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACTIVATED,
  NO_CONTENT,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-ip-destination-groups',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Partner egress',
  existed: true,
  id: 3311,
  prior: {
    name: 'Partner egress',
    description: 'live description set by hand',
    type: 'DSTN_FQDN',
    addresses: ['legacy.example.com'],
    countries: ['DE'],
  },
}

const CREATED_ENTRY = { name: 'New group', existed: false, id: 3312 }

test('zia-ip-destination-groups rollback: restores the prior body of a group deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 3311 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/ipDestinationGroups\/3311$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.name, 'Partner egress')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.type, 'DSTN_FQDN', 'the destination category is part of what was there')
    assert.deepEqual(body?.addresses, ['legacy.example.com'])
    assert.deepEqual(body?.countries, ['DE'])

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups rollback: omits countries when the prior body had none', async () => {
  const entry = { ...UPDATED_ENTRY, prior: { ...UPDATED_ENTRY.prior, countries: [] } }
  const { calls, restore } = recordFetch([TOKEN, ok({}), ACTIVATED])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(assertAuthenticatedFirst(assert, calls)[0])?.countries, undefined)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups rollback: deletes a group deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/ipDestinationGroups\/3312$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups rollback: a group already gone is not an error', async () => {
  // 404 is a known answer — the group we would delete is already absent, which
  // is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Destination group is referenced by a firewall rule')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /referenced by a firewall rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups rollback: a failed activation is reported as still-staged', async () => {
  const { restore } = recordFetch([TOKEN, ok({}), ziaError(409, 'Another activation is already in progress')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /Re-run rollback/)
  } finally {
    restore()
  }
})
