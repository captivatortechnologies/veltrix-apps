// ============================================================================
// driftDetect for home realm discovery policies, against a fake Microsoft Graph.
//
// A definition edited in the portal changes where users authenticate, and an
// isOrganizationDefault flipped on applies that to the whole tenant — both have
// to surface. The definition is compared key-order-insensitively (Graph returns
// it as a JSON string and does not preserve the author's key order), so an
// equivalent definition must NOT read as perpetual drift.
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

const LIST = /\/policies\/homeRealmDiscoveryPolicies\?\$select=/
const APPLIES_TO = /\/policies\/homeRealmDiscoveryPolicies\/[^/]+\/appliesTo/
const APPS = /\/applications\?\$select=id,displayName/
const SPS = /\/servicePrincipals\?\$select=id,displayName/

const SP_ID = '7c1f0a3e-5d92-4b18-9c6a-2f3e8b7d4a15'
const DEFINITION = JSON.stringify({
  HomeRealmDiscoveryPolicy: { AccelerateToFederatedDomain: true, PreferredDomain: 'contoso.com' },
})

function hrdItem(fields: Record<string, unknown> = {}) {
  return item('Accelerate Contoso', { name: 'Accelerate Contoso', definition: DEFINITION, ...fields })
}

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'hrd-1',
    displayName: 'Accelerate Contoso',
    definition: [DEFINITION],
    isOrganizationDefault: false,
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([hrdItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect reports nothing when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([hrdItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [], 'a listing that failed is not evidence the policy is gone')
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a policy deleted in the portal is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Accelerate Contoso', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a definition rewritten in the portal surfaces with both JSON bodies', async () => {
  const edited = JSON.stringify({
    HomeRealmDiscoveryPolicy: { AccelerateToFederatedDomain: true, PreferredDomain: 'fabrikam.com' },
  })
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [edited] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Accelerate Contoso.definition',
        expected: '{"HomeRealmDiscoveryPolicy":{"AccelerateToFederatedDomain":true,"PreferredDomain":"contoso.com"}}',
        actual: '{"HomeRealmDiscoveryPolicy":{"AccelerateToFederatedDomain":true,"PreferredDomain":"fabrikam.com"}}',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('the policy made the organization default outside the canvas is its own diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ isOrganizationDefault: true })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Accelerate Contoso.isOrganizationDefault',
        expected: 'false',
        actual: 'true',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('the same definition with its keys in another order is not drift', async () => {
  const reordered = JSON.stringify({
    HomeRealmDiscoveryPolicy: { PreferredDomain: 'contoso.com', AccelerateToFederatedDomain: true },
  })
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [reordered] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    assert.deepEqual(result.diffs, [], 'an equivalent definition must not be drift no operator can clear')
  } finally {
    restore()
  }
})

test('a policy whose definition was emptied live reads as an empty definition', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem()]))

    const diff = result.diffs.find((d) => d.field === 'Accelerate Contoso.definition')
    assert.ok(diff)
    assert.equal(diff.actual, '', 'an unparseable/absent definition is reported, not silently matched')
  } finally {
    restore()
  }
})

test('a declared assignment removed from the service principal is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([{ id: SP_ID, displayName: 'Contoso Portal' }]) },
    { url: APPS, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem({ appliesTo: ['Contoso Portal'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Accelerate Contoso.appliesTo',
        expected: JSON.stringify([SP_ID]),
        actual: JSON.stringify([]),
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an extra assignment made by hand is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([{ id: SP_ID, displayName: 'Contoso Portal' }]) },
    { url: APPS, respond: collection([]) },
    {
      url: APPLIES_TO,
      respond: collection([
        { id: SP_ID, '@odata.type': '#microsoft.graph.servicePrincipal' },
        { id: 'sp-someone-else', '@odata.type': '#microsoft.graph.servicePrincipal' },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem({ appliesTo: [SP_ID] })]))

    assert.deepEqual(result.diffs, [], 'this app never detaches what it did not attach, so extras are not its drift')
  } finally {
    restore()
  }
})

test('an appliesTo name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: SPS, respond: collection([]) },
    { url: APPS, respond: collection([]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([hrdItem({ appliesTo: ['Ghost App'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Accelerate Contoso.appliesTo',
        expected: 'resolvable',
        actual: 'unknown target(s): Ghost App',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an unsaved edit', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([hrdItem({ isOrganizationDefault: true })], { deployedItems: [hrdItem()] }),
    )

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
