// ============================================================================
// deploy for cross-tenant access PARTNER configurations, against a fake Graph.
//
// A partner configuration is a per-tenant exception to the default policy: it
// names one outside directory and says what that directory's users get here —
// whether B2B collaboration and direct connect are allowed inbound, whether its
// MFA claim is trusted in place of this tenant's, whether its users are consented
// to automatically. The identity of the object IS the partner tenant id, so the
// assertions below are about which tenant id was addressed and exactly what was
// sent for it: a config applied to the wrong partner is a door opened for the
// wrong organisation.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/policies/crossTenantAccessPolicy/partners'
const PARTNER = 'c4f8a5d2-1b3e-4a7c-9d6f-8e2b5c1a0f77'
const OTHER_PARTNER = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

/** A configuration that blocks inbound collaboration and trusts nothing. */
const LOCKED_DOWN = {
  b2bCollaborationInbound: {
    usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] },
  },
  inboundTrust: {
    isMfaAccepted: false,
    isCompliantDeviceAccepted: false,
    isHybridAzureADJoinedDeviceAccepted: false,
  },
}

function partnerItem(configuration: unknown = LOCKED_DOWN, tenantId = PARTNER) {
  return item('Contoso', {
    tenantId,
    configuration: typeof configuration === 'string' ? configuration : JSON.stringify(configuration),
  })
}

/** The live partner as Graph returns it: wide open, everything trusted. */
function livePartner(over: Record<string, unknown> = {}) {
  return {
    tenantId: PARTNER,
    b2bCollaborationInbound: {
      usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] },
    },
    inboundTrust: {
      isMfaAccepted: true,
      isCompliantDeviceAccepted: true,
      isHybridAzureADJoinedDeviceAccepted: false,
    },
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([partnerItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([partnerItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed partner listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list cross-tenant partners/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live partners must not create or patch one',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates a partner that does not exist and configures it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ tenantId: PARTNER }), NO_CONTENT])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET')

    const post = graphCalls[1]
    assert.equal(post.method, 'POST')
    assert.ok(post.url.endsWith(BASE))
    assert.deepEqual(bodyOf(post), { tenantId: PARTNER }, 'the partner is created by tenant id alone')

    const patch = graphCalls[2]
    assert.equal(patch.method, 'PATCH')
    assert.ok(patch.url.endsWith(`${BASE}/${PARTNER}`), `settings went to ${patch.url}`)
    // The exact access decision on the wire — blocked stays blocked, and no
    // trust flag is set that the canvas did not ask for.
    assert.deepEqual(bodyOf(patch), LOCKED_DOWN)

    assert.equal(result.success, true)
    assert.match(String(result.message), /Deployed 1 cross-tenant partner/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a newly created partner is recorded as app-created, with no prior state', async () => {
  const { restore } = recordFetch([TOKEN, collection([]), created({ tenantId: PARTNER }), NO_CONTENT])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: PARTNER, existed: false, id: PARTNER }])
  } finally {
    restore()
  }
})

test('deploy updates a partner that already exists, without creating it again', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing partner is patched, never re-created')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/${PARTNER}`))
    assert.deepEqual(bodyOf(writes[0]), LOCKED_DOWN)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior values of the keys it overwrites, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, PARTNER)
    // Exactly the tenant's own values for the two keys this deploy touched —
    // the open access and the MFA trust that rollback has to be able to put back.
    assert.deepEqual(entries[0].prior, {
      b2bCollaborationInbound: livePartner().b2bCollaborationInbound,
      inboundTrust: livePartner().inboundTrust,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writeCalls(calls)[0]))
  } finally {
    restore()
  }
})

test('a key the canvas does not declare is not snapshotted and not sent', async () => {
  const onlyTrust = { inboundTrust: { isMfaAccepted: false, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: false } }
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([partnerItem(onlyTrust)]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), onlyTrust, 'an undeclared block is left as the tenant has it')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(Object.keys(entries[0].prior as Record<string, unknown>), ['inboundTrust'])
  } finally {
    restore()
  }
})

test('a live key that is absent is snapshotted as null, so rollback knows it was unset', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([{ tenantId: PARTNER }]),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries[0].prior, { b2bCollaborationInbound: null, inboundTrust: null })
  } finally {
    restore()
  }
})

test('an existing partner declared with no settings at all is not written to', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner()])])
  try {
    const result = await deploy(deployContext([partnerItem({})]))

    assert.equal(writeCalls(calls).length, 0, 'an empty configuration must not blank the partner out')
    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries[0].prior, {})
  } finally {
    restore()
  }
})

test('unparseable configuration JSON patches nothing rather than sending a broken body', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner()])])
  try {
    const result = await deploy(deployContext([partnerItem('{ not json')]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a partner is matched case-insensitively, so one tenant is never configured twice', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner({ tenantId: PARTNER.toUpperCase() })]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([partnerItem(LOCKED_DOWN, PARTNER.toUpperCase())]))

    const writes = writeCalls(calls)
    assert.equal(writes.filter((c) => c.method === 'POST').length, 0, 'the same tenant in a different case is the same partner')
    assert.equal(writes[0].method, 'PATCH')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing, and still records what succeeded', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'Tenant is not a valid Azure AD tenant.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some cross-tenant partners failed/)
    assert.match(String(result.message), /not a valid Azure AD tenant/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected settings PATCH fails the item without recording it as deployed', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([livePartner()]),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([partnerItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.deepEqual(
      (result.rollbackData as { entries: unknown[] }).entries,
      [],
      'an item that failed must not leave rollback state claiming it was applied',
    )
  } finally {
    restore()
  }
})

test('deploy deletes a partner it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: PARTNER, existed: false, id: PARTNER },
            { name: OTHER_PARTNER, existed: true, id: OTHER_PARTNER, prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'a partner that pre-dated this app must survive the reconcile')
    assert.ok(deletes[0].url.endsWith(`${BASE}/${PARTNER}`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a partner still declared is not deleted by the reconcile', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePartner()]), NO_CONTENT])
  try {
    await deploy(
      deployContext([partnerItem()], {
        priorRollbackData: { entries: [{ name: PARTNER, existed: false, id: PARTNER }] },
      }),
    )

    assert.equal(writeCalls(calls).filter((c) => c.method === 'DELETE').length, 0)
  } finally {
    restore()
  }
})

test('a 404 while deleting a partner already gone is not a failure', async () => {
  const { restore } = recordFetch([TOKEN, collection([]), graphError(404, 'Resource not found', 'Request_ResourceNotFound')])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: { entries: [{ name: PARTNER, existed: false, id: PARTNER }] },
      }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an item with no tenant id is skipped entirely', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([item('Unnamed', { configuration: JSON.stringify(LOCKED_DOWN) })]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, 'a configuration with no partner to apply it to goes nowhere')
    assert.equal(vendorCalls(calls).length, 1)
  } finally {
    restore()
  }
})
