// healthCheck for ngsiem-lookup-files.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half: each declared file is confirmed with one bulk-get
// scoped to its search_domain, reported as `lookup:<filename>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  item,
  notFound,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'ngsiem-lookup-files',
  handler: healthCheck,
  probePath: '/ngsiem-content/queries/lookupfiles/v1',
  scopePattern: /Next-Gen SIEM lookup file read scope/,
})

const LOOKUP = item('Payment estate owners', {
  filename: 'payment-estate.csv',
  repository: 'all',
  content: 'hostname,owner\npay-db-01,payments',
})

test('ngsiem-lookup-files healthCheck: passes when every declared file is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    EMPTY,
    entityPage([{ filename: 'payment-estate.csv', search_domain: 'all' }]),
  ])
  try {
    const result = await healthCheck(healthContext([LOOKUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'lookup:payment-estate.csv')
    assert.ok(check, `expected a per-file check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files healthCheck: fails when a declared file has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([LOOKUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'lookup:payment-estate.csv')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files healthCheck: reads a 404 as the file being absent, which is a known answer', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, notFound()])
  try {
    const result = await healthCheck(healthContext([LOOKUP]))

    const check = result.checks.find((c) => c.name === 'lookup:payment-estate.csv')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files healthCheck: does not look for files when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every file would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([LOOKUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('lookup:')),
      false,
      'an unreadable tenant must not be reported as the file being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filename=')).length,
      0,
      'no per-file lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files healthCheck: reports a failed per-file lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the bulk-get then 500s. That is "I could
  // not look", and it must not pass — nor read as the file being gone.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([LOOKUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'lookup:payment-estate.csv')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(
      /does not exist/.test(String(check.message)),
      false,
      'a 500 is "I could not look", not "the file is gone"',
    )
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files healthCheck: does not check a section with no CSV content', async () => {
  const PLACEHOLDER = item('Placeholder', { filename: 'placeholder.csv' })
  const { restore } = recordFetch([TOKEN, EMPTY])
  try {
    const result = await healthCheck(healthContext([PLACEHOLDER]))

    assert.equal(result.healthy, true)
    assert.equal(result.checks.length, 1, 'an undeployable section adds no health check')
  } finally {
    restore()
  }
})
