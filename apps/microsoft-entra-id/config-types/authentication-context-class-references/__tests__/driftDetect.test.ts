// ============================================================================
// driftDetect for Conditional Access authentication contexts, against a fake Graph.
//
// A context flipped to unavailable, or deleted outright, does not break anything
// loudly — the Conditional Access policy that guards it simply stops being
// selectable and the step-up stops being asked for. That silence is exactly why
// the absent/present diff and the isAvailable diff are pinned here.
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

function contextItem(fields: Record<string, unknown> = {}) {
  return item('High risk step-up', {
    contextId: 'c3',
    displayName: 'High risk step-up',
    description: 'Requires phishing-resistant MFA',
    isAvailable: true,
    ...fields,
  })
}

function liveContext(over: Record<string, unknown> = {}) {
  return {
    id: 'c3',
    displayName: 'High risk step-up',
    description: 'Requires phishing-resistant MFA',
    isAvailable: true,
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([contextItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([contextItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and, crucially, writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live context matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveContext()])])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'GET')
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('a context deleted out of band is critical drift', async () => {
  const { restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'c3',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a context switched to unavailable in the portal surfaces as drift', async () => {
  // Unavailable means no Conditional Access policy can select it any more, so
  // the step-up it guards quietly stops being enforced.
  const { restore } = recordFetch([TOKEN, collection([liveContext({ isAvailable: false })])])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    const diff = result.diffs.find((d) => d.field === 'c3.isAvailable')
    assert.ok(diff)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('a renamed context surfaces as drift on displayName', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveContext({ displayName: 'Something else' })])])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    assert.deepEqual(result.diffs[0], {
      field: 'c3.displayName',
      expected: 'High risk step-up',
      actual: 'Something else',
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('a description cleared out of band surfaces as drift, empty string and all', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveContext({ description: null })])])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    const diff = result.diffs.find((d) => d.field === 'c3.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'Requires phishing-resistant MFA')
    assert.equal(diff.actual, '')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('several edits to one context each produce their own diff', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([liveContext({ displayName: 'Renamed', isAvailable: false })]),
  ])
  try {
    const result = await driftDetect(driftContext([contextItem()]))

    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['c3.displayName', 'c3.isAvailable'],
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an edit that has not been deployed yet', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveContext()])])
  try {
    const result = await driftDetect(
      driftContext([contextItem({ displayName: 'Draft rename' })], { deployedItems: [contextItem()] }),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})
