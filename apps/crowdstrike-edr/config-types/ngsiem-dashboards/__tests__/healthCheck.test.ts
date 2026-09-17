// healthCheck for ngsiem-dashboards.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half: each declared dashboard is confirmed with a single
// filtered id query against `…/queries/dashboards/v1`, reported as
// `dashboard:<name>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
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
  label: 'ngsiem-dashboards',
  handler: healthCheck,
  probePath: '/ngsiem-content/queries/dashboards/v1',
  scopePattern: /NG-SIEM content read scope/,
})

const DASHBOARD = item('Authentication overview', {
  name: 'authentication-overview',
  definition: '{"widgets":[]}',
})

test('ngsiem-dashboards healthCheck: passes when every declared dashboard is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['dash-live-1'])])
  try {
    const result = await healthCheck(healthContext([DASHBOARD]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'dashboard:authentication-overview')
    assert.ok(check, `expected a per-dashboard check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards healthCheck: fails when a declared dashboard has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([DASHBOARD]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'dashboard:authentication-overview')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards healthCheck: does not look for dashboards when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every dashboard would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([DASHBOARD]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('dashboard:')),
      false,
      'an unreadable tenant must not be reported as the dashboard being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-dashboard lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('ngsiem-dashboards healthCheck: reports a failed per-dashboard lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-dashboard query then 500s. That
  // is "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([DASHBOARD]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'dashboard:authentication-overview')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(
      /does not exist/.test(String(check.message)),
      false,
      'a 500 is "I could not look", not "the dashboard is gone"',
    )
  } finally {
    restore()
  }
})

test('ngsiem-dashboards healthCheck: does not check a dashboard the canvas left without a definition', async () => {
  const PLACEHOLDER = item('Placeholder', { name: 'placeholder' })
  const { restore } = recordFetch([TOKEN, EMPTY])
  try {
    const result = await healthCheck(healthContext([PLACEHOLDER]))

    assert.equal(result.healthy, true)
    assert.equal(result.checks.length, 1, 'an undeployable section adds no health check')
  } finally {
    restore()
  }
})
