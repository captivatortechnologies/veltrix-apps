// ============================================================================
// driftDetect for the cross-tenant access DEFAULT policy, against a fake Graph.
//
// Drift here means somebody widened (or narrowed) what every external tenant
// gets, outside the canvas. The two asymmetries worth pinning down:
//   * inbound trust is compared as a strict boolean — a live value that is
//     absent reads as false, never as "matches whatever was asked";
//   * automaticUserConsentSettings is deliberately NOT compared, because deploy
//     can never write it on this policy; flagging it would be perpetual,
//     uncorrectable drift.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const INBOUND_BLOCKED = {
  usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] },
}

/** The canvas item the tests below deploy: MFA trusted, inbound B2B blocked. */
function defaultItem(fields: Record<string, unknown> = {}) {
  return item('Cross-tenant defaults', {
    inboundTrustMfa: true,
    b2bCollaboration: JSON.stringify({ b2bCollaborationInbound: INBOUND_BLOCKED }),
    ...fields,
  })
}

/** The live singleton in the state that canvas item deploys to. */
function liveMatching(over: Record<string, unknown> = {}) {
  return {
    isServiceDefault: false,
    inboundTrust: {
      isMfaAccepted: true,
      isCompliantDeviceAccepted: false,
      isHybridAzureADJoinedDeviceAccepted: false,
    },
    automaticUserConsentSettings: { inboundAllowed: false, outboundAllowed: false },
    b2bCollaborationInbound: INBOUND_BLOCKED,
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([defaultItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect reports nothing when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([defaultItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed read reports no drift and writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(liveMatching())])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(vendorCalls(calls).length, 1, 'one read of the singleton is enough')
  } finally {
    restore()
  }
})

test('a device-trust flag turned on in the portal is drift, field by field', async () => {
  const { restore } = recordFetch([
    TOKEN,
    resource(
      liveMatching({
        inboundTrust: {
          isMfaAccepted: true,
          isCompliantDeviceAccepted: true,
          isHybridAzureADJoinedDeviceAccepted: false,
        },
      }),
    ),
  ])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'inboundTrust.isCompliantDeviceAccepted',
        expected: 'false',
        actual: 'true',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an inboundTrust block missing altogether reads as no trust, not as a match', async () => {
  const { restore } = recordFetch([TOKEN, resource(liveMatching({ inboundTrust: null }))])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    const diff = result.diffs.find((d) => d.field === 'inboundTrust.isMfaAccepted')
    assert.ok(diff, 'the declared MFA trust is simply not in effect')
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('inbound B2B collaboration re-opened in the portal surfaces as a diff', async () => {
  const reopened = {
    usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] },
  }
  const { restore } = recordFetch([
    TOKEN,
    resource(liveMatching({ b2bCollaborationInbound: reopened })),
  ])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'b2bCollaborationInbound',
        expected: JSON.stringify(INBOUND_BLOCKED),
        actual: JSON.stringify(reopened),
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a declared b2b block that is absent live reads as null, not as absent drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    resource(liveMatching({ b2bCollaborationInbound: undefined })),
  ])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    const diff = result.diffs.find((d) => d.field === 'b2bCollaborationInbound')
    assert.ok(diff)
    assert.equal(diff.actual, 'null')
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('key order inside a b2b block is not drift', async () => {
  // canonical() sorts keys, so a portal round-trip that reorders them must not
  // raise drift an operator can never clear.
  const reordered = {
    usersAndGroups: { targets: [{ targetType: 'user', target: 'AllUsers' }], accessType: 'blocked' },
  }
  const { restore } = recordFetch([
    TOKEN,
    resource(liveMatching({ b2bCollaborationInbound: reordered })),
  ])
  try {
    const result = await driftDetect(driftContext([defaultItem()]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('auto-consent changed live is deliberately not reported', async () => {
  // deploy can never write it on the default policy, so reporting it would be
  // drift no operator could ever clear.
  const { restore } = recordFetch([
    TOKEN,
    resource(liveMatching({ automaticUserConsentSettings: { inboundAllowed: true, outboundAllowed: true } })),
  ])
  try {
    const result = await driftDetect(driftContext([defaultItem({ autoConsentInbound: true })]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('an empty canvas is compared against nothing and reads the policy not at all', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

// The token exchange, imported under a local alias so the fixtures above read as
// "token, then the singleton".
import { TOKEN as TOKEN } from '../../../lib/__tests__/fakeGraph'
