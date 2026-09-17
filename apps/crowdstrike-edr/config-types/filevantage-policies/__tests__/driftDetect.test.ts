// driftDetect for filevantage-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is that the two things deciding what a FileVantage
// policy actually watches — which hosts it applies to and which rule groups it
// carries — are not fields on the policy, and the rule groups are ORDERED:
// their order is precedence, so the same set in a different order is drift.

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

const POLICY = item('Windows FIM policy', {
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  description: 'Monitored system paths',
  enabled: true,
  hostGroups: 'hg-prod, hg-dmz',
  ruleGroups: 'rg-system, rg-registry',
})

registerDriftContract({ label: 'filevantage-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'fvp-live-1',
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  description: 'Monitored system paths',
  enabled: true,
  host_groups: ['hg-prod', 'hg-dmz'],
  rule_groups: ['rg-system', 'rg-registry'],
  ...over,
})

/** The two-call lookup every FileVantage read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('filevantage-policies driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reports a policy disabled in the console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reports a host group detached in the console', async () => {
  // The policy still exists and is still enabled; it just no longer applies to
  // the hosts it was deployed for.
  const { restore } = recordFetch(lookup(live({ host_groups: ['hg-prod'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-prod, hg-dmz')
    assert.equal(diff.actual, 'hg-prod')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: ignores host group ORDER, which is not precedence', async () => {
  const { restore } = recordFetch(lookup(live({ host_groups: ['hg-dmz', 'hg-prod'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'veltrix-fim-windows.hostGroups'),
      false,
      `reordered host groups are not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reports rule groups REORDERED, because order is precedence', async () => {
  // The same two rule groups are attached, so a set comparison would pass. Their
  // order decides which rule wins on an overlapping path.
  const { restore } = recordFetch(lookup(live({ rule_groups: ['rg-registry', 'rg-system'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.ruleGroups')
    assert.ok(diff, `expected a ruleGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'rg-system > rg-registry')
    assert.equal(diff.actual, 'rg-registry > rg-system')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reports a rule group detached in the console', async () => {
  const { restore } = recordFetch(lookup(live({ rule_groups: ['rg-system'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.ruleGroups')
    assert.ok(diff)
    assert.equal(diff.actual, 'rg-system')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reports every rule group detached as "none", not as a match', async () => {
  const { restore } = recordFetch(lookup(live({ rule_groups: [] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.ruleGroups')
    assert.ok(diff, 'a policy monitoring nothing must not read as in sync')
    assert.equal(diff.actual, 'none')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reads group assignments given as objects, not just ids', async () => {
  // The policy entity returns these either way; reading only strings would make
  // every attached group look detached and report drift that is not there.
  const { restore } = recordFetch(
    lookup(
      live({
        host_groups: [{ id: 'hg-prod' }, { id: 'hg-dmz' }],
        rule_groups: [{ id: 'rg-system' }, { id: 'rg-registry' }],
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `object-shaped groups read as drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reports a description change as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.description')
    assert.ok(diff)
    assert.equal(diff.severity, 'info', 'a description change does not change what is monitored')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        enabled: false,
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-windows.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('filevantage-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows FIM policy', {
    name: 'veltrix-fim-windows',
    platform: 'Windows',
    description: 'Monitored system paths',
    enabled: false,
    hostGroups: 'hg-lab',
    ruleGroups: 'rg-registry',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
