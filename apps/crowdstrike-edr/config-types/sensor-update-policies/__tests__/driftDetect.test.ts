// driftDetect for sensor-update-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the comparison itself — enablement, the pinned
// build (compared ONLY when the canvas pins one), uninstall protection (where
// weakening a declared ENABLED is critical rather than a warning), host-group
// assignment and description — plus the attribution that rides on the live
// policy's `modified_by`.

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

const POLICY = item('Windows sensor updates', {
  name: 'Corp Windows Sensor Updates',
  platform: 'Windows',
  description: 'n-1 pinned build for workstations',
  enabled: true,
  hostGroups: 'hg-workstations, hg-laptops',
  build: '7.14.18110|n-1|Tagged|14',
  uninstall_protection: 'ENABLED',
})

registerDriftContract({ label: 'sensor-update-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'Corp Windows Sensor Updates',
  platform_name: 'Windows',
  description: 'n-1 pinned build for workstations',
  enabled: true,
  groups: [{ id: 'hg-workstations' }, { id: 'hg-laptops' }],
  settings: { build: '7.14.18110|n-1|Tagged|14', uninstall_protection: 'ENABLED' },
  ...over,
})

/** The single combined-query call a policy-family lookup performs. */
const lookup = (policy: Record<string, unknown>) => [TOKEN, entityPage([policy])]

test('sensor-update-policies driftDetect: reports no drift when the tenant matches', async () => {
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

test('sensor-update-policies driftDetect: reports a policy switched off in the Falcon console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Windows Sensor Updates.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: reports a pinned build moved in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ settings: { build: '7.10.16101|n-3|Tagged|14', uninstall_protection: 'ENABLED' } })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Sensor Updates.settings.build')
    assert.ok(diff, `expected a build diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '7.14.18110|n-1|Tagged|14')
    assert.equal(diff.actual, '7.10.16101|n-3|Tagged|14')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: leaves the build unmanaged when the canvas pins none', async () => {
  // A policy declared without a build does not own the tenant's sensor version,
  // so a build set in the console is not this configuration's drift to report.
  const unpinned = item('Windows sensor updates', {
    name: 'Corp Windows Sensor Updates',
    platform: 'Windows',
    description: 'n-1 pinned build for workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    uninstall_protection: 'ENABLED',
  })
  const { restore } = recordFetch(
    lookup(live({ settings: { build: '7.10.16101|n-3|Tagged|14', uninstall_protection: 'ENABLED' } })),
  )
  try {
    const result = await driftDetect(driftContext([unpinned]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Corp Windows Sensor Updates.settings.build'),
      false,
      'an undeclared build must not drift',
    )
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: reports uninstall protection turned off as critical', async () => {
  // Declared ENABLED, live anything else — the sensor can now be removed from
  // the host by whoever has local admin, which is the whole point of the field.
  const { restore } = recordFetch(
    lookup(live({ settings: { build: '7.14.18110|n-1|Tagged|14', uninstall_protection: 'DISABLED' } })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find(
      (d) => d.field === 'Corp Windows Sensor Updates.settings.uninstall_protection',
    )
    assert.ok(diff, `expected an uninstall_protection diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ENABLED')
    assert.equal(diff.actual, 'DISABLED')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: a policy with no settings object reads as protection DISABLED', async () => {
  // A missing settings object is not "unknown" for this field — Falcon's
  // default is off, and the declared ENABLED is therefore not in effect.
  const { restore } = recordFetch(lookup(live({ settings: undefined })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find(
      (d) => d.field === 'Corp Windows Sensor Updates.settings.uninstall_protection',
    )
    assert.ok(diff)
    assert.equal(diff.actual, 'DISABLED')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: a protection change that does not weaken is only a warning', async () => {
  // Declared MAINTENANCE_MODE against a live DISABLED is a mismatch worth
  // reporting, but it is not the loss of a protection the canvas asked for.
  const maintenance = item('Windows sensor updates', {
    name: 'Corp Windows Sensor Updates',
    platform: 'Windows',
    description: 'n-1 pinned build for workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    build: '7.14.18110|n-1|Tagged|14',
    uninstall_protection: 'MAINTENANCE_MODE',
  })
  const { restore } = recordFetch(
    lookup(live({ settings: { build: '7.14.18110|n-1|Tagged|14', uninstall_protection: 'DISABLED' } })),
  )
  try {
    const result = await driftDetect(driftContext([maintenance]))

    const diff = result.diffs.find(
      (d) => d.field === 'Corp Windows Sensor Updates.settings.uninstall_protection',
    )
    assert.ok(diff)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: reports a host group detached in the console', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-workstations' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Sensor Updates.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-workstations, hg-laptops')
    assert.equal(diff.actual, 'hg-workstations')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-laptops' }, { id: 'hg-workstations' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `reordered groups are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: reports a description edited by hand as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited in the console' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Sensor Updates.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'edited in the console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ enabled: false, modified_by: 'alice@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Sensor Updates.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Sensor Updates.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('sensor-update-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows sensor updates', {
    name: 'Corp Windows Sensor Updates',
    platform: 'Windows',
    description: 'n-1 pinned build for workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    build: '7.16.19200|n|Tagged|14',
    uninstall_protection: 'ENABLED',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
