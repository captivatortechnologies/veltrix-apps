// ============================================================================
// driftDetect for ISC MFA method configuration.
//
// Each declared method is read on its own singleton endpoint, so there is no
// listing to fail — and this handler gets the important part right: a config it
// could not read is reported as `unreadable`, not quietly as "in sync".
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
import { CONFIG_PATH, METHOD, inSyncConfig, mfaItem } from './fixtures'

test('mfa-configs driftDetect: makes no ISC call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([mfaItem()], { credential: null }))

    assert.deepEqual(result.diffs, [])
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('mfa-configs driftDetect: reports no drift when the live config matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(inSyncConfig())])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    const iscCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(iscCalls.length, 1)
    assert.equal(pathOf(iscCalls[0]), CONFIG_PATH)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('mfa-configs driftDetect: reports a method switched off in the console', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(inSyncConfig({ enabled: false }))])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${METHOD}.enabled`)
    assert.ok(diff, `expected a diff for ${METHOD}.enabled`)
    assert.equal(diff.actual, 'false')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('mfa-configs driftDetect: reports a re-pointed identity attribute', async () => {
  const { restore } = recordFetch([TOKEN, resource(inSyncConfig({ identityAttribute: 'personalEmail' }))])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assert.equal(result.hasDrift, true)
    assert.ok(result.diffs.some((d) => d.field === `${METHOD}.identityAttribute`))
  } finally {
    restore()
  }
})

test('mfa-configs driftDetect: reports a config it could not read as unreadable, not as in sync', async () => {
  // This is the distinction HANDLER-CORRECTNESS.md asks for: "I could not look"
  // is not "there is nothing wrong".
  const { calls, restore } = recordFetch([TOKEN, iscError(403, 'not authorized to read MFA configuration')])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    const diff = result.diffs.find((d) => d.field === METHOD)
    assert.ok(diff, 'an unreadable MFA config must be reported, not passed over')
    assert.equal(diff.actual, 'unreadable')
    assert.equal(diff.expected, 'present')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
