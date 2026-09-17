// rollback for zia-firewall-ips-rules.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: deploy snapshots
// the whole live rule, so the restore has to PUT that body back verbatim —
// restoring only the scalars would leave the rule inspecting whatever traffic
// the deploy pointed it at. A rule deploy created is deleted, a rule already
// gone (404) is not an error, and the revert only takes effect on activation.

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
  label: 'zia-firewall-ips-rules',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Inspect Inbound Web',
  existed: true,
  id: 812,
  prior: {
    id: 812,
    name: 'Inspect Inbound Web',
    order: 4,
    state: 'ENABLED',
    action: 'BYPASS_IPS',
    srcIpGroups: [{ id: 99, name: 'Hand-made legacy group' }],
    destCountries: ['COUNTRY_US'],
  },
}

const CREATED_ENTRY = { name: 'New IPS Rule', existed: false, id: 8101 }

test('zia-firewall-ips-rules rollback: restores the recorded prior body, not a default', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 812 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/firewallIpsRules\/812$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.action, 'BYPASS_IPS')
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.order, 4)
    assert.deepEqual(body?.srcIpGroups, [{ id: 99, name: 'Hand-made legacy group' }])
    assert.deepEqual(body?.destCountries, ['COUNTRY_US'])

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-firewall-ips-rules rollback: deletes a rule deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/firewallIpsRules\/8101$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-firewall-ips-rules rollback: undoes the newest change first, and activates once', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(activateCalls(calls).length, 1, 'one activation commits the whole revert')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-firewall-ips-rules rollback: a rule already gone is not an error', async () => {
  // 404 is a known answer — the rule we would delete is already absent, which is
  // the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-firewall-ips-rules rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Referenced IP group no longer exists')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Referenced IP group no longer exists/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-firewall-ips-rules rollback: a failed activation is reported as still-staged', async () => {
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
