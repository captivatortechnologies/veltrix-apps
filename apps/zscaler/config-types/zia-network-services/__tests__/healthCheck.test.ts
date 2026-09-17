// healthCheck for zia-network-services.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared network service must still exist in
// the tenant, matched by name — the presence check does not care whether the
// live service is CUSTOM or PREDEFINED.

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
  label: 'zia-network-services',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const SERVICE = item('Vendor SFTP', { name: 'Vendor SFTP', tcp_ports: '22' })

test('zia-network-services healthCheck: passes when every declared service is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 7001, name: 'Vendor SFTP', type: 'CUSTOM' }]),
  ])
  try {
    const result = await healthCheck(healthContext([SERVICE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'service:Vendor SFTP')
    assert.ok(check, `expected a per-service check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-network-services healthCheck: fails when a declared service has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 7077, name: 'Something Else', type: 'CUSTOM' }]),
  ])
  try {
    const result = await healthCheck(healthContext([SERVICE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'service:Vendor SFTP')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-services healthCheck: does not look for services when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every service would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([SERVICE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('service:')),
      false,
      'an unreadable tenant must not be reported as the service being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/networkServices')).length, 0)
  } finally {
    restore()
  }
})
