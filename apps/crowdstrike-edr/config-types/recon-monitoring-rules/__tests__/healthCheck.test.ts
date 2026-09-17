// healthCheck for recon-monitoring-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is that a rule is only healthy WITH its declared notification actions: a
// rule that matches but notifies nobody is a monitoring rule nobody reads.

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
  label: 'recon-monitoring-rules',
  handler: healthCheck,
  probePath: '/recon/queries/rules/v1',
  scopePattern: /Monitoring rules \(Falcon Intelligence Recon\): Read/,
})

const ACTIONS_JSON =
  '[{"type":"email","frequency":"asap","recipients":["soc@acme.com"],"contentFormat":"enhanced"}]'

const RULE = item('Leaked corporate credentials', {
  name: 'acme-leaked-credentials',
  topic: 'SA_EMAIL',
  filter: "email_domain:'acme.com'",
})

const RULE_WITH_ACTIONS = item('Leaked corporate credentials', {
  ...(RULE.fields as Record<string, unknown>),
  actions: ACTIONS_JSON,
})

const LIVE_ACTION = {
  id: 'action-live-1',
  rule_id: 'recon-live-1',
  type: 'email',
  frequency: 'asap',
  recipients: ['soc@acme.com'],
  content_format: 'enhanced',
}

test('recon-monitoring-rules healthCheck: passes when every declared rule is present', async () => {
  // The per-rule lookup is the adapter's two calls: id query, then entity get.
  const { calls, restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['recon-live-1']),
    entityPage([{ id: 'recon-live-1', name: 'acme-leaked-credentials' }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'recon-rule:acme-leaked-credentials')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules healthCheck: passes when the declared notification actions are all present', async () => {
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['recon-live-1']),
    entityPage([{ id: 'recon-live-1', name: 'acme-leaked-credentials' }]),
    idsPage(['action-live-1']),
    entityPage([LIVE_ACTION]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE_WITH_ACTIONS]))

    assert.equal(result.healthy, true)
    const check = result.checks.find((c) => c.name === 'recon-rule:acme-leaked-credentials')
    assert.ok(check)
    assert.match(String(check.message), /all 1 declared action/)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules healthCheck: fails when a declared notification action is missing', async () => {
  // The rule exists and matches, but nobody is told — which is the failure mode
  // this check exists to catch.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['recon-live-1']),
    entityPage([{ id: 'recon-live-1', name: 'acme-leaked-credentials' }]),
    EMPTY,
  ])
  try {
    const result = await healthCheck(healthContext([RULE_WITH_ACTIONS]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'recon-rule:acme-leaked-credentials')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /missing 1 declared notification action/)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules healthCheck: fails when a declared rule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'recon-rule:acme-leaked-credentials')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every rule would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('recon-rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-rule lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('recon-monitoring-rules healthCheck: reports a failed per-rule lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-rule query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'recon-rule:acme-leaked-credentials')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(
      /does not exist/.test(String(check.message)),
      false,
      'a 500 is "I could not look", not "the rule is gone"',
    )
  } finally {
    restore()
  }
})
