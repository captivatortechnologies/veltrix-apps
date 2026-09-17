// rollback for zia-vpn-credentials.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here is the consequence
// of the write-only secret: deploy correctly never captured the pre-shared key,
// so rollback CANNOT restore it. The assertions below pin down what it actually
// sends — the prior non-secret fields and NO `preSharedKey` key at all, blank or
// otherwise — because a rollback that invented one would push a placeholder key
// over a working tunnel. What that leaves un-reverted is in the report.

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
  label: 'zia-vpn-credentials',
  handler: rollback,
  product: 'zia',
  nameKey: 'identity',
})

const UPDATED_ENTRY = {
  identity: 'chicago@acme.com',
  existed: true,
  id: 3007,
  prior: {
    type: 'UFQDN',
    fqdn: 'chicago@acme.com',
    comments: 'legacy comment set by hand',
  },
}

const CREATED_ENTRY = { identity: '203.0.113.10', existed: false, id: 3101 }

test('zia-vpn-credentials rollback: restores the prior non-secret body, and invents no pre-shared key', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 3007 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/vpnCredentials\/3007$/)
    const body = bodyOf(tenant[0]) ?? {}
    assert.equal(body.comments, 'legacy comment set by hand', 'the recorded prior, not a default')
    assert.equal(body.type, 'UFQDN')
    assert.equal(body.fqdn, 'chicago@acme.com')
    assert.equal(
      'preSharedKey' in body,
      false,
      'the key was never captured — sending a blank or placeholder one would break the tunnel',
    )

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials rollback: restores an IP credential on its ip_address', async () => {
  const ipEntry = {
    identity: '203.0.113.10',
    existed: true,
    id: 3101,
    prior: { type: 'IP', ipAddress: '203.0.113.10', comments: 'branch tunnel' },
  }
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 3101 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [ipEntry] }))

    const body = bodyOf(resourceCalls(calls)[0]) ?? {}
    assert.equal(body.type, 'IP')
    assert.equal(body.ipAddress, '203.0.113.10')
    assert.equal('fqdn' in body, false)
    assert.equal('preSharedKey' in body, false)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials rollback: deletes a credential deploy created', async () => {
  // Deleting removes the key deploy set along with the credential, so nothing of
  // the secret lingers for a created entry.
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/vpnCredentials\/3101$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials rollback: undoes the newest change first', async () => {
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

test('zia-vpn-credentials rollback: a credential already gone is not an error', async () => {
  // 404 is a known answer — the credential we would delete is already absent,
  // which is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'VPN credential is in use by a location')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /in use by a location/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials rollback: a failed activation is reported as still-staged', async () => {
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
