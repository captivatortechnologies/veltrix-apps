// healthCheck for users.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared user must still resolve
// BY EMAIL (the Falcon `uid`) and, when the canvas manages roles, hold exactly
// the declared direct grants — reported as `user:<email>`.

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
  label: 'users',
  handler: healthCheck,
  probePath: '/user-management/queries/users/v1',
  scopePattern: /User Management: Read/,
})

const USER = item('Alice Chen', {
  email: 'alice@acme.com',
  firstName: 'Alice',
  lastName: 'Chen',
  roleIds: 'falcon_analyst, falcon_investigator',
})

const LIVE_USER = { uuid: 'usr-live-1', uid: 'alice@acme.com', first_name: 'Alice', last_name: 'Chen' }

const QUERY = /\/user-management\/queries\/users\/v1/
const BULK_GET = /\/user-management\/entities\/users\/GET\/v1/
const USER_ROLES = /\/user-management\/combined\/user-roles\/v2/

/**
 * The reachability probe and the per-user lookup hit the SAME query endpoint, so
 * that route carries a two-entry queue: the probe first, then the lookup. A
 * queued route that has run out keeps answering with its last entry.
 */
function tenant(opts: { lookup?: CannedResponse; user?: CannedResponse; roles?: CannedResponse }) {
  return routeFetch([
    { url: BULK_GET, method: 'POST', respond: opts.user ?? EMPTY },
    { url: QUERY, respond: [EMPTY, opts.lookup ?? EMPTY] },
    { url: USER_ROLES, respond: opts.roles ?? EMPTY },
  ])
}

test('users healthCheck: passes when every declared user exists with the declared roles', async () => {
  const { calls, restore } = tenant({
    lookup: idsPage(['usr-live-1']),
    user: entityPage([LIVE_USER]),
    roles: entityPage([{ role_id: 'falcon_analyst' }, { role_id: 'falcon_investigator' }]),
  })
  try {
    const result = await healthCheck(healthContext([USER]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'user:alice@acme.com')
    assert.ok(check, `expected a per-user check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 1, 'the only non-GET is the bulk-read POST users/GET/v1')
  } finally {
    restore()
  }
})

test('users healthCheck: identifies a user by email, not by display name', async () => {
  // The canvas item is named "Alice Chen"; the identity is the uid. A tenant
  // user that matched the query but carries a different uid must NOT be adopted
  // as the declared user — that would report someone else's account as healthy.
  const { calls, restore } = tenant({
    lookup: idsPage(['usr-other-1']),
    user: entityPage([{ uuid: 'usr-other-1', uid: 'alice.chen@other.example', first_name: 'Alice' }]),
  })
  try {
    const result = await healthCheck(healthContext([USER]))

    const check = result.checks.find((c) => c.name === 'user:alice@acme.com')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)

    const lookup = calls.find((c) => QUERY.test(c.url) && c.url.includes('filter'))
    assert.ok(lookup, 'no per-user lookup was issued')
    const decoded = decodeURIComponent(lookup.url)
    assert.match(decoded, /uid:'alice@acme\.com'/, 'the lookup filter must be the uid')
    assert.equal(decoded.includes('Alice Chen'), false, 'the display name must never be the lookup key')
  } finally {
    restore()
  }
})

test('users healthCheck: fails when a declared user has been removed from the tenant', async () => {
  const { restore } = tenant({})
  try {
    const result = await healthCheck(healthContext([USER]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'user:alice@acme.com')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('users healthCheck: fails when the direct role grants differ from the declared set', async () => {
  const { restore } = tenant({
    lookup: idsPage(['usr-live-1']),
    user: entityPage([LIVE_USER]),
    roles: entityPage([{ role_id: 'falcon_security_lead' }]),
  })
  try {
    const result = await healthCheck(healthContext([USER]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'user:alice@acme.com')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /roles differ/)
    assert.match(String(check.message), /falcon_security_lead/)
  } finally {
    restore()
  }
})

test('users healthCheck: does not read roles for a user whose canvas item declares none', async () => {
  const { calls, restore } = tenant({ lookup: idsPage(['usr-live-1']), user: entityPage([LIVE_USER]) })
  try {
    const result = await healthCheck(
      healthContext([item('Alice Chen', { email: 'alice@acme.com', firstName: 'Alice' })]),
    )

    assert.equal(result.healthy, true)
    assert.equal(
      calls.some((c) => USER_ROLES.test(c.url)),
      false,
      'roles are only managed when the canvas declares at least one role id',
    )
  } finally {
    restore()
  }
})

test('users healthCheck: does not look for users when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every user would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([USER]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('user:')),
      false,
      'an unreadable tenant must not be reported as the user being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-user lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('users healthCheck: reports a failed per-user lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-user query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([USER]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'user:alice@acme.com')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
