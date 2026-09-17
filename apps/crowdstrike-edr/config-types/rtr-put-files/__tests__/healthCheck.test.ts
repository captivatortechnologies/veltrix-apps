// healthCheck for rtr-put-files.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared put-file must still
// resolve by name through the two-call entity lookup, reported as
// `put-file:<name>`.

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
  label: 'rtr-put-files',
  handler: healthCheck,
  probePath: '/real-time-response/queries/put-files/v1',
  scopePattern: /Real Time Response \(Admin\): Read/,
})

const PUT_FILE = item('Isolation payload', {
  name: 'isolate-host.ps1',
  description: 'Staged isolation payload',
  content: '# staged isolation payload\n',
})

/** Reachability probe, then the two-call entity-adapter lookup for one file. */
const probeThenLookup = (live: Record<string, unknown> | null) =>
  live === null
    ? [TOKEN, EMPTY, EMPTY]
    : [TOKEN, EMPTY, idsPage([String(live.id)]), entityPage([live])]

test('rtr-put-files healthCheck: passes when every declared put-file is present', async () => {
  const { calls, restore } = recordFetch(probeThenLookup({ id: 'pf-live-1', name: 'isolate-host.ps1' }))
  try {
    const result = await healthCheck(healthContext([PUT_FILE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'put-file:isolate-host.ps1')
    assert.ok(check, `expected a per-file check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('rtr-put-files healthCheck: fails when a declared put-file has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch(probeThenLookup(null))
  try {
    const result = await healthCheck(healthContext([PUT_FILE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'put-file:isolate-host.ps1')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('rtr-put-files healthCheck: does not look for put-files when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every file would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([PUT_FILE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('put-file:')),
      false,
      'an unreadable tenant must not be reported as the file being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-file lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('rtr-put-files healthCheck: reports a failed per-file lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-file query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([PUT_FILE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'put-file:isolate-host.ps1')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
