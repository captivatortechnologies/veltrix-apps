// healthCheck for ngsiem-data-connections.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is an EXTRA check between reachability and the per-connection checks:
// `connections_listed`. It only runs when the canvas declares a connection, and
// the per-connection checks only run when it passed — so an unreadable
// collection is never reported as every forwarder having been deleted.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'ngsiem-data-connections',
  handler: healthCheck,
  probePath: '/ngsiem/combined/connections/v1',
  scopePattern: /Next-Gen SIEM data connections scope/,
})

const UPSTREAM_SECRET = 'aws-upstream-access-key-MUST-NOT-LEAK'

function leaksUpstreamSecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(UPSTREAM_SECRET)
}

const CONNECTION = item('CloudTrail ingest', {
  name: 'acme-cloudtrail',
  connectorType: 'aws-s3',
  credential: UPSTREAM_SECRET,
  targetRepository: 'acme-security-events',
})

const LIVE_CONNECTION = {
  id: 'conn-live-1',
  name: 'acme-cloudtrail',
  connector_type: 'aws-s3',
  config: { repository: 'acme-security-events' },
}

test('ngsiem-data-connections healthCheck: passes when every declared connection is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE_CONNECTION])])
  try {
    const result = await healthCheck(healthContext([CONNECTION]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    assert.deepEqual(
      result.checks.map((c) => c.name),
      ['falcon_reachable', 'connections_listed', 'connection:acme-cloudtrail'],
      'the listing check sits between reachability and the per-connection checks',
    )
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    assert.equal(leaksUpstreamSecret(result), false, 'a health result must not carry the credential')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections healthCheck: fails when a declared connection has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([CONNECTION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 67, 'two of three checks passed')
    const check = result.checks.find((c) => c.name === 'connection:acme-cloudtrail')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections healthCheck: does not report connections absent when the listing failed', async () => {
  // The probe reads one row and succeeds; the full listing then 500s. That is
  // "I could not look", and every forwarder must not read as deleted.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([CONNECTION]))

    assert.equal(result.healthy, false)
    const listed = result.checks.find((c) => c.name === 'connections_listed')
    assert.ok(listed, `expected a connections_listed check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(listed.passed, false)
    assert.match(String(listed.message), /internal server error/)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('connection:')),
      false,
      'an unreadable collection must not be reported as the connection being absent',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections healthCheck: does not list connections when the tenant is unreachable', async () => {
  const { restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([CONNECTION]))

    assert.equal(result.healthy, false)
    assert.deepEqual(
      result.checks.map((c) => c.name),
      ['falcon_reachable'],
      'nothing beyond reachability is meaningful once the probe failed',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections healthCheck: skips the listing entirely when nothing is declared', async () => {
  // The shared contract already asserts the single probe; this names the reason
  // — the listing check is conditional on there being something to look for.
  const { restore } = recordFetch([TOKEN, EMPTY])
  try {
    const result = await healthCheck(healthContext([]))

    assert.deepEqual(result.checks.map((c) => c.name), ['falcon_reachable'])
  } finally {
    restore()
  }
})

test('ngsiem-data-connections healthCheck: does not check a section missing its connector type', async () => {
  const INCOMPLETE = item('Draft', { name: 'draft-connection', targetRepository: 'acme-security-events' })
  const { restore } = recordFetch([TOKEN, EMPTY])
  try {
    const result = await healthCheck(healthContext([INCOMPLETE]))

    assert.equal(result.healthy, true)
    assert.deepEqual(result.checks.map((c) => c.name), ['falcon_reachable'])
  } finally {
    restore()
  }
})
