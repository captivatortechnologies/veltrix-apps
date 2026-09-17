// driftDetect for mssp-role-mappings.
//
// The shared contract covers the invariants: drift never writes, a declared
// binding the tenant no longer holds is critical drift, and a 500 is never
// reported as it being gone. It is registered with `absentActual: 'no mapping'`
// — this handler words absence for its own resource rather than with the
// catalog's usual `'missing'`, which the contract now accommodates.
//
// What is specific beyond that is the role-set comparison, and its asymmetry: a
// MISSING declared role under-provisions an analyst team (critical), an EXTRA
// role is a leftover of the additive grant that over-provisions it (warning).

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
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/mssp\/queries\/mssp-roles\/v1/
const ENTITY = /\/mssp\/entities\/mssp-roles\/v1/

const LINK_ID = 'ug-live-1:cg-live-1'
/** `bindingLabel` joins the two ids with a ↔; every diff field is prefixed with it. */
const LABEL = 'ug-live-1 ↔ cg-live-1'

const MAPPING = item('Tier 2 over managed customers', {
  userGroupId: 'ug-live-1',
  cidGroupId: 'cg-live-1',
  roleIds: 'falcon_analyst, falcon_investigator',
})

/** The binding's link-id query, then the role resource read it feeds. */
function tenant(
  roleIds: string[] | null,
  over: Record<string, unknown> = {},
  entity?: CannedResponse,
) {
  return routeFetch([
    {
      url: ENTITY,
      method: 'GET',
      respond: entity ?? entityPage([{ id: LINK_ID, role_ids: roleIds ?? [], ...over }]),
    },
    { url: QUERY, respond: roleIds === null ? EMPTY : idsPage([LINK_ID]) },
  ])
}

registerDriftContract({
  label: 'mssp-role-mappings',
  handler: driftDetect,
  items: [MAPPING],
  // There is no endpoint that deletes a binding — a binding with no roles IS the
  // removed state, so this handler words absence for its own resource.
  absentActual: 'no mapping',
})

test('mssp-role-mappings driftDetect: reports no drift when the live roles match', async () => {
  const { calls, restore } = tenant(['falcon_analyst', 'falcon_investigator'])
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: reports a declared role revoked in the console as critical', async () => {
  // The analyst team has lost access the canvas says it should have.
  const { restore } = tenant(['falcon_analyst'])
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.roleIds`)
    assert.ok(diff, `expected a roleIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'falcon_analyst, falcon_investigator')
    assert.equal(diff.actual, 'falcon_analyst')
    assert.equal(diff.severity, 'critical', 'under-provisioned access is the more urgent direction')
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: reports an extra role granted in the console as a warning', async () => {
  // The grant is additive, so a role added by hand simply stays. That is
  // over-provisioned access on a customer tenant — real, but less urgent than an
  // analyst team that cannot work at all.
  const { restore } = tenant(['falcon_analyst', 'falcon_investigator', 'falcon_administrator'])
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.roleIds`)
    assert.ok(diff, `expected a roleIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /falcon_administrator/)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: ignores role ORDER, which Falcon does not preserve', async () => {
  const { restore } = tenant(['falcon_investigator', 'falcon_analyst'])
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    assert.equal(result.hasDrift, false, `reordered roles are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: a failed role read is never reported as the binding being gone', async () => {
  // The link id resolved; the role resource read 500ed. Same rule as the blanket
  // 500 above, one call deeper: an unknown role set must not become "no access".
  const { restore } = tenant([], {}, serverError())
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    assert.equal(
      result.diffs.some((d) => d.actual === 'no mapping' || d.actual === 'missing'),
      false,
      `a 500 became an absent binding: ${JSON.stringify(result.diffs)}`,
    )
    assert.equal(result.hasDrift, true, 'an unreadable binding must not come back as "in sync"')
    assert.match(String(result.diffs[0].actual), /unreachable/)
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = tenant(['falcon_analyst'], {
    modified_by: 'bob@acme.com',
    modified_timestamp: '2026-01-04T10:00:00Z',
  })
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.roleIds`)
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'bob@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = tenant(['falcon_analyst'], { modified_by: CLIENT_ID })
  try {
    const result = await driftDetect(driftContext([MAPPING]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.roleIds`)
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('mssp-role-mappings driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Tier 2 over managed customers', {
    userGroupId: 'ug-live-1',
    cidGroupId: 'cg-live-1',
    roleIds: 'falcon_administrator',
  })
  const { restore } = tenant(['falcon_analyst', 'falcon_investigator'])
  try {
    const result = await driftDetect(driftContext([MAPPING], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
