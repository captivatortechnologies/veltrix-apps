// driftDetect for mssp-cid-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is the membership comparison — a child CID added or removed
// in the Falcon console changes which CUSTOMER tenants the MSSP's analysts can
// see, which is the whole point of watching this object.

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

const QUERY = /\/mssp\/queries\/cid-groups\/v1/
const ENTITY_GET = /\/mssp\/entities\/cid-groups\/v2/
const MEMBERS_GET = /\/mssp\/entities\/cid-group-members\/v2/

const CID_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const CID_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'
const CID_UNDECLARED = '0123456789abcdef0123456789abcdef'

const GROUP = item('Managed customers', {
  name: 'Tier 1 managed customers',
  description: 'Customers under 24x7 monitoring',
  cids: `${CID_A}, ${CID_B}`,
})

registerDriftContract({ label: 'mssp-cid-groups', handler: driftDetect, items: [GROUP] })

/** The live group exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'cg-live-1',
  name: 'Tier 1 managed customers',
  description: 'Customers under 24x7 monitoring',
  ...over,
})

/** The name query, the entity read it feeds, and the membership read after it. */
function tenant(group: Record<string, unknown> | null, members: string[] | CannedResponse = [CID_A, CID_B]) {
  return routeFetch([
    {
      url: MEMBERS_GET,
      respond: Array.isArray(members)
        ? entityPage([{ cid_group_id: 'cg-live-1', cids: members }])
        : members,
    },
    { url: ENTITY_GET, respond: group ? entityPage([group]) : EMPTY },
    { url: QUERY, respond: group ? idsPage([String(group.id)]) : EMPTY },
  ])
}

test('mssp-cid-groups driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = tenant(live())
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: reports a customer CID added in the Falcon console', async () => {
  // Analysts can now see a tenant nobody declared — an access change made
  // outside the canvas.
  const { restore } = tenant(live(), [CID_A, CID_B, CID_UNDECLARED])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Tier 1 managed customers.cids')
    assert.ok(diff, `expected a cids diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), new RegExp(CID_UNDECLARED))
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: reports a customer CID removed in the Falcon console', async () => {
  const { restore } = tenant(live(), [CID_A])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Tier 1 managed customers.cids')
    assert.ok(diff, `expected a cids diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, `${CID_A}, ${CID_B}`)
    assert.equal(diff.actual, CID_A)
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: ignores member ORDER, which Falcon does not preserve', async () => {
  const { restore } = tenant(live(), [CID_B, CID_A])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false, `reordered members are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: reports a description edited by hand', async () => {
  const { restore } = tenant(live({ description: 'legacy description nobody updated' }))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Tier 1 managed customers.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Customers under 24x7 monitoring')
    assert.equal(diff.actual, 'legacy description nobody updated')
    assert.equal(diff.severity, 'info', 'a description is cosmetic next to the member set')
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: a failed membership read is never reported as the group being gone', async () => {
  // The group resolved; the membership read 500ed. That is "I could not look",
  // and turning it into `missing` tells an operator the group was deleted.
  const { restore } = tenant(live(), serverError())
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(
      result.diffs.some((d) => d.actual === 'missing'),
      false,
      `a 500 became "missing": ${JSON.stringify(result.diffs)}`,
    )
    assert.equal(result.hasDrift, true, 'an unreadable member set must not come back as "in sync"')
    assert.match(String(result.diffs[0].actual), /unreachable/)
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = tenant(
    live({
      description: 'legacy description nobody updated',
      modified_by: 'bob@acme.com',
      modified_timestamp: '2026-01-04T10:00:00Z',
    }),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Tier 1 managed customers.description')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'bob@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = tenant(live({ description: 'legacy description nobody updated', modified_by: CLIENT_ID }))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Tier 1 managed customers.description')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('mssp-cid-groups driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Managed customers', {
    name: 'Tier 1 managed customers',
    description: 'Customers under 24x7 monitoring',
    cids: `${CID_A}, ${CID_B}, ${CID_UNDECLARED}`,
  })
  const { restore } = tenant(live())
  try {
    const result = await driftDetect(driftContext([GROUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
