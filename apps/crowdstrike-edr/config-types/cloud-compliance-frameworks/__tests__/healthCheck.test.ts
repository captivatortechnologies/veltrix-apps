// healthCheck for cloud-compliance-frameworks.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared framework must still
// resolve through the Cloud Security frameworks query, reported as
// `framework:<name>`.

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
  label: 'cloud-compliance-frameworks',
  handler: healthCheck,
  probePath: '/cloud-policies/queries/compliance/frameworks/v1',
  scopePattern: /Cloud Security Policies: Read/,
})

const FRAMEWORK = item('ACME cloud baseline', {
  name: 'ACME Cloud Baseline',
  description: 'Internal cloud control baseline',
})

const LIVE = { uuid: 'fw-live-1', name: 'ACME Cloud Baseline', active: true }

test('cloud-compliance-frameworks healthCheck: passes when every declared framework is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['fw-live-1']), entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([FRAMEWORK]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'framework:ACME Cloud Baseline')
    assert.ok(check, `expected a per-framework check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks healthCheck: fails when a declared framework has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([FRAMEWORK]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'framework:ACME Cloud Baseline')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks healthCheck: does not look for frameworks when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every framework would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([FRAMEWORK]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('framework:')),
      false,
      'an unreadable tenant must not be reported as the framework being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-framework lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks healthCheck: reports a failed per-framework lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-framework query then 500s. That
  // is "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([FRAMEWORK]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'framework:ACME Cloud Baseline')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(
      /does not exist in the tenant/.test(String(check.message)),
      false,
      'a 500 became "does not exist"',
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks healthCheck: does not accept a near-miss name as the declared framework', async () => {
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fw-other-1']),
    entityPage([{ uuid: 'fw-other-1', name: 'ACME Cloud Baseline (draft)' }]),
  ])
  try {
    const result = await healthCheck(healthContext([FRAMEWORK]))

    const check = result.checks.find((c) => c.name === 'framework:ACME Cloud Baseline')
    assert.ok(check)
    assert.equal(check.passed, false, 'a differently-named framework is not the declared one')
  } finally {
    restore()
  }
})
