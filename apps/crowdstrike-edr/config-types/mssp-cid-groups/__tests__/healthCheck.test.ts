// healthCheck for mssp-cid-groups.
//
// A CID group decides which CUSTOMER tenants an MSSP's analysts can reach, so
// the per-object half of this check is membership: every declared child CID must
// still be in the group. The shared contract covers the refusals, the token-first
// probe and the error handling every crowdstrike-edr config type has in common.

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
  label: 'mssp-cid-groups',
  handler: healthCheck,
  probePath: '/mssp/queries/cid-groups/v1',
  scopePattern: /Flight Control \(MSSP\) scope/,
})

const CID_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const CID_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'

const GROUP = item('Managed customers', {
  name: 'Tier 1 managed customers',
  description: 'Customers under 24x7 monitoring',
  cids: `${CID_A}, ${CID_B}`,
})

const LIVE_GROUP = {
  id: 'cg-live-1',
  name: 'Tier 1 managed customers',
  description: 'Customers under 24x7 monitoring',
}

const QUERY = /\/mssp\/queries\/cid-groups\/v1/
const ENTITY_GET = /\/mssp\/entities\/cid-groups\/v2/
const MEMBERS_GET = /\/mssp\/entities\/cid-group-members\/v2/

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

test('mssp-cid-groups healthCheck: passes when the group holds every declared child CID', async () => {
  const { calls, restore } = tenant({
    lookup: idsPage(['cg-live-1']),
    group: entityPage([LIVE_GROUP]),
    members: entityPage([{ cid_group_id: 'cg-live-1', cids: [CID_A, CID_B] }]),
  })
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'cid-group:Tier 1 managed customers')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('mssp-cid-groups healthCheck: fails when a declared customer CID is no longer a member', async () => {
  // An analyst team silently lost visibility of one of its customers.
  const { restore } = tenant({
    lookup: idsPage(['cg-live-1']),
    group: entityPage([LIVE_GROUP]),
    members: entityPage([{ cid_group_id: 'cg-live-1', cids: [CID_A] }]),
  })
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'cid-group:Tier 1 managed customers')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /missing member CID/)
    assert.match(String(check.message), new RegExp(CID_B))
  } finally {
    restore()
  }
})

test('mssp-cid-groups healthCheck: fails when the declared group has been deleted in the tenant', async () => {
  const { restore } = tenant({})
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'cid-group:Tier 1 managed customers')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('mssp-cid-groups healthCheck: does not look for groups when Flight Control is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every group would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('cid-group:')),
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

test('mssp-cid-groups healthCheck: reports a failed per-group lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-group query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'cid-group:Tier 1 managed customers')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})

test('mssp-cid-groups healthCheck: reports a failed membership read as failed, not as a present group', async () => {
  const { restore } = tenant({
    lookup: idsPage(['cg-live-1']),
    group: entityPage([LIVE_GROUP]),
    members: serverError('internal server error'),
  })
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'cid-group:Tier 1 managed customers')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
