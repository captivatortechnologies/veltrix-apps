// healthCheck for ngsiem-parsers.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half: each declared parser must still resolve through the
// id query scoped to its repository, reported as `parser:<name>`.

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
  label: 'ngsiem-parsers',
  handler: healthCheck,
  probePath: '/ngsiem-content/queries/parsers/v1',
  scopePattern: /Next-Gen SIEM parser read scope/,
})

const PARSER = item('Palo Alto traffic', {
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  script: 'parseJson()',
})

test('ngsiem-parsers healthCheck: passes when every declared parser is present', async () => {
  // The per-parser lookup is two calls: the id query, then the entity get.
  const { calls, restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['parser-live-1']),
    entityPage([{ id: 'parser-live-1', name: 'paloalto-traffic' }]),
  ])
  try {
    const result = await healthCheck(healthContext([PARSER]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'parser:paloalto-traffic')
    assert.ok(check, `expected a per-parser check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('ngsiem-parsers healthCheck: fails when a declared parser has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([PARSER]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'parser:paloalto-traffic')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-parsers healthCheck: does not look for parsers when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every parser would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([PARSER]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('parser:')),
      false,
      'an unreadable tenant must not be reported as the parser being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-parser lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('ngsiem-parsers healthCheck: reports a failed per-parser lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-parser query then 500s. That is
  // "I could not look", and it must not pass — nor read as the parser being gone.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([PARSER]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'parser:paloalto-traffic')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(
      /does not exist/.test(String(check.message)),
      false,
      'a 500 is "I could not look", not "the parser is gone"',
    )
  } finally {
    restore()
  }
})

test('ngsiem-parsers healthCheck: does not check a section with no parser script', async () => {
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
