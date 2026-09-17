// healthCheck for cloud-compliance-controls.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared control must still
// resolve by name WITHIN its framework and section, reported as
// `control:<name>`.

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
  label: 'cloud-compliance-controls',
  handler: healthCheck,
  probePath: '/cloud-policies/queries/compliance/controls/v1',
  scopePattern: /Cloud Security Policies: Read/,
})

const CONTROL = item('Access control — MFA', {
  name: 'Require MFA on console access',
  frameworkId: 'fw-live-1',
  section: 'Access Control',
})

const LIVE_CONTROL = {
  uuid: 'ctl-live-1',
  name: 'Require MFA on console access',
  section_name: 'Access Control',
  security_framework: [{ uuid: 'fw-live-1', name: 'ACME Cloud Baseline' }],
}

test('cloud-compliance-controls healthCheck: passes when every declared control is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['ctl-live-1']), entityPage([LIVE_CONTROL])])
  try {
    const result = await healthCheck(healthContext([CONTROL]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'control:Require MFA on console access')
    assert.ok(check, `expected a per-control check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-compliance-controls healthCheck: fails when a declared control has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([CONTROL]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'control:Require MFA on console access')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls healthCheck: does not accept a same-named control from another framework', async () => {
  const foreign = { ...LIVE_CONTROL, uuid: 'ctl-foreign-1', security_framework: [{ uuid: 'fw-other-1' }] }
  const { restore } = recordFetch([TOKEN, EMPTY, idsPage(['ctl-foreign-1']), entityPage([foreign])])
  try {
    const result = await healthCheck(healthContext([CONTROL]))

    const check = result.checks.find((c) => c.name === 'control:Require MFA on console access')
    assert.ok(check)
    assert.equal(check.passed, false, "another framework's control is not the declared one")
  } finally {
    restore()
  }
})

test('cloud-compliance-controls healthCheck: does not look for controls when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every control would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([CONTROL]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('control:')),
      false,
      'an unreadable tenant must not be reported as the control being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-control lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-controls healthCheck: reports a failed per-control lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-control query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([CONTROL]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'control:Require MFA on console access')
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
