// driftDetect for cloud-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is the comparison itself — business impact, environment,
// business unit, description and owners are always compared; scope (selectors)
// only when the canvas declared it — plus the attribution that rides on the live
// group's `updated_by`.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const GROUP = item('Production workloads', {
  name: 'prod-workloads',
  description: 'Tier 1 production estate',
  businessImpact: 'high',
  businessUnit: 'Payments',
  environment: 'prod',
  owners: 'sec@acme.com, cloudops@acme.com',
})

registerDriftContract({ label: 'cloud-groups', handler: driftDetect, items: [GROUP] })

/** The live group exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'grp-live-1',
  name: 'prod-workloads',
  description: 'Tier 1 production estate',
  business_impact: 'high',
  business_unit: 'Payments',
  environment: 'prod',
  owners: ['sec@acme.com', 'cloudops@acme.com'],
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('cloud-groups driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: reports a business impact downgraded in the Falcon console', async () => {
  const { restore } = recordFetch(lookup(live({ business_impact: 'low' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'prod-workloads.businessImpact')
    assert.ok(diff, `expected a businessImpact diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'high')
    assert.equal(diff.actual, 'low')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: reports an owner list edited by hand', async () => {
  const { restore } = recordFetch(lookup(live({ owners: ['sec@acme.com'] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-workloads.owners')
    assert.ok(diff, `expected an owners diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'sec@acme.com')
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: ignores owner ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ owners: ['cloudops@acme.com', 'sec@acme.com'] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false, `reordered owners are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: leaves scope unmanaged when the canvas declared none', async () => {
  // A metadata-only group does not own the tenant's scoping, so a selector set
  // by hand in the console is not this configuration's drift to report.
  const { restore } = recordFetch(
    lookup(live({ selectors: { cloud_resources: [{ cloud_provider: 'aws', account_ids: ['1'] }] } })),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(
      result.diffs.some((d) => d.field === 'prod-workloads.scoping'),
      false,
      'an undeclared scope must not drift',
    )
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ business_impact: 'low', updated_by: 'alice@acme.com', updated_at: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-workloads.businessImpact')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ business_impact: 'low', updated_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-workloads.businessImpact')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-groups driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Production workloads', {
    name: 'prod-workloads',
    description: 'Tier 1 production estate',
    businessImpact: 'moderate',
    businessUnit: 'Payments',
    environment: 'prod',
    owners: 'sec@acme.com, cloudops@acme.com',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
