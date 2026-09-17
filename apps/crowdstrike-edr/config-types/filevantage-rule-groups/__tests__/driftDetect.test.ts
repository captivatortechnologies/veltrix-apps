// driftDetect for filevantage-rule-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is that the rules are a SECOND read — the group entity only
// carries references — and the rules are what actually decide which paths are
// watched. A group that is present and correctly typed can have had its one rule
// deleted, or its watched attributes turned off, and nothing else would notice.

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

const WATCHED_PATH = 'C:\\Windows\\System32'

const DECLARED_RULE = {
  path: WATCHED_PATH,
  severity: 'High',
  depth: 'ANY',
  description: 'System binaries',
  watch_write_file_changes: true,
  watch_delete_file_changes: true,
}

const GROUP = item('System binary monitoring', {
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  description: 'Monitored system paths',
  rules: JSON.stringify([DECLARED_RULE]),
})

registerDriftContract({ label: 'filevantage-rule-groups', handler: driftDetect, items: [GROUP] })

const liveRule = (over: Record<string, unknown> = {}) => ({
  id: 'fvr-1',
  precedence: 1,
  path: WATCHED_PATH,
  severity: 'High',
  depth: 'ANY',
  description: 'System binaries',
  watch_write_file_changes: true,
  watch_delete_file_changes: true,
  ...over,
})

/** The live group exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'fvrg-live-1',
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  description: 'Monitored system paths',
  assigned_rules: [{ id: 'fvr-1' }],
  ...over,
})

/**
 * FileVantage rule groups take THREE reads: the name id query, the group entity,
 * and then the rule bodies from the separate rule-groups-rules path. A group
 * with no rule references skips the third.
 */
function lookup(entity: Record<string, unknown> | null, rules: unknown[] = [liveRule()]) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity]), entityPage(rules)]
}

test('filevantage-rule-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('filevantage-rule-groups driftDetect: reports a declared rule deleted from the group', async () => {
  // The group is still there and still correctly typed; the path it was deployed
  // to watch is simply no longer watched.
  const { restore } = recordFetch(lookup(live({ assigned_rules: [] }), []))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `veltrix-fim-system.rules.${WATCHED_PATH}`)
    assert.ok(diff, `expected a rule-presence diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'present')
    assert.equal(diff.actual, 'not present on group')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: reports a rule severity lowered in the console', async () => {
  const { restore } = recordFetch(lookup(live(), [liveRule({ severity: 'Low' })]))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === `veltrix-fim-system.rules.${WATCHED_PATH}`)
    assert.ok(diff, `expected a rule-configuration diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'configuration drifted')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: reports a watched attribute switched off', async () => {
  // Every change event this rule was deployed to raise comes from these toggles.
  const { restore } = recordFetch(lookup(live(), [liveRule({ watch_write_file_changes: false })]))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.ok(
      result.diffs.some((d) => d.field === `veltrix-fim-system.rules.${WATCHED_PATH}`),
      `expected a rule diff, got ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: reports a rule whose exclusion list was widened', async () => {
  // An exclusion added by hand quietly stops the rule raising events for
  // whatever it covers, without removing the rule.
  const { restore } = recordFetch(lookup(live(), [liveRule({ exclude: '**\\update.exe' })]))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.ok(
      result.diffs.some((d) => d.field === `veltrix-fim-system.rules.${WATCHED_PATH}`),
      `expected a rule diff, got ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: reports a group recreated with a different type', async () => {
  const { restore } = recordFetch(lookup(live({ type: 'WindowsRegistry' }), []))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-system.type')
    assert.ok(diff, `expected a type diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'WindowsFiles')
    assert.equal(diff.actual, 'WindowsRegistry')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: reports a description change as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-system.description')
    assert.ok(diff)
    assert.equal(diff.severity, 'info', 'a description change does not change what is monitored')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: ignores a live rule this canvas never declared', async () => {
  // Deploy leaves undeclared rules alone, so drift must agree — reporting an
  // analyst's own watched path as drift would invite a "fix" that deletes it.
  const analyst = liveRule({ id: 'fvr-analyst', path: 'C:\\Temp', description: 'analyst path' })
  const { restore } = recordFetch(
    lookup(live({ assigned_rules: [{ id: 'fvr-1' }, { id: 'fvr-analyst' }] }), [liveRule(), analyst]),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false, `undeclared rule read as drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        type: 'WindowsRegistry',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
      [],
    ),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-system.type')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ type: 'WindowsRegistry', modified_by: CLIENT_ID }), []))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fim-system.type')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('System binary monitoring', {
    name: 'veltrix-fim-system',
    type: 'WindowsFiles',
    description: 'Monitored system paths',
    rules: JSON.stringify([{ ...DECLARED_RULE, severity: 'Low' }]),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
