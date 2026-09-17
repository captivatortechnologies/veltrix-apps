// driftDetect for users.
//
// The shared contract covers the invariants: drift never writes, a deleted user
// is critical drift, and a 500 is never reported as the user being gone. What is
// specific here is the comparison itself — the name fields when the canvas
// declares them, and the DIRECT role grant set when the canvas manages roles,
// where a role the tenant holds but the canvas never declared is unexpected
// privilege and outranks a merely missing one.
//
// NOTE on `writeCalls`: the Falcon bulk read of users is
// `POST /user-management/entities/users/GET/v1`, so a drift run that finds a
// user issues a POST. It is a read; the shared "never writes" contract still
// holds because its everything-absent fixture short-circuits before that call.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  CannedResponse,
  EMPTY,
  driftContext,
  entityPage,
  idsPage,
  item,
  routeFetch,
  serverError,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/user-management\/queries\/users\/v1/
const BULK_GET = /\/user-management\/entities\/users\/GET\/v1/
const USER_ROLES = /\/user-management\/combined\/user-roles\/v2/

const USER = item('Alice Chen', {
  email: 'alice@acme.com',
  firstName: 'Alice',
  lastName: 'Chen',
  roleIds: 'falcon_analyst, falcon_investigator',
})

registerDriftContract({ label: 'users', handler: driftDetect, items: [USER] })

/** The live user exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  uuid: 'usr-live-1',
  uid: 'alice@acme.com',
  first_name: 'Alice',
  last_name: 'Chen',
  ...over,
})

/** The id query, the bulk read it feeds, and the direct-role read after it. */
function tenant(user: Record<string, unknown> | null, roles: string[] | CannedResponse = ['falcon_analyst', 'falcon_investigator']) {
  return routeFetch([
    { url: BULK_GET, method: 'POST', respond: user ? entityPage([user]) : EMPTY },
    { url: QUERY, respond: user ? idsPage([String(user.uuid)]) : EMPTY },
    {
      url: USER_ROLES,
      respond: Array.isArray(roles) ? entityPage(roles.map((role_id) => ({ role_id }))) : roles,
    },
  ])
}

test('users driftDetect: reports no drift when the tenant matches', async () => {
  const { restore } = tenant(live())
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('users driftDetect: reports a role granted in the console that the canvas never declared as critical', async () => {
  // Unexpected privilege on a live account — the reason this config type exists.
  const { restore } = tenant(live(), ['falcon_analyst', 'falcon_investigator', 'falcon_administrator'])
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'alice@acme.com.roleIds')
    assert.ok(diff, `expected a roleIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'critical', 'a role nobody declared is more serious than a missing one')
    assert.match(String(diff.actual), /falcon_administrator/)
  } finally {
    restore()
  }
})

test('users driftDetect: reports a declared role revoked in the console as a warning', async () => {
  const { restore } = tenant(live(), ['falcon_analyst'])
  try {
    const result = await driftDetect(driftContext([USER]))

    const diff = result.diffs.find((d) => d.field === 'alice@acme.com.roleIds')
    assert.ok(diff, `expected a roleIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'warning')
    assert.equal(diff.expected, 'falcon_analyst, falcon_investigator')
    assert.equal(diff.actual, 'falcon_analyst')
  } finally {
    restore()
  }
})

test('users driftDetect: ignores role ORDER, which Falcon does not preserve', async () => {
  const { restore } = tenant(live(), ['falcon_investigator', 'falcon_analyst'])
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, false, `reordered roles are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('users driftDetect: reports a name edited in the Falcon console', async () => {
  const { restore } = tenant(live({ first_name: 'Alicia', last_name: 'Chan' }))
  try {
    const result = await driftDetect(driftContext([USER]))

    const first = result.diffs.find((d) => d.field === 'alice@acme.com.firstName')
    assert.ok(first, `expected a firstName diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(first.expected, 'Alice')
    assert.equal(first.actual, 'Alicia')
    assert.equal(first.severity, 'info', 'a display name is cosmetic next to a role grant')

    const last = result.diffs.find((d) => d.field === 'alice@acme.com.lastName')
    assert.ok(last)
    assert.equal(last.actual, 'Chan')
  } finally {
    restore()
  }
})

test('users driftDetect: leaves roles unmanaged when the canvas declared none', async () => {
  // An item that only invites or renames an account does not own its grants, so
  // a role added in the console is not this configuration's drift to report.
  const NO_ROLES = item('Alice Chen', { email: 'alice@acme.com', firstName: 'Alice', lastName: 'Chen' })
  const { calls, restore } = tenant(live(), ['falcon_administrator'])
  try {
    const result = await driftDetect(driftContext([NO_ROLES]))

    assert.equal(result.hasDrift, false, `undeclared roles must not drift: ${JSON.stringify(result.diffs)}`)
    assert.equal(calls.some((c) => USER_ROLES.test(c.url)), false, 'undeclared roles are not even read')
  } finally {
    restore()
  }
})

test('users driftDetect: a failed role read is never reported as the user being gone', async () => {
  // The user resolved; the role read 500ed. That is "I could not look", and
  // turning it into `missing` tells an operator the account was deleted.
  const { restore } = tenant(live(), serverError())
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(
      result.diffs.some((d) => d.actual === 'missing'),
      false,
      `a 500 became "missing": ${JSON.stringify(result.diffs)}`,
    )
    assert.equal(result.hasDrift, true, 'an unreadable grant set must not come back as "in sync"')
    assert.match(String(result.diffs[0].actual), /unreachable/)
  } finally {
    restore()
  }
})

test('users driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = tenant(
    live({ first_name: 'Alicia', modified_by: 'bob@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' }),
  )
  try {
    const result = await driftDetect(driftContext([USER]))

    const diff = result.diffs.find((d) => d.field === 'alice@acme.com.firstName')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'bob@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('users driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = tenant(live({ first_name: 'Alicia', modified_by: CLIENT_ID }))
  try {
    const result = await driftDetect(driftContext([USER]))

    const diff = result.diffs.find((d) => d.field === 'alice@acme.com.firstName')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('users driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Alice Chen', {
    email: 'alice@acme.com',
    firstName: 'Alicia',
    lastName: 'Chen',
    roleIds: 'falcon_administrator',
  })
  const { restore } = tenant(live())
  try {
    const result = await driftDetect(driftContext([USER], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
