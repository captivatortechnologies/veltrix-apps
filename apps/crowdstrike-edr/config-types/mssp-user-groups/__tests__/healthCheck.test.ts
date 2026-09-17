// healthCheck for mssp-user-groups.
//
// A user group is the analyst side of an MSSP access boundary: its member user
// UUIDs, bound to a CID group by a role mapping, decide who can reach which
// customer tenants. So the per-object half of this check is membership. The
// shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common.

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
  label: 'mssp-user-groups',
  handler: healthCheck,
  probePath: '/mssp/queries/user-groups/v1',
  scopePattern: /Flight Control \(MSSP\) scope/,
})

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const GROUP = item('SOC tier 2', {
  name: 'SOC tier 2 analysts',
  description: 'Escalation analysts',
  userUuids: `${UUID_A}, ${UUID_B}`,
})

const LIVE_GROUP = { id: 'ug-live-1', name: 'SOC tier 2 analysts', description: 'Escalation analysts' }

const QUERY = /\/mssp\/queries\/user-groups\/v1/
const ENTITY_GET = /\/mssp\/entities\/user-groups\/v2/
const MEMBERS_GET = /\/mssp\/entities\/user-group-members\/v2/

/**
 * The reachability probe and the per-group lookup hit the SAME query endpoint,
 * so that route carries a two-entry queue: the probe first, then the lookup.
 */
function tenant(opts: { lookup?: CannedResponse; group?: CannedResponse; members?: CannedResponse }) {
  return routeFetch([
    { url: MEMBERS_GET, respond: opts.members ?? EMPTY },
    { url: ENTITY_GET, respond: opts.group ?? EMPTY },
    { url: QUERY, respond: [EMPTY, opts.lookup ?? EMPTY] },
  ])
}

test('mssp-user-groups healthCheck: passes when the group holds every declared member', async () => {
  const { calls, restore } = tenant({
    lookup: idsPage(['ug-live-1']),
    group: entityPage([LIVE_GROUP]),
    members: entityPage([{ user_group_id: 'ug-live-1', user_uuids: [UUID_A, UUID_B] }]),
  })
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'user-group:SOC tier 2 analysts')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('mssp-user-groups healthCheck: fails when a declared analyst is no longer a member', async () => {
  const { restore } = tenant({
    lookup: idsPage(['ug-live-1']),
    group: entityPage([LIVE_GROUP]),
    members: entityPage([{ user_group_id: 'ug-live-1', user_uuids: [UUID_A] }]),
  })
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'user-group:SOC tier 2 analysts')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /missing member user/)
    assert.match(String(check.message), new RegExp(UUID_B))
  } finally {
    restore()
  }
})

test('mssp-user-groups healthCheck: fails when the declared group has been deleted in the tenant', async () => {
  const { restore } = tenant({})
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'user-group:SOC tier 2 analysts')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('mssp-user-groups healthCheck: does not look for groups when Flight Control is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every group would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('user-group:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('name=')).length,
      0,
      'no per-group lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('mssp-user-groups healthCheck: reports a failed per-group lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-group query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'user-group:SOC tier 2 analysts')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})

test('mssp-user-groups healthCheck: reports a failed membership read as failed, not as a present group', async () => {
  const { restore } = tenant({
    lookup: idsPage(['ug-live-1']),
    group: entityPage([LIVE_GROUP]),
    members: serverError('internal server error'),
  })
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'user-group:SOC tier 2 analysts')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
