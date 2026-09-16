// ============================================================================
// driftDetect for the Entra security-defaults enforcement policy.
//
// Security defaults being toggled in the portal is a tenant-wide authentication
// change in both directions: switched ON it disables every Conditional Access
// policy, switched OFF it removes baseline MFA. Both directions must surface,
// and a drift run must never write or claim a conclusion it could not read.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

function defaultsItem(isEnabled: unknown) {
  return item('Security Defaults', { isEnabled })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([defaultsItem(true)], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('nothing deployed means nothing to compare — and no Graph call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([], { deployedItems: [] }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed read reports no drift and writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await driftDetect(driftContext([defaultsItem(true)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live singleton matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({ id: 'sd-1', isEnabled: true })])
  try {
    const result = await driftDetect(driftContext([defaultsItem(true)]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('security defaults switched ON in the portal is drift', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'sd-1', isEnabled: true })])
  try {
    const result = await driftDetect(driftContext([defaultsItem(false)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'isEnabled', expected: 'false', actual: 'true', severity: 'warning' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted by the platform — they must not carry the token')
  } finally {
    restore()
  }
})

test('security defaults switched OFF in the portal is drift', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'sd-1', isEnabled: false })])
  try {
    const result = await driftDetect(driftContext([defaultsItem(true)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'isEnabled', expected: 'true', actual: 'false', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('a live payload missing isEnabled is read as disabled, not as "matches"', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'sd-1' })])
  try {
    const result = await driftDetect(driftContext([defaultsItem(true)]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].actual, 'false')
  } finally {
    restore()
  }
})
