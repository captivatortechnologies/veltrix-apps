// healthCheck for cloud-suppression-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared rule must still resolve
// through the suppression-rules id query — which caps its page size at 50, not
// the adapter's usual 500 — reported as `suppression-rule:<name>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  idsPage,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'cloud-suppression-rules',
  handler: healthCheck,
  probePath: '/cloud-policies/queries/suppression-rules/v1',
  scopePattern: /Cloud security suppression rules: Read/,
})

const RULE = item('Sandbox noise', {
  name: 'suppress-sandbox-noise',
  ruleSeverities: 'medium, low',
  scopeType: 'account',
  accountIds: '111122223333',
})

const LIVE = { id: 'sup-live-1', name: 'suppress-sandbox-noise' }

test('cloud-suppression-rules healthCheck: passes when every declared rule is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['sup-live-1']), entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'suppression-rule:suppress-sandbox-noise')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules healthCheck: asks for the 50-result page this collection caps at', async () => {
  // The shared adapter's 500 is rejected by this endpoint, which would make
  // every per-rule lookup fail rather than confirm the rule.
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['sup-live-1']), entityPage([LIVE])])
  try {
    await healthCheck(healthContext([RULE]))

    const lookup = calls.find((c) => c.url.includes('filter='))
    assert.ok(lookup, 'no per-rule lookup was made')
    assert.match(lookup.url, /limit=50/)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules healthCheck: fails when a declared rule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'suppression-rule:suppress-sandbox-noise')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every rule would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('suppression-rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-rule lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('cloud-suppression-rules healthCheck: reports a failed per-rule lookup as failed, not as absent', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'suppression-rule:suppress-sandbox-noise')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
