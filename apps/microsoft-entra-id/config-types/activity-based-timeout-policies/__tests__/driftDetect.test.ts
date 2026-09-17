// ============================================================================
// driftDetect for Entra activity based timeout policies, against a fake Graph.
//
// The definition is JSON stored as text, so the comparison has to see past key
// order — otherwise a policy Graph round-tripped would read as drift forever and
// the real edits (an idle timeout stretched, a policy made the org default) would
// be lost in the noise. Both the tolerance and the real drifts are pinned here.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const ONE_HOUR =
  '{"ActivityBasedTimeoutPolicy":{"Version":1,"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"01:00:00"}]}}'
/** The same policy, keys emitted in a different order — semantically identical. */
const ONE_HOUR_REORDERED =
  '{"ActivityBasedTimeoutPolicy":{"ApplicationPolicies":[{"WebSessionIdleTimeout":"01:00:00","ApplicationId":"default"}],"Version":1}}'
const EIGHT_HOURS =
  '{"ActivityBasedTimeoutPolicy":{"Version":1,"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"08:00:00"}]}}'

/** Canonical (key-sorted) renderings, as the diff reports them. */
const ONE_HOUR_CANONICAL =
  '{"ActivityBasedTimeoutPolicy":{"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"01:00:00"}],"Version":1}}'
const EIGHT_HOURS_CANONICAL =
  '{"ActivityBasedTimeoutPolicy":{"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"08:00:00"}],"Version":1}}'

function timeoutItem(fields: Record<string, unknown> = {}) {
  return item('Kiosk timeout', { name: 'Kiosk timeout', definition: ONE_HOUR, ...fields })
}

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'Kiosk timeout',
    definition: [ONE_HOUR],
    isOrganizationDefault: false,
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([timeoutItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([timeoutItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and, crucially, writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePolicy()])])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'GET')
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('the same definition with its keys in a different order is not drift', async () => {
  // Graph is free to re-serialise the JSON text; a textual compare would raise
  // permanent false drift and drown the real edits.
  const { restore } = recordFetch([TOKEN, collection([livePolicy({ definition: [ONE_HOUR_REORDERED] })])])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('a policy deleted out of band is critical drift', async () => {
  const { restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Kiosk timeout',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an idle timeout stretched from one hour to eight surfaces as drift', async () => {
  const { restore } = recordFetch([TOKEN, collection([livePolicy({ definition: [EIGHT_HOURS] })])])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    assert.deepEqual(result.diffs[0], {
      field: 'Kiosk timeout.definition',
      expected: ONE_HOUR_CANONICAL,
      actual: EIGHT_HOURS_CANONICAL,
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('a policy promoted to organization default out of band surfaces as drift', async () => {
  // Promoting a policy changes the session lifetime for every application in
  // the tenant at once, without touching any other object.
  const { restore } = recordFetch([TOKEN, collection([livePolicy({ isOrganizationDefault: true })])])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    assert.deepEqual(result.diffs[0], {
      field: 'Kiosk timeout.isOrganizationDefault',
      expected: 'false',
      actual: 'true',
      severity: 'warning',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('both a rewritten definition and a flipped default are reported, not just the first', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([livePolicy({ definition: [EIGHT_HOURS], isOrganizationDefault: true })]),
  ])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['Kiosk timeout.definition', 'Kiosk timeout.isOrganizationDefault'],
    )
  } finally {
    restore()
  }
})

test('a live policy whose definition array is empty reports an empty actual, not a crash', async () => {
  const { restore } = recordFetch([TOKEN, collection([livePolicy({ definition: [] })])])
  try {
    const result = await driftDetect(driftContext([timeoutItem()]))

    const diff = result.diffs.find((d) => d.field === 'Kiosk timeout.definition')
    assert.ok(diff)
    assert.equal(diff.expected, ONE_HOUR_CANONICAL)
    assert.equal(diff.actual, '')
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an edit that has not been deployed yet', async () => {
  const { restore } = recordFetch([TOKEN, collection([livePolicy({ definition: [EIGHT_HOURS] })])])
  try {
    const result = await driftDetect(
      driftContext([timeoutItem()], { deployedItems: [timeoutItem({ definition: EIGHT_HOURS })] }),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})
