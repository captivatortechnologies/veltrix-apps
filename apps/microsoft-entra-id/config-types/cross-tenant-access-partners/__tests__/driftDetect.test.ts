// ============================================================================
// driftDetect for cross-tenant access PARTNER configurations, against a fake
// Graph.
//
// Two conclusions this handler must never reach by accident: "the partner is
// gone" when the listing simply failed, and "everything matches" when a declared
// block was quietly widened in the portal. Both are asserted below, along with
// the exact field/expected/actual/severity of the drifts it does report.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const PARTNERS = /\/policies\/crossTenantAccessPolicy\/partners/
const PARTNER = 'c4f8a5d2-1b3e-4a7c-9d6f-8e2b5c1a0f77'

const BLOCKED_INBOUND = {
  usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] },
}
const NO_TRUST = {
  isMfaAccepted: false,
  isCompliantDeviceAccepted: false,
  isHybridAzureADJoinedDeviceAccepted: false,
}

function partnerItem(configuration: Record<string, unknown> = { b2bCollaborationInbound: BLOCKED_INBOUND, inboundTrust: NO_TRUST }) {
  return item('Contoso', { tenantId: PARTNER, configuration: JSON.stringify(configuration) })
}

function livePartner(over: Record<string, unknown> = {}) {
  return { tenantId: PARTNER, b2bCollaborationInbound: BLOCKED_INBOUND, inboundTrust: NO_TRUST, ...over }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([partnerItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect reports nothing when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([partnerItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: PARTNERS, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [], 'a listing that failed is not evidence the partner is gone')
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live partner matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: PARTNERS, respond: collection([livePartner()]) }])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a partner configuration deleted in the portal is critical drift', async () => {
  const { restore } = routeFetch([{ url: PARTNERS, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: PARTNER, expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('inbound access re-opened for a partner surfaces with the exact values', async () => {
  const reopened = {
    usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] },
  }
  const { restore } = routeFetch([
    { url: PARTNERS, respond: collection([livePartner({ b2bCollaborationInbound: reopened })]) },
  ])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: `${PARTNER}.b2bCollaborationInbound`,
        expected: JSON.stringify(BLOCKED_INBOUND),
        actual: JSON.stringify(reopened),
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test("a partner's MFA claim trusted outside the canvas surfaces as its own diff", async () => {
  const trusted = { ...NO_TRUST, isMfaAccepted: true }
  const { restore } = routeFetch([{ url: PARTNERS, respond: collection([livePartner({ inboundTrust: trusted })]) }])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    const diff = result.diffs.find((d) => d.field === `${PARTNER}.inboundTrust`)
    assert.ok(diff)
    // Spelled out rather than re-stringified: the handler compares key-sorted
    // JSON, so this is the literal text an operator sees on the diff.
    assert.equal(
      diff.expected,
      '{"isCompliantDeviceAccepted":false,"isHybridAzureADJoinedDeviceAccepted":false,"isMfaAccepted":false}',
    )
    assert.equal(
      diff.actual,
      '{"isCompliantDeviceAccepted":false,"isHybridAzureADJoinedDeviceAccepted":false,"isMfaAccepted":true}',
    )
    assert.equal(diff.severity, 'warning')
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a declared block missing from the live partner reads as null, not as a match', async () => {
  const { restore } = routeFetch([
    { url: PARTNERS, respond: collection([{ tenantId: PARTNER, inboundTrust: NO_TRUST }]) },
  ])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    const diff = result.diffs.find((d) => d.field === `${PARTNER}.b2bCollaborationInbound`)
    assert.ok(diff)
    assert.equal(diff.actual, 'null')
  } finally {
    restore()
  }
})

test('key order inside a declared block is not drift', async () => {
  const reordered = {
    usersAndGroups: { targets: [{ targetType: 'user', target: 'AllUsers' }], accessType: 'blocked' },
  }
  const { restore } = routeFetch([
    { url: PARTNERS, respond: collection([livePartner({ b2bCollaborationInbound: reordered })]) },
  ])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a partner listed under a differently-cased tenant id is still matched', async () => {
  const { restore } = routeFetch([
    { url: PARTNERS, respond: collection([livePartner({ tenantId: PARTNER.toUpperCase() })]) },
  ])
  try {
    const result = await driftDetect(driftContext([partnerItem()]))

    assert.deepEqual(result.diffs, [], 'a case difference in a GUID is not a missing partner')
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an edited one still on the canvas', async () => {
  // deployedConfig is what was actually applied; an unsaved canvas edit is not
  // drift in the tenant.
  const { restore } = routeFetch([{ url: PARTNERS, respond: collection([livePartner()]) }])
  try {
    const result = await driftDetect(
      driftContext([partnerItem({ inboundTrust: { ...NO_TRUST, isMfaAccepted: true } })], {
        deployedItems: [partnerItem()],
      }),
    )

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
