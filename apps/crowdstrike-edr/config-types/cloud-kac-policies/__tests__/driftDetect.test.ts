// driftDetect for cloud-kac-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the comparison — enablement is critical because
// a disabled admission policy admits everything, host groups decide which
// clusters it applies to, and the declared rule groups are deep-compared against
// the live ones.
//
// The base fixture deliberately declares NO rule groups: deploy does not push
// them yet (the policy write body takes only name/description/enabled), so a
// canvas that declares rule groups drifts against every tenant by construction.
// That gap is exercised once, on its own, rather than baked into every case.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  CannedResponse,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const POLICY = item('Cluster admission', {
  name: 'Cluster admission',
  description: 'Block unsigned images at admission',
  enabled: true,
  defaultAction: 'Prevent',
  hostGroups: 'hg-1, hg-2',
})

registerDriftContract({ label: 'cloud-kac-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'kac-live-1',
  name: 'Cluster admission',
  description: 'Block unsigned images at admission',
  is_enabled: true,
  host_groups: ['hg-1', 'hg-2'],
  rule_groups: [],
  ...over,
})

/** The two-call lookup a KAC policy read performs: id query, then get. */
function lookup(entity: Record<string, unknown>): CannedResponse[] {
  return [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('cloud-kac-policies driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reports a policy disabled in the console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ is_enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Cluster admission.enabled')
    assert.ok(diff, `expected an enablement diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical', 'a disabled admission policy admits everything')
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reads enablement off the read model as well as the write model', async () => {
  // The write body uses `is_enabled`; reads may surface `enabled`. Missing that
  // would report every healthy policy as drifted.
  const { restore } = recordFetch(
    lookup({
      id: 'kac-live-1',
      name: 'Cluster admission',
      description: 'Block unsigned images at admission',
      enabled: true,
      host_groups: ['hg-1', 'hg-2'],
    }),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Cluster admission.enabled'),
      false,
      `enablement read as drifted: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reports host group assignments changed in the console', async () => {
  // Host groups decide which clusters the policy applies to — a group removed by
  // hand silently un-gates those clusters.
  const { restore } = recordFetch(lookup(live({ host_groups: ['hg-1'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Cluster admission.hostGroups')
    assert.ok(diff, `expected a host group diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-1, hg-2')
    assert.equal(diff.actual, 'hg-1')
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: ignores host group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ host_groups: ['hg-2', 'hg-1'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.hasDrift,
      false,
      `reordered host groups are not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reads host groups whether Falcon returns ids or objects', async () => {
  const { restore } = recordFetch(
    lookup(live({ host_groups: undefined, groups: [{ id: 'hg-1' }, { id: 'hg-2' }] })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Cluster admission.hostGroups'),
      false,
      `an object-shaped group list read as drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reports declared rule groups the tenant does not carry', async () => {
  // Deploy converges only the scalar fields today, so a canvas that declares
  // rule groups is genuinely out of step with the tenant until they are pushed.
  const withRuleGroups = item('Cluster admission', {
    name: 'Cluster admission',
    description: 'Block unsigned images at admission',
    enabled: true,
    hostGroups: 'hg-1, hg-2',
    ruleGroups: '[{"name":"Baseline"}]',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([withRuleGroups]))

    const diff = result.diffs.find((d) => d.field === 'Cluster admission.ruleGroups')
    assert.ok(diff, `expected a rule group diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '1 rule group(s)')
    assert.equal(diff.actual, '0 rule group(s)')
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reports a description edited in the console as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Cluster admission.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'info', 'a description does not change what the policy admits')
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        is_enabled: false,
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Cluster admission.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ is_enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Cluster admission.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-kac-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Cluster admission', {
    name: 'Cluster admission',
    description: 'Block unsigned images at admission',
    enabled: false,
    hostGroups: 'hg-1, hg-2, hg-3',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
