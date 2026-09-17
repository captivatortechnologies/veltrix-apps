// ============================================================================
// driftDetect for self-service sign-up (b2x) user flows, against a fake Graph.
//
// The flow itself is nearly inert; what matters is what is attached to it — the
// identity providers an outsider may sign up with, and the attributes the flow
// collects. A declared provider that is no longer on the flow is drift; an extra
// one somebody added by hand is not (this app never removes what it did not
// add). A declared provider that no longer RESOLVES at all is critical: the
// handler cannot tell present from absent, and must say so rather than pass.
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

const FLOWS = /\/identity\/b2xUserFlows\?\$select=id/
const IDP_MAP = /\/identity\/identityProviders\?\$select=/
const ATTR_MAP = /\/identity\/userFlowAttributes\?\$select=/
const FLOW_IDPS = /\/b2xUserFlows\/[^/]+\/identityProviders/
const FLOW_ATTRS = /\/b2xUserFlows\/[^/]+\/userAttributeAssignments/

const FLOW_ID = 'B2X_1_Partner'
const FACEBOOK = 'Facebook-OAUTH'
const CITY = 'city'

function flowItem(fields: Record<string, unknown> = {}) {
  return item('Partner sign-up', { id: 'Partner', userFlowTypeVersion: 1, ...fields })
}

/** The identity providers and attributes that exist in the directory. */
const CATALOG = [
  { url: IDP_MAP, respond: collection([{ id: FACEBOOK, displayName: 'Facebook' }]) },
  { url: ATTR_MAP, respond: collection([{ id: CITY, displayName: 'City', dataType: 'string' }]) },
]

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([flowItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect reports nothing when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([flowItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed flow listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: FLOWS, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([flowItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [], 'a listing that failed is not evidence the flow is gone')
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live flow matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([{ id: FACEBOOK }]) },
    { url: FLOW_ATTRS, respond: collection([{ id: CITY }]) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(
      driftContext([flowItem({ identityProviders: [FACEBOOK], attributes: [CITY] })]),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a flow deleted in the portal is critical drift, under its prefixed id', async () => {
  const { restore } = routeFetch([{ url: FLOWS, respond: collection([]) }, ...CATALOG])
  try {
    const result = await driftDetect(driftContext([flowItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      // Graph prefixes the caller's id with B2X_1_, which is the real identity.
      { field: FLOW_ID, expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a declared identity provider removed from the flow is drift', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(driftContext([flowItem({ identityProviders: [FACEBOOK] })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${FLOW_ID}.identityProviders`,
        expected: JSON.stringify([FACEBOOK]),
        actual: JSON.stringify([]),
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('an extra identity provider added by hand is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([{ id: FACEBOOK }, { id: 'Google-OAUTH' }]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(driftContext([flowItem({ identityProviders: [FACEBOOK] })]))

    assert.deepEqual(result.diffs, [], 'this app never removes what it did not add, so extras are not its drift')
  } finally {
    restore()
  }
})

test('a declared attribute no longer collected by the flow is drift', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(driftContext([flowItem({ attributes: ['City'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${FLOW_ID}.attributes`,
        // The declared display name resolves to the attribute's real id first.
        expected: JSON.stringify([CITY]),
        actual: JSON.stringify([]),
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an identity provider that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    { url: IDP_MAP, respond: collection([]) },
    { url: ATTR_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([flowItem({ identityProviders: ['Ghost-OAUTH'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${FLOW_ID}.identityProviders`,
        expected: 'resolvable',
        actual: 'unknown identity provider(s): Ghost-OAUTH',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})

test('an attribute that no longer resolves is critical drift too', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    { url: IDP_MAP, respond: collection([]) },
    { url: ATTR_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([flowItem({ attributes: ['Ghost attribute'] })]))

    const diff = result.diffs.find((d) => d.field === `${FLOW_ID}.attributes`)
    assert.ok(diff)
    assert.equal(diff.severity, 'critical')
    assert.match(String(diff.actual), /Ghost attribute/)
  } finally {
    restore()
  }
})

test('a flow listed under a differently-cased id is still matched', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID.toLowerCase() }]) },
    { url: FLOW_IDPS, respond: collection([]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(driftContext([flowItem()]))

    assert.deepEqual(result.diffs, [], 'a case difference in the id is not a missing flow')
  } finally {
    restore()
  }
})

test('a failed assignment listing is not reported as a removed assignment', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: graphError(403, 'Insufficient privileges.') },
    { url: FLOW_ATTRS, respond: collection([CITY].map((id) => ({ id }))) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(
      driftContext([flowItem({ identityProviders: [FACEBOOK], attributes: [CITY] })]),
    )

    assert.deepEqual(result.diffs, [], 'a read that failed proves nothing about the assignment')
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an unsaved edit', async () => {
  const { restore } = routeFetch([
    { url: FLOWS, respond: collection([{ id: FLOW_ID }]) },
    { url: FLOW_IDPS, respond: collection([]) },
    { url: FLOW_ATTRS, respond: collection([]) },
    ...CATALOG,
  ])
  try {
    const result = await driftDetect(
      driftContext([flowItem({ identityProviders: [FACEBOOK] })], { deployedItems: [flowItem()] }),
    )

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
