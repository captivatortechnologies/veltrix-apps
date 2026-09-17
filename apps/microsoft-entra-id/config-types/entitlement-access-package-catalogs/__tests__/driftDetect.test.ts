// ============================================================================
// driftDetect for Entra entitlement-management access package catalogs, against
// a fake Microsoft Graph.
//
// Two of the three fields this handler diffs decide who can reach the packages
// inside the catalog: `state` (published makes them requestable at all) and
// `isExternallyVisible` (whether users outside the directory can request them).
// A catalog quietly published or externalised in the portal has to surface as a
// diff — and drift detection must reach that conclusion without writing.
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

const LIST = /entitlementManagement\/catalogs\?/

function liveCatalog(over: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    displayName: 'Sales',
    description: 'Sales entitlements',
    state: 'published',
    isExternallyVisible: false,
    catalogType: 'userManaged',
    ...over,
  }
}

function catalogItem(fields: Record<string, unknown> = {}) {
  return item('Sales', {
    name: 'Sales',
    description: 'Sales entitlements',
    state: 'published',
    isExternallyVisible: false,
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([catalogItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([catalogItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
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
    const result = await driftDetect(driftContext([catalogItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live catalog matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([liveCatalog()]) }])
  try {
    const result = await driftDetect(driftContext([catalogItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted catalog is critical present/absent drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([catalogItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Sales', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a catalog opened to external users in the portal surfaces as a diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveCatalog({ isExternallyVisible: true })]) },
  ])
  try {
    const result = await driftDetect(driftContext([catalogItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Sales.isExternallyVisible', expected: 'false', actual: 'true', severity: 'warning' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a catalog unpublished in the portal surfaces as a state diff', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveCatalog({ state: 'unpublished' })]) }])
  try {
    const result = await driftDetect(driftContext([catalogItem()]))

    assert.deepEqual(result.diffs, [
      { field: 'Sales.state', expected: 'published', actual: 'unpublished', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('every drifted field is reported, in the handler’s documented order', async () => {
  const { restore } = routeFetch([
    {
      url: LIST,
      respond: collection([
        liveCatalog({ state: 'unpublished', isExternallyVisible: true, description: 'Edited in the portal' }),
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([catalogItem()]))

    assert.deepEqual(result.diffs, [
      { field: 'Sales.state', expected: 'published', actual: 'unpublished', severity: 'warning' },
      { field: 'Sales.isExternallyVisible', expected: 'false', actual: 'true', severity: 'warning' },
      {
        field: 'Sales.description',
        expected: 'Sales entitlements',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('drift is measured against the DEPLOYED canvas, not the edited one', async () => {
  // The canvas has since been edited to publish the catalog externally, but
  // nothing has deployed that — the live directory still matches what was last
  // deployed, so there is no drift.
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveCatalog()]) }])
  try {
    const result = await driftDetect(
      driftContext([catalogItem({ isExternallyVisible: true })], { deployedItems: [catalogItem()] }),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
