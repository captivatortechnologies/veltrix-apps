// healthCheck for mssp-role-mappings.
//
// A role mapping IS the MSSP access grant: it binds an analyst group to a CID
// group with a set of role ids. So the per-object half of this check is that the
// binding still exists and still carries every declared role — a binding that
// quietly lost its roles is an analyst team that can no longer work a customer.
// The shared contract covers the refusals, the token-first probe and the error
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
  label: 'mssp-role-mappings',
  handler: healthCheck,
  probePath: '/mssp/queries/mssp-roles/v1',
  scopePattern: /Flight Control \(MSSP\) scope/,
})

const MAPPING = item('Tier 2 over managed customers', {
  userGroupId: 'ug-live-1',
  cidGroupId: 'cg-live-1',
  roleIds: 'falcon_analyst, falcon_investigator',
})

/** `bindingLabel` joins the two ids with a ↔, and the check name embeds it. */
const CHECK = 'role-mapping:ug-live-1 ↔ cg-live-1'
const LINK_ID = 'ug-live-1:cg-live-1'

const QUERY = /\/mssp\/queries\/mssp-roles\/v1/
const ENTITY = /\/mssp\/entities\/mssp-roles\/v1/

/**
 * The reachability probe and the per-binding lookup hit the SAME query endpoint,
 * so that route carries a two-entry queue: the probe first, then the lookup.
 */
function tenant(opts: { lookup?: CannedResponse; roles?: CannedResponse }) {
  return routeFetch([
    { url: ENTITY, method: 'GET', respond: opts.roles ?? EMPTY },
    { url: QUERY, respond: [EMPTY, opts.lookup ?? EMPTY] },
  ])
}

test('mssp-role-mappings healthCheck: passes when the binding carries every declared role', async () => {
  const { calls, restore } = tenant({
    lookup: idsPage([LINK_ID]),
    roles: entityPage([{ id: LINK_ID, role_ids: ['falcon_analyst', 'falcon_investigator'] }]),
  })
  try {
    const result = await healthCheck(healthContext([MAPPING]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === CHECK)
    assert.ok(check, `expected a per-binding check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('mssp-role-mappings healthCheck: fails when a declared role was revoked in the console', async () => {
  const { restore } = tenant({
    lookup: idsPage([LINK_ID]),
    roles: entityPage([{ id: LINK_ID, role_ids: ['falcon_analyst'] }]),
  })
  try {
    const result = await healthCheck(healthContext([MAPPING]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === CHECK)
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /missing declared role/)
    assert.match(String(check.message), /falcon_investigator/)
  } finally {
    restore()
  }
})

test('mssp-role-mappings healthCheck: fails when the binding no longer exists at all', async () => {
  // The analyst group has lost every role on this customer group.
  const { restore } = tenant({})
  try {
    const result = await healthCheck(healthContext([MAPPING]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === CHECK)
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('mssp-role-mappings healthCheck: does not look for bindings when Flight Control is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every binding would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([MAPPING]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('role-mapping:')),
      false,
      'an unreadable tenant must not be reported as the binding being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('user_group_id=')).length,
      0,
      'no per-binding lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('mssp-role-mappings healthCheck: reports a failed per-binding lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-binding query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([MAPPING]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === CHECK)
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})

test('mssp-role-mappings healthCheck: reports a failed role read as failed, not as a present binding', async () => {
  const { restore } = tenant({ lookup: idsPage([LINK_ID]), roles: serverError('internal server error') })
  try {
    const result = await healthCheck(healthContext([MAPPING]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === CHECK)
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
