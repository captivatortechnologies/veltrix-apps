// ============================================================================
// driftDetect for Entra entitlement-management access packages, against a fake
// Microsoft Graph.
//
// The drift that matters here is visibility: a package flipped from hidden to
// visible in the portal is one every user in the directory can suddenly browse
// and request. Drift records are persisted by the platform, so the handler must
// report that without ever writing to the directory and without carrying the
// access token into the diff.
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

const LIST = /accessPackages\?/
const CATALOG_GUID = '66584aae-98bb-48cc-9458-7bee5d2a6577'

function livePackage(over: Record<string, unknown> = {}) {
  return { id: 'ap-1', displayName: 'Sales reps', description: 'Outside sales', isHidden: true, ...over }
}

function packageItem(fields: Record<string, unknown> = {}) {
  return item('Sales reps', {
    name: 'Sales reps',
    catalogId: CATALOG_GUID,
    description: 'Outside sales',
    isHidden: true,
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([packageItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([packageItem()], { settings: {} }))

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
    const result = await driftDetect(driftContext([packageItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live package matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([livePackage()]) }])
  try {
    const result = await driftDetect(driftContext([packageItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted package is critical present/absent drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([packageItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Sales reps', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a package un-hidden in the portal is reported field by field', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([livePackage({ isHidden: false })]) }])
  try {
    const result = await driftDetect(driftContext([packageItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Sales reps.isHidden', expected: 'true', actual: 'false', severity: 'warning' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a description edited in the portal surfaces as its own diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePackage({ description: 'Edited in the portal' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([packageItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Sales reps.description',
        expected: 'Outside sales',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a package cleared of its description reports the empty live value, not a false match', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([livePackage({ description: null })]) }])
  try {
    const result = await driftDetect(driftContext([packageItem()]))

    const diff = result.diffs.find((d) => d.field === 'Sales reps.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'Outside sales')
    assert.equal(diff.actual, '')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('drift is measured against the DEPLOYED canvas, not the edited one', async () => {
  // The canvas has since been edited to "Rewritten", but nothing has deployed
  // it — the live directory still matches what was last deployed, so there is
  // no drift to report.
  const { restore } = routeFetch([{ url: LIST, respond: collection([livePackage()]) }])
  try {
    const result = await driftDetect(
      driftContext([packageItem({ description: 'Rewritten' })], { deployedItems: [packageItem()] }),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
