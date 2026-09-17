// healthCheck for zia-dlp-dictionaries.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared dictionary must still exist in the
// tenant, matched by name and reported as `dictionary:<name>`.

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
  label: 'zia-dlp-dictionaries',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const DICTIONARY = item('Acme Secrets', {
  name: 'Acme Secrets',
  phrases: 'project-zephyr',
})

test('zia-dlp-dictionaries healthCheck: passes when every declared dictionary is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 7701, name: 'Acme Secrets', custom: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([DICTIONARY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'dictionary:Acme Secrets')
    assert.ok(check, `expected a per-dictionary check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries healthCheck: fails when a declared dictionary has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 7799, name: 'Something Else', custom: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([DICTIONARY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'dictionary:Acme Secrets')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries healthCheck: does not look for dictionaries when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every dictionary would read as "does not exist" because nothing could be
  // read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([DICTIONARY]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('dictionary:')),
      false,
      'an unreadable tenant must not be reported as the dictionary being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/dlpDictionaries')).length, 0)
  } finally {
    restore()
  }
})
