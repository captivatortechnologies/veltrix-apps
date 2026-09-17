// driftDetect for host-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is the comparison itself — and the one that matters is
// `assignment_rule`. A dynamic group's rule IS its security boundary: every
// prevention policy, IOC and FileVantage policy attached to the group applies to
// exactly what the rule matches, so a rule widened or narrowed in the console
// silently changes what is protected.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const RULE = "platform_name:'Windows'+tags:'SensorGroupingTags/production'"

const GROUP = item('Production servers', {
  name: 'prod-servers',
  description: 'Tier 1 production estate',
  groupType: 'dynamic',
  assignmentRule: RULE,
})

registerDriftContract({ label: 'host-groups', handler: driftDetect, items: [GROUP] })

/** The live group exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'hg-live-1',
  name: 'prod-servers',
  description: 'Tier 1 production estate',
  group_type: 'dynamic',
  assignment_rule: RULE,
  ...over,
})

/**
 * Host groups read through the COMBINED endpoint, which answers with objects in
 * one call — unlike the entity/FileVantage adapters' two-call id-then-get.
 */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null ? [TOKEN, entityPage([])] : [TOKEN, entityPage([entity])]
}

test('host-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('host-groups driftDetect: reports an assignment rule edited in the Falcon console as critical', async () => {
  // The group now matches every Linux host instead of tagged Windows ones —
  // every policy on the group followed it there.
  const { restore } = recordFetch(lookup(live({ assignment_rule: "platform_name:'Linux'" })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'prod-servers.assignmentRule')
    assert.ok(diff, `expected an assignmentRule diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, RULE)
    assert.equal(diff.actual, "platform_name:'Linux'")
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('host-groups driftDetect: reports an assignment rule cleared in the console', async () => {
  const { restore } = recordFetch(lookup(live({ assignment_rule: '' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-servers.assignmentRule')
    assert.ok(diff, `expected an assignmentRule diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not set')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('host-groups driftDetect: reports a group recreated with a different type as critical', async () => {
  // group_type is immutable via the API, so a mismatch means the group an
  // operator sees under this name is not the one this configuration deployed.
  const { restore } = recordFetch(lookup(live({ group_type: 'static', assignment_rule: RULE })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-servers.groupType')
    assert.ok(diff, `expected a groupType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'dynamic')
    assert.equal(diff.actual, 'static')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('host-groups driftDetect: reports a description change as informational, not critical', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-servers.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'info', 'a description change does not change what is protected')
  } finally {
    restore()
  }
})

test('host-groups driftDetect: leaves the assignment rule unmanaged for a static group', async () => {
  // Static membership is managed with host actions in the console, not by this
  // app, so a rule this configuration never declared is not its drift to report.
  const STATIC = item('Break-glass hosts', { name: 'breakglass', groupType: 'static' })
  const { restore } = recordFetch(
    lookup({ id: 'hg-live-2', name: 'breakglass', group_type: 'static', assignment_rule: "hostname:'x'" }),
  )
  try {
    const result = await driftDetect(driftContext([STATIC]))

    assert.equal(
      result.diffs.some((d) => d.field === 'breakglass.assignmentRule'),
      false,
      'an undeclared assignment rule must not drift',
    )
  } finally {
    restore()
  }
})

test('host-groups driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        assignment_rule: "platform_name:'Linux'",
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-servers.assignmentRule')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('host-groups driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(live({ assignment_rule: "platform_name:'Linux'", modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'prod-servers.assignmentRule')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('host-groups driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Production servers', {
    name: 'prod-servers',
    description: 'Tier 1 production estate',
    groupType: 'dynamic',
    assignmentRule: "platform_name:'Mac'",
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
