// ============================================================================
// driftDetect for the ISC entitlement governance overlay.
//
// Each declared entitlement is looked up on its own filtered query, and this
// handler makes the distinction HANDLER-CORRECTNESS.md §3 asks for: a lookup it
// could not read is reported as `unreadable`, a lookup that came back empty is
// reported as `absent`, and a lookup that came back with two is `ambiguous`.
// Those are three different answers and they are not interchangeable.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  driftContext,
  iscError,
  leaksSecret,
  listPage,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import driftDetect from '../driftDetect'
import { LABEL, entitlementItem, inSyncEntitlement, liveEntitlement, parentSource } from './fixtures'

test('entitlements driftDetect: makes no ISC call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([entitlementItem()], { credential: null }))

    assert.deepEqual(result.diffs, [])
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('entitlements driftDetect: makes no ISC call when nothing is declared', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0, 'an empty canvas has nothing to look up')
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports no drift when the overlay matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([parentSource()]), listPage([inSyncEntitlement()])])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assertAuthenticatedFirst(assert, calls)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports an entitlement made requestable in the console', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    listPage([inSyncEntitlement({ requestable: false, privileged: false })]),
  ])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    assert.equal(result.hasDrift, true)
    assert.ok(result.diffs.some((d) => d.field === `${LABEL}.requestable`))
    assert.ok(result.diffs.some((d) => d.field === `${LABEL}.privileged`))
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports an aggregation lock that was turned off', async () => {
  // With the lock off, the next aggregation silently overwrites the governed
  // display name or description from the source.
  const { restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    listPage([inSyncEntitlement({ manuallyUpdatedFields: { DISPLAY_NAME: false, DESCRIPTION: true } })]),
  ])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.lockDisplayName`)
    assert.ok(diff, 'a dropped aggregation lock must be reported')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports a lookup it could not read as unreadable, not as absent', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    iscError(403, 'not authorized to read entitlements'),
  ])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    const diff = result.diffs.find((d) => d.field === LABEL)
    assert.ok(diff, 'an unreadable lookup must be reported')
    assert.equal(diff.expected, 'reachable')
    assert.equal(diff.actual, 'unreadable')
    assert.notEqual(diff.actual, 'absent', 'an unreadable entitlement is not a deleted one')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports an entitlement the source no longer has', async () => {
  const { restore } = recordFetch([TOKEN, listPage([parentSource()]), listPage([])])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    assert.ok(diff)
    assert.equal(diff.actual, 'absent')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports an ambiguous match as ambiguous, not as in sync', async () => {
  const { restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    listPage([liveEntitlement(), liveEntitlement({ id: 'ent-other' })]),
  ])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    assert.ok(diff)
    assert.equal(diff.actual, 'ambiguous')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('entitlements driftDetect: reports the source itself being gone', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([])])
  try {
    const result = await driftDetect(driftContext([entitlementItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    assert.ok(diff)
    assert.equal(diff.actual, 'source absent')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
