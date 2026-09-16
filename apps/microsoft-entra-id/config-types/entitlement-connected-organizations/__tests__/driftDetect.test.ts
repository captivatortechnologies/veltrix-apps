// ============================================================================
// driftDetect for Entra entitlement-management connected organizations, against
// a fake Microsoft Graph.
//
// The two drifts worth catching are both access drifts: an organization moved
// from "proposed" to "configured" in the portal joins the pool every
// allConfiguredConnectedOrganizationUsers policy grants to, and an identity
// source swapped underneath it points the whole organization at a DIFFERENT
// outside tenant. Both are reported as canonicalised JSON, so the assertions
// below parse the diff back and compare the actual structure.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
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

const LIST = /connectedOrganizations\?/

const PARTNER_SOURCE = {
  '@odata.type': '#microsoft.graph.azureActiveDirectoryTenant',
  tenantId: 'aaaabbbb-0000-cccc-1111-dddd2222eeee',
  displayName: 'Contoso',
}

const IMPOSTOR_SOURCE = {
  '@odata.type': '#microsoft.graph.azureActiveDirectoryTenant',
  tenantId: '99999999-9999-9999-9999-999999999999',
  displayName: 'Not Contoso',
}

function liveOrg(over: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    displayName: 'Contoso',
    description: 'Contoso partner tenant',
    state: 'configured',
    identitySources: [PARTNER_SOURCE],
    ...over,
  }
}

function orgItem(fields: Record<string, unknown> = {}) {
  return item('Contoso', {
    name: 'Contoso',
    description: 'Contoso partner tenant',
    state: 'configured',
    identitySources: JSON.stringify([PARTNER_SOURCE]),
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([orgItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([orgItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live organization matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([liveOrg()]) }])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted organization is critical present/absent drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Contoso', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('an organization demoted to "proposed" in the portal surfaces as a state diff', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveOrg({ state: 'proposed' })]) }])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    assert.deepEqual(result.diffs, [
      { field: 'Contoso.state', expected: 'configured', actual: 'proposed', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('an identity source swapped for a different tenant surfaces with both sides intact', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveOrg({ identitySources: [IMPOSTOR_SOURCE] })]) },
  ])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.length, 1)
    const diff = result.diffs[0]
    assert.equal(diff.field, 'Contoso.identitySources')
    assert.equal(diff.severity, 'warning')
    // Both sides are canonicalised JSON — parse them back so the assertion is
    // about the structure rather than a key ordering.
    assert.deepEqual(JSON.parse(String(diff.expected)), [PARTNER_SOURCE])
    assert.deepEqual(JSON.parse(String(diff.actual)), [IMPOSTOR_SOURCE])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('an identity source removed entirely surfaces as an empty live array', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveOrg({ identitySources: [] })]) }])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    const diff = result.diffs.find((d) => d.field === 'Contoso.identitySources')
    assert.ok(diff)
    assert.deepEqual(JSON.parse(String(diff.actual)), [])
    assert.deepEqual(JSON.parse(String(diff.expected)), [PARTNER_SOURCE])
  } finally {
    restore()
  }
})

test('a description edited in the portal surfaces as its own diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveOrg({ description: 'Edited in the portal' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([orgItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Contoso.description',
        expected: 'Contoso partner tenant',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('drift is measured against the DEPLOYED canvas, not the edited one', async () => {
  // The canvas has since been edited to "proposed", but nothing has deployed
  // that — the live directory still matches what was last deployed.
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveOrg()]) }])
  try {
    const result = await driftDetect(
      driftContext([orgItem({ state: 'proposed' })], { deployedItems: [orgItem()] }),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
