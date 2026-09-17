// driftDetect for cloud-compliance-controls.
//
// The shared contract covers the invariants: drift never writes, a deleted
// control is critical drift, and a 500 is never reported as the control being
// gone. What is specific here is the comparison — description, section and
// parent framework off the control entity, plus the assigned rule IDs, which the
// control entity does NOT carry and which are read back from the Cloud Security
// rules collection using the live control's framework name + section +
// requirement.
//
// NOT ASSERTED, deliberately: what happens when the live control carries no
// `requirement`. `readAssignedRuleIds` returns [] for incomplete coordinates —
// "I could not look" turned into "there are none" — so the declared rule set
// reads as unassigned. Asserting either outcome would bless that; see the
// accompanying report.

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
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const CONTROL = item('Access control — MFA', {
  name: 'Require MFA on console access',
  frameworkId: 'fw-live-1',
  section: 'Access Control',
  description: 'Every human console login uses MFA',
  ruleIds: 'rule-a, rule-b',
})

registerDriftContract({ label: 'cloud-compliance-controls', handler: driftDetect, items: [CONTROL] })

/** The live control exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  uuid: 'ctl-live-1',
  name: 'Require MFA on console access',
  section_name: 'Access Control',
  description: 'Every human console login uses MFA',
  requirement: 'AC-2',
  security_framework: [{ uuid: 'fw-live-1', name: 'ACME Cloud Baseline' }],
  ...over,
})

/**
 * The three reads a control comparison performs: the id query, the entity get,
 * and the rules query that resolves the control's current assignments.
 */
function lookup(entity: Record<string, unknown>, rules: CannedResponse): CannedResponse[] {
  return [TOKEN, idsPage([String(entity.uuid)]), entityPage([entity]), rules]
}

const ASSIGNED = idsPage(['rule-a', 'rule-b'])

test('cloud-compliance-controls driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live(), ASSIGNED))
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: reports a description rewritten in the Falcon console', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' }), ASSIGNED))
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Require MFA on console access.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Every human console login uses MFA')
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: reports a control re-homed in the console as critical drift', async () => {
  // Framework and section are part of the control's IDENTITY, so a control moved
  // to either no longer resolves at the declared coordinates. What is asserted
  // is that this is still critical drift. `diffControl`'s own `.section` and
  // `.frameworkId` branches are NOT asserted: `findControl` pins both before
  // returning, so they can never run — see the accompanying report.
  const { restore } = recordFetch(
    lookup(live({ security_framework: [{ uuid: 'fw-other-1', name: 'Other Baseline' }] }), ASSIGNED),
  )
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    assert.equal(result.hasDrift, true, 'a control that left its framework is drift')
    assert.ok(
      result.diffs.some((d) => d.severity === 'critical'),
      `expected critical drift, got ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: reports rule assignments changed in the console', async () => {
  const { restore } = recordFetch(lookup(live(), idsPage(['rule-a'])))
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    const diff = result.diffs.find((d) => d.field === 'Require MFA on console access.ruleIds')
    assert.ok(diff, `expected a ruleIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'rule-a, rule-b')
    assert.equal(diff.actual, 'rule-a')
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: ignores rule assignment ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live(), idsPage(['rule-b', 'rule-a'])))
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    assert.equal(
      result.hasDrift,
      false,
      `reordered rule assignments are not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: a failed rules read is never reported as the assignments being cleared', async () => {
  // The control read fine and the RULES query then 500d. Letting that become an
  // empty list would tell an operator every rule had been un-assigned from a
  // control that is in fact untouched.
  const { calls, restore } = recordFetch(lookup(live(), serverError()))
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    const cleared = result.diffs.find(
      (d) => d.field === 'Require MFA on console access.ruleIds' && d.actual === 'none',
    )
    assert.equal(cleared, undefined, `a 500 became "no rules assigned": ${JSON.stringify(result.diffs)}`)
    assert.match(String(result.diffs[0]?.actual), /^unreachable:/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        description: 'edited by hand',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
      ASSIGNED,
    ),
  )
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    const diff = result.diffs.find((d) => d.field === 'Require MFA on console access.description')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(live({ description: 'edited by hand', modified_by: CLIENT_ID }), ASSIGNED),
  )
  try {
    const result = await driftDetect(driftContext([CONTROL]))

    const diff = result.diffs.find((d) => d.field === 'Require MFA on console access.description')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-compliance-controls driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Access control — MFA', {
    name: 'Require MFA on console access',
    frameworkId: 'fw-live-1',
    section: 'Access Control',
    description: 'a description nobody has deployed yet',
    ruleIds: 'rule-a, rule-b, rule-c',
  })
  const { restore } = recordFetch(lookup(live(), ASSIGNED))
  try {
    const result = await driftDetect(driftContext([CONTROL], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
