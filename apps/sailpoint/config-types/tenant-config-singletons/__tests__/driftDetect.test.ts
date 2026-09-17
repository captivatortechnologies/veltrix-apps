// ============================================================================
// driftDetect for the ISC tenant configuration singletons.
//
// Each declared singleton is read on its own endpoint, so there is no listing to
// fail — and this handler gets the important part right: a singleton it could not
// read is reported as `unreadable` rather than passed over as in sync. Only the
// keys the canvas declares are compared, so the tenant keeping its own values for
// everything else is not drift.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  driftContext,
  iscError,
  leaksSecret,
  pathOf,
  recordFetch,
  resource,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import driftDetect from '../driftDetect'
import { PUT_PATH, PUT_SETTING, livePutConfig, putItem } from './fixtures'

test('tenant-config-singletons driftDetect: makes no ISC call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([putItem()], { credential: null }))

    assert.deepEqual(result.diffs, [])
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('tenant-config-singletons driftDetect: reports no drift when the declared keys match', async () => {
  // The live object also carries digitTokenEnabled and digitTokenLength, which
  // the canvas says nothing about. Undeclared keys are not drift.
  const { calls, restore } = recordFetch([TOKEN, resource(livePutConfig({ customInstructionsEnabled: true }))])
  try {
    const result = await driftDetect(driftContext([putItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    const iscCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(iscCalls.length, 1)
    assert.equal(pathOf(iscCalls[0]), PUT_PATH)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('tenant-config-singletons driftDetect: reports a declared key changed in the console', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(livePutConfig({ customInstructionsEnabled: false }))])
  try {
    const result = await driftDetect(driftContext([putItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${PUT_SETTING}.customInstructionsEnabled`)
    assert.ok(diff, `expected a diff for ${PUT_SETTING}.customInstructionsEnabled`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('tenant-config-singletons driftDetect: reports a singleton it could not read as unreadable', async () => {
  // "I could not look" is not "there is nothing wrong" — HANDLER-CORRECTNESS §3.
  const { calls, restore } = recordFetch([TOKEN, iscError(403, 'not authorized to read this configuration')])
  try {
    const result = await driftDetect(driftContext([putItem()]))

    const diff = result.diffs.find((d) => d.field === PUT_SETTING)
    assert.ok(diff, 'an unreadable singleton must be reported, not passed over')
    assert.equal(diff.expected, 'reachable')
    assert.equal(diff.actual, 'unreadable')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('tenant-config-singletons driftDetect: skips a setting whose declared config is not JSON', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await driftDetect(driftContext([putItem({ config: '{not json' })]))

    assert.deepEqual(result.diffs, [])
    assert.equal(calls.length, 0, 'an unparseable desired value gives nothing to compare against')
  } finally {
    restore()
  }
})
