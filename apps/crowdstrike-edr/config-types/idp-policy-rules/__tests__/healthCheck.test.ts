// healthCheck for idp-policy-rules.
//
// An Identity Protection rule that exists but is DISABLED enforces nothing, so
// the per-object half of this check is not just presence: it is presence with
// the declared enablement. The shared contract covers the refusals, the
// token-first probe and the error handling every config type has in common.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  CannedResponse,
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
  label: 'idp-policy-rules',
  handler: healthCheck,
  probePath: '/identity-protection/queries/policy-rules/v1',
  scopePattern: /Identity Protection Policy Rules: Read/,
})

const RULE = item('Block legacy auth', {
  name: 'Block legacy authentication',
  enabled: 'true',
  simulationMode: 'false',
  action: 'DENY',
})

const QUERY = /\/identity-protection\/queries\/policy-rules\/v1/
const ENTITY = /\/identity-protection\/entities\/policy-rules\/v1/

/**
 * The reachability probe and the per-rule lookup hit the SAME query endpoint, so
 * that route carries a two-entry queue: the probe first, then the lookup.
 */
function tenant(opts: { lookup?: CannedResponse; rule?: CannedResponse }) {
  return routeFetch([
    { url: ENTITY, method: 'GET', respond: opts.rule ?? EMPTY },
    { url: QUERY, respond: [EMPTY, opts.lookup ?? EMPTY] },
  ])
}

test('idp-policy-rules healthCheck: passes when the declared rule exists and is enabled', async () => {
  const { calls, restore } = tenant({
    lookup: idsPage(['rule-live-1']),
    rule: entityPage([{ id: 'rule-live-1', name: 'Block legacy authentication', enabled: true, action: 'DENY' }]),
  })
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule:Block legacy authentication')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('idp-policy-rules healthCheck: fails when the rule was disabled in the console', async () => {
  // Present but disabled: the identity policy is not being enforced at all,
  // which is the failure mode a presence-only check would miss.
  const { restore } = tenant({
    lookup: idsPage(['rule-live-1']),
    rule: entityPage([{ id: 'rule-live-1', name: 'Block legacy authentication', enabled: false, action: 'DENY' }]),
  })
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule:Block legacy authentication')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('idp-policy-rules healthCheck: fails when the declared rule has been deleted in the tenant', async () => {
  const { restore } = tenant({})
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule:Block legacy authentication')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('idp-policy-rules healthCheck: does not adopt a rule under a different name', async () => {
  // The query is a loose `name=` lookup. Reporting an unrelated rule as the
  // declared one would mark an unenforced policy healthy.
  const { restore } = tenant({
    lookup: idsPage(['rule-other-1']),
    rule: entityPage([{ id: 'rule-other-1', name: 'Some other rule', enabled: true, action: 'DENY' }]),
  })
  try {
    const result = await healthCheck(healthContext([RULE]))

    const check = result.checks.find((c) => c.name === 'rule:Block legacy authentication')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('idp-policy-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every rule would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('name=')).length,
      0,
      'no per-rule lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('idp-policy-rules healthCheck: reports a failed per-rule lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-rule query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule:Block legacy authentication')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
