// driftDetect for custom-ioa-rule-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is that the rules live INSIDE the group, so the comparison
// has to reach into them: a group that is still present and still enabled can
// have had its one rule switched off or its disposition weakened, and nothing
// else in the pipeline would notice.

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

const FIELD_VALUES = [
  { name: 'CommandLine', type: 'excludable', values: [{ label: 'include', value: 'encodedcommand' }] },
]

const DECLARED_RULE = {
  name: 'Encoded PowerShell',
  ruletypeId: '5',
  dispositionId: 30,
  patternSeverity: 'critical',
  fieldValues: FIELD_VALUES,
  enabled: true,
  description: 'Block encoded PowerShell',
}

const GROUP = item('Encoded PowerShell detection', {
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  description: 'Managed IOA rules',
  enabled: true,
  rules: JSON.stringify([DECLARED_RULE]),
})

registerDriftContract({ label: 'custom-ioa-rule-groups', handler: driftDetect, items: [GROUP] })

const liveRule = (over: Record<string, unknown> = {}) => ({
  instance_id: 'ri-1',
  name: 'Encoded PowerShell',
  description: 'Block encoded PowerShell',
  ruletype_id: '5',
  disposition_id: 30,
  pattern_severity: 'critical',
  field_values: FIELD_VALUES,
  enabled: true,
  ...over,
})

/** The live group exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'rg-live-1',
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  description: 'Managed IOA rules',
  enabled: true,
  version: 3,
  rules: [liveRule()],
  ...over,
})

/**
 * IOA rule groups read through the COMBINED endpoint, which answers with whole
 * groups (rules included) in one call — no separate id-then-get step.
 */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null ? [TOKEN, entityPage([])] : [TOKEN, entityPage([entity])]
}

test('custom-ioa-rule-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('custom-ioa-rule-groups driftDetect: reports a group disabled in the console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reports a declared rule removed from the group', async () => {
  const { restore } = recordFetch(lookup(live({ rules: [] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.rules.Encoded PowerShell')
    assert.ok(diff, `expected a rule-presence diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not present on group')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reports a rule switched off inside a live group as critical', async () => {
  // The group is present and enabled, so a presence-only check passes. The rule
  // that does the detecting is off.
  const { restore } = recordFetch(lookup(live({ rules: [liveRule({ enabled: false })] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find(
      (d) => d.field === 'veltrix-ioa-windows.rules.Encoded PowerShell.enabled',
    )
    assert.ok(diff, `expected a rule-enablement diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reports a rule disposition weakened by hand', async () => {
  const { restore } = recordFetch(lookup(live({ rules: [liveRule({ disposition_id: 10 })] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.rules.Encoded PowerShell')
    assert.ok(diff, `expected a rule-field diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.expected), /disposition 30/)
    assert.match(String(diff.actual), /disposition 10/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reports a rule severity lowered by hand', async () => {
  const { restore } = recordFetch(lookup(live({ rules: [liveRule({ pattern_severity: 'low' })] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.rules.Encoded PowerShell')
    assert.ok(diff)
    assert.match(String(diff.actual), /severity low/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reports a group recreated on another platform', async () => {
  // Platform is immutable via the API, so a mismatch means the group an operator
  // sees under this name is not the one this configuration deployed.
  const { restore } = recordFetch(lookup(live({ platform: 'mac' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.platform')
    assert.ok(diff, `expected a platform diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'mac')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reports a description change as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.description')
    assert.ok(diff)
    assert.equal(diff.severity, 'info', 'a description change does not change what is detected')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: ignores a live rule this canvas never declared', async () => {
  // Deploy leaves undeclared rules alone, so drift must agree — reporting an
  // analyst's own rule as drift would invite a "fix" that deletes it.
  const { restore } = recordFetch(
    lookup(live({ rules: [liveRule(), liveRule({ instance_id: 'ri-analyst', name: 'Analyst rule' })] })),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false, `undeclared rule read as drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: attributes a manual change to the operator who made it', async () => {
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
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-ioa-windows.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Encoded PowerShell detection', {
    name: 'veltrix-ioa-windows',
    platform: 'windows',
    description: 'Managed IOA rules',
    enabled: false,
    rules: JSON.stringify([{ ...DECLARED_RULE, dispositionId: 10 }]),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
