// healthCheck for installation-tokens.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared token must still resolve
// by label through the list-then-get lookup, reported as `token:<label>` — and
// the token SECRET the tenant returns alongside it must not end up in the health
// result, which the platform stores and displays.

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
  label: 'installation-tokens',
  handler: healthCheck,
  probePath: '/installation-tokens/queries/tokens/v1',
  scopePattern: /Installation tokens \(sensor\): Read/,
})

const TOKEN_VALUE = 'falcon-installation-token-value-MUST-NOT-LEAK'

const TOKEN_ITEM = item('Workstation rollout', {
  label: 'workstation-rollout',
  expiresTimestamp: '2026-12-31T00:00:00Z',
  revoked: false,
})

/** Reachability probe, then the list-then-get lookup for one token. */
const probeThenLookup = (live: Record<string, unknown> | null) =>
  live === null
    ? [TOKEN, EMPTY, EMPTY]
    : [TOKEN, EMPTY, idsPage([String(live.id)]), entityPage([live])]

test('installation-tokens healthCheck: passes when every declared token is present', async () => {
  const { calls, restore } = recordFetch(
    probeThenLookup({ id: 'tok-live-1', label: 'workstation-rollout', value: TOKEN_VALUE }),
  )
  try {
    const result = await healthCheck(healthContext([TOKEN_ITEM]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'token:workstation-rollout')
    assert.ok(check, `expected a per-token check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('installation-tokens healthCheck: never puts the token value in the health result', async () => {
  // The listing returns the enrolment secret alongside the metadata; a check
  // message quoting the live token would persist it in the platform.
  const { restore } = recordFetch(
    probeThenLookup({ id: 'tok-live-1', label: 'workstation-rollout', value: TOKEN_VALUE }),
  )
  try {
    const result = await healthCheck(healthContext([TOKEN_ITEM]))

    assert.equal(
      (JSON.stringify(result) ?? '').includes(TOKEN_VALUE),
      false,
      'the token secret escaped into the health result',
    )
  } finally {
    restore()
  }
})

test('installation-tokens healthCheck: fails when a declared token has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch(probeThenLookup(null))
  try {
    const result = await healthCheck(healthContext([TOKEN_ITEM]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'token:workstation-rollout')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('installation-tokens healthCheck: does not look for tokens when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every token would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([TOKEN_ITEM]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('token:')),
      false,
      'an unreadable tenant must not be reported as the token being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('limit=1000')).length,
      0,
      'no per-token listing may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('installation-tokens healthCheck: reports a failed per-token listing as failed, not as absent', async () => {
  // The reachability probe succeeds and the listing then 500s. That is "I could
  // not look", and it must not pass — nor claim the token was deleted.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([TOKEN_ITEM]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'token:workstation-rollout')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /Failed to list installation tokens/)
    assert.equal(
      /does not exist in the tenant/.test(String(check.message)),
      false,
      'an unreadable listing must not be reported as the token being deleted',
    )
  } finally {
    restore()
  }
})
