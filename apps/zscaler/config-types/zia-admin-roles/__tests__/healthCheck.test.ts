// healthCheck for zia-admin-roles.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared role must still exist in the tenant,
// matched by name and reported as `role:<name>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  TOKEN,
  activationStatus,
  healthContext,
  item,
  recordFetch,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerHealthCheckContract } from '../../../lib/__tests__/zscalerContracts'

registerHealthCheckContract({
  label: 'zia-admin-roles',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const ROLE = item('SOC Analyst', { name: 'SOC Analyst', rank: 3 })

test('zia-admin-roles healthCheck: passes when every declared role is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 4102, name: 'SOC Analyst', rank: 3 }]),
  ])
  try {
    const result = await healthCheck(healthContext([ROLE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'role:SOC Analyst')
    assert.ok(check, `expected a per-role check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-admin-roles healthCheck: fails when a declared role has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 9001, name: 'Super Admin', rank: 1 }]),
  ])
  try {
    const result = await healthCheck(healthContext([ROLE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'role:SOC Analyst')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-admin-roles healthCheck: does not look for roles when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every role would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([ROLE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('role:')),
      false,
      'an unreadable tenant must not be reported as the role being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/adminRoles')).length, 0)
  } finally {
    restore()
  }
})
