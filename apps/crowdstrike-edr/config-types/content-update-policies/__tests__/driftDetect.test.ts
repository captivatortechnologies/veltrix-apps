// driftDetect for content-update-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the ring comparison — each DECLARED content
// category is compared on its ring assignment and, only when the canvas pins
// one, its delay; a category paused in the console where the canvas asked for
// content to flow is critical, because the hosts stop receiving rapid-response
// content while the policy still looks deployed.

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

const POLICY = item('Rapid response rings', {
  name: 'Corp Content Rings',
  description: 'EA for sensor ops, GA elsewhere',
  enabled: true,
  hostGroups: 'hg-canary, hg-workstations',
  settings: JSON.stringify({
    ring_assignment_settings: [
      { id: 'sensor_operations', ring_assignment: 'ea' },
      { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
    ],
  }),
})

registerDriftContract({ label: 'content-update-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'Corp Content Rings',
  description: 'EA for sensor ops, GA elsewhere',
  enabled: true,
  groups: [{ id: 'hg-canary' }, { id: 'hg-workstations' }],
  settings: {
    ring_assignment_settings: [
      { id: 'sensor_operations', ring_assignment: 'ea' },
      { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
    ],
  },
  ...over,
})

/** The single combined-query call a policy-family lookup performs. */
const lookup = (policy: Record<string, unknown>) => [TOKEN, entityPage([policy])]

test('content-update-policies driftDetect: reports no drift when the tenant matches', async () => {
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

test('content-update-policies driftDetect: reports a policy switched off in the Falcon console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reports a content category paused in the console as critical', async () => {
  // The canvas asks for content to flow; the tenant has it paused. Hosts stop
  // receiving rapid-response content while the policy still reads as deployed.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          ring_assignment_settings: [
            { id: 'sensor_operations', ring_assignment: 'pause' },
            { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.settings.sensor_operations')
    assert.ok(diff, `expected a ring diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /pause/)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reports a ring moved between GA and EA as a warning', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          ring_assignment_settings: [
            { id: 'sensor_operations', ring_assignment: 'ga' },
            { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.settings.sensor_operations')
    assert.ok(diff)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reports a delay added to a category the canvas pinned at zero', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          ring_assignment_settings: [
            { id: 'sensor_operations', ring_assignment: 'ea' },
            { id: 'system_critical', ring_assignment: 'ga', delay_hours: '48' },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.settings.system_critical')
    assert.ok(diff, `expected a delay diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /48/)
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: leaves the delay unmanaged when the canvas pins none', async () => {
  // A ring declared without delay_hours does not own the tenant's delay, so a
  // delay set in the console is not this configuration's drift to report.
  const unpinned = item('Rapid response rings', {
    name: 'Corp Content Rings',
    description: 'EA for sensor ops, GA elsewhere',
    enabled: true,
    hostGroups: 'hg-canary, hg-workstations',
    settings: JSON.stringify({
      ring_assignment_settings: [
        { id: 'sensor_operations', ring_assignment: 'ea' },
        { id: 'system_critical', ring_assignment: 'ga' },
      ],
    }),
  })
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          ring_assignment_settings: [
            { id: 'sensor_operations', ring_assignment: 'ea' },
            { id: 'system_critical', ring_assignment: 'ga', delay_hours: '48' },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([unpinned]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Corp Content Rings.settings.system_critical'),
      false,
      'an undeclared delay must not drift',
    )
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reports a declared category the policy no longer carries', async () => {
  const { restore } = recordFetch(
    lookup(live({ settings: { ring_assignment_settings: [{ id: 'sensor_operations', ring_assignment: 'ea' }] } })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.settings.system_critical')
    assert.ok(diff)
    assert.equal(diff.actual, 'not present on policy')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: leaves categories the canvas never declared unmanaged', async () => {
  // This configuration owns the categories it lists, not the whole policy.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          ring_assignment_settings: [
            { id: 'sensor_operations', ring_assignment: 'ea' },
            { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
            { id: 'vulnerability_management', ring_assignment: 'pause' },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `undeclared categories drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reports a host group detached in the console', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-canary' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-canary, hg-workstations')
    assert.equal(diff.actual, 'hg-canary')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-workstations' }, { id: 'hg-canary' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `reordered groups are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reports a description edited by hand as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited in the console' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'edited in the console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ enabled: false, modified_by: 'alice@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Content Rings.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('content-update-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Rapid response rings', {
    name: 'Corp Content Rings',
    description: 'EA for sensor ops, GA elsewhere',
    enabled: true,
    hostGroups: 'hg-canary, hg-workstations',
    settings: JSON.stringify({
      ring_assignment_settings: [
        { id: 'sensor_operations', ring_assignment: 'ga' },
        { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
      ],
    }),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
