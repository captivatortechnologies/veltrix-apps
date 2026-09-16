// ============================================================================
// deploy for the cross-tenant access DEFAULT policy, against a fake Graph.
//
// This object decides what every external tenant gets by default: whether their
// MFA claim is trusted here, whether their compliant/hybrid-joined device claim
// is trusted, and whether B2B collaboration and direct connect are allowed or
// blocked inbound and outbound. Nothing else in the tenant re-checks those
// decisions, so the assertions below are about the exact booleans on the wire —
// a trust flag set by accident silently accepts a partner's own MFA in place of
// this directory's.
//
// It is a tenant SINGLETON: no create, no delete, PATCH only. So the shape here
// is "read the live object, patch it, record the whole prior body" rather than
// the create/update/reconcile story the collection-shaped config types tell.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const PATH = '/policies/crossTenantAccessPolicy/default'

/**
 * The live singleton as Graph returns it — an untouched tenant that trusts
 * nothing from outside and allows B2B collaboration inbound.
 */
const LIVE_DEFAULT = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#policies/crossTenantAccessPolicy/default/$entity',
  isServiceDefault: true,
  inboundTrust: {
    isMfaAccepted: false,
    isCompliantDeviceAccepted: false,
    isHybridAzureADJoinedDeviceAccepted: false,
  },
  automaticUserConsentSettings: { inboundAllowed: false, outboundAllowed: false },
  b2bCollaborationInbound: {
    usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] },
    applications: { accessType: 'allowed', targets: [{ target: 'AllApplications', targetType: 'application' }] },
  },
}

function defaultItem(fields: Record<string, unknown> = {}) {
  return item('Cross-tenant defaults', fields)
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([defaultItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this fails closed BEFORE any network call rather than half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([defaultItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed read of the singleton stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([defaultItem({ inboundTrustMfa: true })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to read cross-tenant default policy/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live policy must not patch it blind',
    )
  } finally {
    restore()
  }
})

test('deploy reads the singleton before it writes it, authenticating first', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    const result = await deploy(deployContext([defaultItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2, 'exactly one read and one write on a singleton')
    assert.equal(graphCalls[0].method, 'GET')
    assert.ok(graphCalls[0].url.endsWith(PATH))
    assert.equal(graphCalls[1].method, 'PATCH', 'the singleton is updated, never created')
    assert.ok(graphCalls[1].url.endsWith(PATH))
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a canvas that asks for nothing grants no inbound trust at all', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    await deploy(deployContext([defaultItem()]))

    // The whole body, not a field probe: this is what proves no trust flag and no
    // access block is set by omission.
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {
      inboundTrust: {
        isMfaAccepted: false,
        isCompliantDeviceAccepted: false,
        isHybridAzureADJoinedDeviceAccepted: false,
      },
    })
  } finally {
    restore()
  }
})

test('inbound trust is granted only for the claims the canvas explicitly ticks', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    await deploy(
      deployContext([defaultItem({ inboundTrustMfa: true, inboundTrustHybridJoined: 'true' })]),
    )

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {
      inboundTrust: {
        isMfaAccepted: true,
        // Untick a claim and it must go out false, never be left to the tenant's
        // previous value by omission.
        isCompliantDeviceAccepted: false,
        isHybridAzureADJoinedDeviceAccepted: true,
      },
    })
  } finally {
    restore()
  }
})

test('the read-only auto-consent checkboxes never reach Graph', async () => {
  // automaticUserConsentSettings can only be set on a per-partner configuration.
  // Sending it here makes Graph reject the whole PATCH, dropping the valid
  // inboundTrust changes with it.
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([defaultItem({ autoConsentInbound: true, autoConsentOutbound: true })]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.equal(body.automaticUserConsentSettings, undefined)
    assert.deepEqual(Object.keys(body), ['inboundTrust'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('declared b2b blocks go out verbatim, with the exact allow/block value asked for', async () => {
  const blocks = {
    b2bCollaborationInbound: {
      usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] },
    },
    b2bDirectConnectInbound: {
      usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] },
    },
  }
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    await deploy(deployContext([defaultItem({ b2bCollaboration: JSON.stringify(blocks) })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.deepEqual(body.b2bCollaborationInbound, blocks.b2bCollaborationInbound)
    assert.deepEqual(body.b2bDirectConnectInbound, blocks.b2bDirectConnectInbound)
  } finally {
    restore()
  }
})

test('a key that is not a recognised b2b block is dropped rather than forwarded', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([
        defaultItem({
          b2bCollaboration: JSON.stringify({
            b2bCollaborationOutbound: { usersAndGroups: { accessType: 'blocked', targets: [] } },
            tenantRestrictions: { usersAndGroups: { accessType: 'allowed', targets: [] } },
          }),
        }),
      ]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.ok('b2bCollaborationOutbound' in body)
    assert.equal('tenantRestrictions' in body, false, 'only the four b2b block keys are managed here')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('unparseable b2b JSON sends the inboundTrust change alone, not a broken body', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    await deploy(deployContext([defaultItem({ inboundTrustMfa: true, b2bCollaboration: '{ not json' })]))

    assert.deepEqual(Object.keys(bodyOf(writeCalls(calls)[0]) ?? {}), ['inboundTrust'])
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior policy for rollback, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(LIVE_DEFAULT), NO_CONTENT])
  try {
    const result = await deploy(deployContext([defaultItem({ inboundTrustMfa: true })]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'the default policy always exists')
    assert.equal(entries[0].wasServiceDefault, true)
    // The whole prior body, exactly as the tenant had it.
    assert.deepEqual(entries[0].previousState, LIVE_DEFAULT)

    const sent = bodyOf(writeCalls(calls)[0])
    assert.notDeepEqual(entries[0].previousState, sent, 'rollback state must be the prior value, not the desired one')
    assert.deepEqual(
      (entries[0].previousState as typeof LIVE_DEFAULT).inboundTrust,
      { isMfaAccepted: false, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: false },
    )
  } finally {
    restore()
  }
})

test('a policy already moved off the system default is recorded as such', async () => {
  const { restore } = recordFetch([
    TOKEN,
    resource({ ...LIVE_DEFAULT, isServiceDefault: false }),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(deployContext([defaultItem({ inboundTrustMfa: true })]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // wasServiceDefault is what picks resetToSystemDefault over a restore PATCH.
    assert.equal(entries[0].wasServiceDefault, false)
  } finally {
    restore()
  }
})

test('deploy reports a rejected PATCH rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    resource(LIVE_DEFAULT),
    graphError(400, 'Property automaticUserConsentSettings is read-only.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([defaultItem({ inboundTrustMfa: true })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to update cross-tenant default policy/)
    assert.match(String(result.message), /read-only/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an empty canvas touches Graph not at all', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0, 'nothing declared means nothing read and nothing written')
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})
