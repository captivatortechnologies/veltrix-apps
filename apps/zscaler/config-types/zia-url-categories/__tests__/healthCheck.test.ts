// healthCheck for zia-url-categories.
//
// The shared contract covers the refusals, the token-first probe and the
// error handling every Zscaler config type has in common. What is specific here
// is the second half of the check: every declared category must still exist in
// the tenant, matched by configuredName.

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
  label: 'zia-url-categories',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const CATEGORY = item('Blocked Vendors', {
  configured_name: 'Blocked Vendors',
  super_category: 'USER_DEFINED',
  urls: 'new.example.com',
})

test('zia-url-categories healthCheck: passes when every declared category is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 'CUSTOM_01', configuredName: 'Blocked Vendors', customCategory: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([CATEGORY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'category:Blocked Vendors')
    assert.ok(check, `expected a per-category check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-url-categories healthCheck: fails when a declared category has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 'CUSTOM_77', configuredName: 'Something Else', customCategory: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([CATEGORY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'category:Blocked Vendors')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-url-categories healthCheck: does not look for categories when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every category would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([CATEGORY]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('category:')),
      false,
      'an unreadable tenant must not be reported as the category being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/urlCategories')).length, 0)
  } finally {
    restore()
  }
})
