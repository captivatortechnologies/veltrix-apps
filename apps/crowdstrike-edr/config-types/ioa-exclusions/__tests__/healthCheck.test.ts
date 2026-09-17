// healthCheck for ioa-exclusions.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared exclusion must still
// resolve through the IOA Exclusions id query — matched on `name`, not `value`
// like the ML/SV pair — and is reported as `ioa-exclusion:<name>`.

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
  label: 'ioa-exclusions',
  handler: healthCheck,
  probePath: '/policy/queries/ioa-exclusions/v1',
  scopePattern: /IOA Exclusions: Read/,
})

const EXCLUSION = item('Deployment agent', {
  name: 'vendor-deployment-agent',
  patternId: '10197',
  clRegex: '.*deploy-agent\\.exe.*',
  ifnRegex: '.*',
  appliedGlobally: true,
})

const LIVE = { id: 'ioa-live-1', name: 'vendor-deployment-agent' }

test('ioa-exclusions healthCheck: passes when every declared exclusion is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['ioa-live-1']), entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'ioa-exclusion:vendor-deployment-agent')
    assert.ok(check, `expected a per-exclusion check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('ioa-exclusions healthCheck: fails when a declared exclusion has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'ioa-exclusion:vendor-deployment-agent')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ioa-exclusions healthCheck: does not accept a similarly named exclusion', async () => {
  // The id query is an FQL match; the adapter pins the exact name client-side.
  // A different exclusion does not suppress what the declared one suppresses.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['ioa-other-1']),
    entityPage([{ id: 'ioa-other-1', name: 'vendor-deployment-agent-old' }]),
  ])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    const check = result.checks.find((c) => c.name === 'ioa-exclusion:vendor-deployment-agent')
    assert.ok(check)
    assert.equal(check.passed, false)
  } finally {
    restore()
  }
})

test('ioa-exclusions healthCheck: does not look for exclusions when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every exclusion would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('ioa-exclusion:')),
      false,
      'an unreadable tenant must not be reported as the exclusion being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-exclusion lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('ioa-exclusions healthCheck: reports a failed per-exclusion lookup as failed, not as absent', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'ioa-exclusion:vendor-deployment-agent')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
