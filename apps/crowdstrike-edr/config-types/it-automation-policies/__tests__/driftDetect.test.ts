// driftDetect for it-automation-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the comparison itself — enablement, the
// execution-config keys the canvas declared (and ONLY those), description, and
// the host groups that decide which machines the policy governs.

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

const EXECUTION_CONFIG = JSON.stringify({
  execution: { enable_script_execution: true, execution_timeout: 4, execution_timeout_unit: 'Hours' },
  concurrency: { concurrent_host_limit: 50 },
})

const POLICY = item('Windows automation', {
  name: 'win-it-automation',
  platform: 'Windows',
  enabled: true,
  description: 'Tier 1 automation policy',
  executionConfig: EXECUTION_CONFIG,
  hostGroups: 'hg-prod-1, hg-prod-2',
})

registerDriftContract({ label: 'it-automation-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'win-it-automation',
  platform: 'Windows',
  description: 'Tier 1 automation policy',
  is_enabled: true,
  config: {
    execution: { enable_script_execution: true, execution_timeout: 4, execution_timeout_unit: 'Hours' },
    concurrency: { concurrent_host_limit: 50 },
  },
  host_group_ids: ['hg-prod-1', 'hg-prod-2'],
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('it-automation-policies driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: reports a policy disabled in the Falcon console', async () => {
  const { restore } = recordFetch(lookup(live({ is_enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'win-it-automation.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: reports an execution setting changed by hand', async () => {
  // Script execution turned off in the console is the difference between the
  // automation estate working and silently doing nothing.
  const { restore } = recordFetch(
    lookup(
      live({
        config: {
          execution: {
            enable_script_execution: false,
            execution_timeout: 4,
            execution_timeout_unit: 'Hours',
          },
          concurrency: { concurrent_host_limit: 50 },
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find(
      (d) => d.field === 'win-it-automation.config.execution.enable_script_execution',
    )
    assert.ok(diff, `expected a config diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: reports a declared config key the live policy no longer carries', async () => {
  const { restore } = recordFetch(
    lookup(live({ config: { concurrency: { concurrent_host_limit: 50 } } })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'win-it-automation.config.execution.execution_timeout')
    assert.ok(diff, `expected a missing-key diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not present on policy')
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: ignores live config keys the canvas never declared', async () => {
  // A setting this configuration does not manage is not this configuration's
  // drift to report — otherwise every Falcon default would read as a change.
  const { restore } = recordFetch(
    lookup(
      live({
        config: {
          execution: {
            enable_script_execution: true,
            execution_timeout: 4,
            execution_timeout_unit: 'Hours',
            enable_os_query: true,
          },
          concurrency: { concurrent_host_limit: 50 },
          resources: { cpu_throttle: 25 },
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `undeclared keys drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: reports host groups reassigned in the console', async () => {
  const { restore } = recordFetch(lookup(live({ host_group_ids: ['hg-lab-3'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'win-it-automation.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-prod-1, hg-prod-2')
    assert.equal(diff.actual, 'hg-lab-3')
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ host_group_ids: ['hg-prod-2', 'hg-prod-1'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `reordered groups are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: does not report host groups the live policy never exposed', async () => {
  // The API returned no assignment field at all. "I could not see it" must not
  // become "it is empty" — that would report every policy as untargeted.
  const noGroups = live()
  delete (noGroups as { host_group_ids?: unknown }).host_group_ids
  const { restore } = recordFetch(lookup(noGroups))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'win-it-automation.hostGroups'),
      false,
      'an unreadable assignment must not be reported as drift',
    )
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: attributes a manual change to the operator who made it', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'win-it-automation.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ is_enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'win-it-automation.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('it-automation-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows automation', {
    name: 'win-it-automation',
    platform: 'Windows',
    enabled: false,
    description: 'Tier 1 automation policy',
    executionConfig: EXECUTION_CONFIG,
    hostGroups: 'hg-prod-1, hg-prod-2',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
