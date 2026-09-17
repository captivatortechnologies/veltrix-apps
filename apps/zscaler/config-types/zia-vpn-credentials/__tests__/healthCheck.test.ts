// healthCheck for zia-vpn-credentials.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here: the
// presence check matches on the CONDITIONAL identity (fqdn for UFQDN, ip_address
// for IP), case-insensitively, and never inspects the pre-shared key — the
// canvas carries it, so the result is checked for it too.

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
  label: 'zia-vpn-credentials',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const PSK = 'ipsec-psk-7f3a-MUST-NOT-LEAK'

const CREDENTIAL = item('Chicago tunnel', {
  type: 'UFQDN',
  fqdn: 'chicago@acme.com',
  comments: 'Chicago IPSec tunnel',
  pre_shared_key: PSK,
})

test('zia-vpn-credentials healthCheck: passes when every declared credential is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 3007, type: 'UFQDN', fqdn: 'chicago@acme.com' }]),
  ])
  try {
    const result = await healthCheck(healthContext([CREDENTIAL]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'vpn-credential:chicago@acme.com')
    assert.ok(check, `expected a per-credential check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    assert.equal(
      (JSON.stringify(result) ?? '').includes(PSK),
      false,
      'the canvas carries the key — the health result must not',
    )
  } finally {
    restore()
  }
})

test('zia-vpn-credentials healthCheck: matches a tunnel identity case-insensitively', async () => {
  // A tunnel identity is case-insensitive; reporting a credential absent because
  // ZIA echoed it back capitalised differently would be a false alarm.
  const { restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 3007, type: 'UFQDN', fqdn: 'Chicago@Acme.com' }]),
  ])
  try {
    const result = await healthCheck(healthContext([CREDENTIAL]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials healthCheck: fails when a declared credential has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 11, type: 'IP', ipAddress: '198.51.100.7' }]),
  ])
  try {
    const result = await healthCheck(healthContext([CREDENTIAL]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'vpn-credential:chicago@acme.com')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials healthCheck: does not look for credentials when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every tunnel would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([CREDENTIAL]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('vpn-credential:')),
      false,
      'an unreadable tenant must not be reported as the credential being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/vpnCredentials')).length, 0)
  } finally {
    restore()
  }
})
