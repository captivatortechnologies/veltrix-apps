// healthCheck for zpa-servers.
//
// The shared contract covers the refusals (including the ZPA customer id), the
// token-first probe and the error handling. What is specific here is the
// presence half: every declared server must still exist, matched by name — the
// address is not re-checked, only existence.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  TOKEN,
  healthContext,
  item,
  recordFetch,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerHealthCheckContract } from '../../../lib/__tests__/zscalerContracts'

registerHealthCheckContract({
  label: 'zpa-servers',
  handler: healthCheck,
  product: 'zpa',
  probePath: '/server',
})

const SERVER = item('web-01', { name: 'web-01', address: 'web-01.corp.example.com', enabled: true })

test('zpa-servers healthCheck: passes when every declared server is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([{ id: '1', name: 'web-01' }]),
    zpaList([{ id: '1', name: 'web-01' }]),
  ])
  try {
    const result = await healthCheck(healthContext([SERVER]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'server:web-01')
    assert.ok(check, `expected a per-server check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zpa-servers healthCheck: fails when a declared server has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([{ id: '1', name: 'web-01' }]), zpaList([])])
  try {
    const result = await healthCheck(healthContext([SERVER]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'server:web-01')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('zpa-servers healthCheck: does not look for servers when the tenant is unreachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { reason: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([SERVER]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('server:')),
      false,
      'an unreadable tenant must not be reported as the server being absent',
    )
    assert.equal(calls.length, 2, 'the probe failed — nothing further should be read')
  } finally {
    restore()
  }
})
