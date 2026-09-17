// ============================================================================
// driftDetect for the Entra authentication flows policy, against a fake Graph.
//
// Somebody turning self-service sign-up back on in the portal re-opens external
// self-registration without touching any policy this app deployed. That is the
// single thing this detector exists to catch, so both directions of the flip
// are pinned here, field, expected, actual and severity.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

function flowsItem(fields: Record<string, unknown> = {}) {
  return item('Authentication flows', fields)
}

function livePolicy(isEnabled: boolean) {
  return { id: 'authenticationFlowsPolicy', selfServiceSignUp: { isEnabled } }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: true })], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: true })], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('nothing deployed means nothing to compare — no Graph call is made', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a failed read reports no drift and, crucially, writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live singleton matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(livePolicy(true))])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'GET')
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('self-service sign-up re-enabled out of band is drift', async () => {
  // The canvas deployed it off; somebody turned it back on in the portal.
  const { restore } = recordFetch([TOKEN, resource(livePolicy(true))])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: false })]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.length, 1)
    assert.deepEqual(result.diffs[0], {
      field: 'selfServiceSignUp.isEnabled',
      expected: 'false',
      actual: 'true',
      severity: 'warning',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('self-service sign-up switched off out of band is drift too', async () => {
  const { restore } = recordFetch([TOKEN, resource(livePolicy(false))])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    assert.deepEqual(result.diffs[0], {
      field: 'selfServiceSignUp.isEnabled',
      expected: 'true',
      actual: 'false',
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('a singleton that reports no selfServiceSignUp facet is read as disabled, not as unknown', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'authenticationFlowsPolicy' })])
  try {
    const result = await driftDetect(driftContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    assert.deepEqual(result.diffs[0], {
      field: 'selfServiceSignUp.isEnabled',
      expected: 'true',
      actual: 'false',
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not the edited one still on the canvas', async () => {
  // The canvas has been edited to disable sign-up but not deployed; the live
  // tenant still matches what was actually deployed, so there is no drift.
  const { restore } = recordFetch([TOKEN, resource(livePolicy(true))])
  try {
    const result = await driftDetect(
      driftContext([flowsItem({ selfServiceSignUpEnabled: false })], {
        deployedItems: [flowsItem({ selfServiceSignUpEnabled: true })],
      }),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})
