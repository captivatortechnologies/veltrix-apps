// ============================================================================
// rollback for the cross-tenant access DEFAULT policy, against a fake Graph.
//
// The singleton cannot be deleted, so rollback has exactly two moves, and
// picking the wrong one leaves the tenant trusting an outside directory:
//   * the policy was still the untouched system default before deploy ->
//     resetToSystemDefault, the only faithful way back;
//   * it had already been customised -> PATCH the writable subset of the prior
//     body back, byte for byte as it was read at deploy time.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  notFound,
  recordFetch,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const PATH = '/policies/crossTenantAccessPolicy/default'

/** The full prior body deploy recorded — writable keys mixed with read-only ones. */
const PRIOR = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#policies/crossTenantAccessPolicy/default/$entity',
  isServiceDefault: false,
  inboundTrust: {
    isMfaAccepted: false,
    isCompliantDeviceAccepted: false,
    isHybridAzureADJoinedDeviceAccepted: false,
  },
  automaticUserConsentSettings: { inboundAllowed: false, outboundAllowed: false },
  b2bCollaborationInbound: {
    usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] },
  },
  b2bDirectConnectInbound: null,
}

function entry(over: Record<string, unknown> = {}) {
  return { entries: [{ existed: true, wasServiceDefault: false, previousState: PRIOR, ...over }] }
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(entry(), { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the writable prior body exactly as deploy read it', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext(entry()))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(PATH))
    assert.deepEqual(bodyOf(graphCalls[0]), {
      inboundTrust: PRIOR.inboundTrust,
      b2bCollaborationInbound: PRIOR.b2bCollaborationInbound,
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /Restored the prior/)
  } finally {
    restore()
  }
})

test('the restore body carries no read-only key Graph would reject the whole PATCH for', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    await rollback(rollbackContext(entry()))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    // One rejected key would take the real inboundTrust restore down with it.
    assert.equal('automaticUserConsentSettings' in body, false)
    assert.equal('isServiceDefault' in body, false)
    assert.equal('@odata.context' in body, false)
    // A null-valued writable key is dropped too — Graph rejects a null block.
    assert.equal('b2bDirectConnectInbound' in body, false)
  } finally {
    restore()
  }
})

test('a policy that was still the system default is reset, never patched', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext(entry({ wasServiceDefault: true })))

    const graphCalls = vendorCalls(calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'POST')
    assert.ok(graphCalls[0].url.endsWith(`${PATH}/resetToSystemDefault`))
    assert.equal(graphCalls[0].body, '', 'resetToSystemDefault takes no body')
    assert.equal(result.success, true)
    assert.match(String(result.message), /system default/)
  } finally {
    restore()
  }
})

test('an entry with no recorded prior restores nothing rather than inventing values', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, wasServiceDefault: false }] }))

    // An empty PATCH is a no-op on Graph: no trust flag and no access block is
    // guessed at from the canvas or from a default.
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {})
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Nothing to roll back/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an empty entries array is also a no-op', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback reports a rejected restore rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext(entry()))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback \(restore\) failed/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected reset is reported as a failure too', async () => {
  const { restore } = recordFetch([TOKEN, graphError(400, 'Policy cannot be reset while partners exist.', 'Request_BadRequest')])
  try {
    const result = await rollback(rollbackContext(entry({ wasServiceDefault: true })))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback \(reset\) failed/)
    assert.match(String(result.message), /cannot be reset/)
  } finally {
    restore()
  }
})

test('a 404 on the singleton is a real failure, not an already-undone no-op', async () => {
  // Unlike a deletable object, the default policy always exists in a healthy
  // tenant — a 404 here means the wrong directory or a missing permission, and
  // reporting it as success would hide an unrolled-back trust change.
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext(entry()))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback \(restore\) failed/)
  } finally {
    restore()
  }
})
