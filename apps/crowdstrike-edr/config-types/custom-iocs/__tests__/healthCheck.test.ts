// healthCheck for custom-iocs.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared indicator must still
// resolve through its type+value identity query, reported as `ioc:<value>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
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
  label: 'custom-iocs',
  handler: healthCheck,
  probePath: '/iocs/queries/indicators/v1',
  scopePattern: /IOC Management: Read/,
})

const HASH = 'a3f1c0de4b2955ab7788c0d1e2f3a4b5c6d7e8f90112233445566778899aabbc'

const IOC = item('Loader hash from incident 4812', {
  type: 'sha256',
  value: HASH,
  action: 'prevent',
  severity: 'critical',
  platforms: 'windows',
})

test('custom-iocs healthCheck: passes when every declared indicator is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['ioc-live-1'])])
  try {
    const result = await healthCheck(healthContext([IOC]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === `ioc:${HASH}`)
    assert.ok(check, `expected a per-indicator check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('custom-iocs healthCheck: fails when a declared indicator has been deleted in the tenant', async () => {
  // An indicator removed in the console stops blocking the hash it named, and
  // nothing else in the pipeline notices.
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([IOC]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === `ioc:${HASH}`)
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('custom-iocs healthCheck: does not look for indicators when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every indicator would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([IOC]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('ioc:')),
      false,
      'an unreadable tenant must not be reported as the indicator being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-indicator lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('custom-iocs healthCheck: reports a failed per-indicator lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the identity query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([IOC]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === `ioc:${HASH}`)
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})

test('custom-iocs healthCheck: scores each declared indicator independently', async () => {
  const SECOND = item('Second hash', {
    type: 'md5',
    value: 'b3f1c0de4b2955ab7788c0d1e2f3a4b5',
    action: 'detect',
    severity: 'high',
    platforms: 'windows',
  })
  const { restore } = recordFetch([TOKEN, EMPTY, idsPage(['ioc-live-1']), EMPTY])
  try {
    const result = await healthCheck(healthContext([IOC, SECOND]))

    // Two of three checks passed — the score is a PERCENTAGE, not a fraction.
    assert.equal(result.score, 67)
    assert.equal(result.healthy, false)
  } finally {
    restore()
  }
})
