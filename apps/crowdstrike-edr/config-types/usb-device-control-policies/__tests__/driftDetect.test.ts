// driftDetect for usb-device-control-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the settings comparison — this family writes a
// whole settings OBJECT, so the check is a recursive "every value the canvas
// declares is present and equal", with `id`-carrying arrays (device classes and
// their exceptions) matched by id rather than by position, because Falcon does
// not preserve their order.

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

const POLICY = item('Windows USB control', {
  name: 'Corp Windows USB Control',
  platform: 'Windows',
  description: 'Mass storage read-only on workstations',
  enabled: true,
  hostGroups: 'hg-workstations, hg-laptops',
  settings: JSON.stringify({
    classes: [
      { id: 'MASS_STORAGE', action: 'READ_ONLY' },
      { id: 'IMAGING', action: 'FULL_BLOCK' },
    ],
  }),
})

registerDriftContract({ label: 'usb-device-control-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'Corp Windows USB Control',
  platform_name: 'Windows',
  description: 'Mass storage read-only on workstations',
  enabled: true,
  groups: [{ id: 'hg-workstations' }, { id: 'hg-laptops' }],
  settings: {
    classes: [
      { id: 'MASS_STORAGE', action: 'READ_ONLY' },
      { id: 'IMAGING', action: 'FULL_BLOCK' },
    ],
  },
  ...over,
})

/** The single combined-query call a policy-family lookup performs. */
const lookup = (policy: Record<string, unknown>) => [TOKEN, entityPage([policy])]

test('usb-device-control-policies driftDetect: reports no drift when the tenant matches', async () => {
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

test('usb-device-control-policies driftDetect: reports a policy switched off in the Falcon console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: reports a device class loosened in the console', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          classes: [
            { id: 'MASS_STORAGE', action: 'FULL_ACCESS' },
            { id: 'IMAGING', action: 'FULL_BLOCK' },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.settings')
    assert.ok(diff, `expected a settings diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /FULL_ACCESS/)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: ignores device-class ORDER and classes the canvas never listed', async () => {
  // This configuration owns the classes it lists, not the whole policy, and
  // Falcon does not preserve the order it returns them in.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          classes: [
            { id: 'PRINTER', action: 'FULL_ACCESS' },
            { id: 'IMAGING', action: 'FULL_BLOCK' },
            { id: 'MASS_STORAGE', action: 'READ_ONLY' },
          ],
          end_user_notification: 'SILENT',
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `undeclared classes drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: matches class exceptions by id, not by position', async () => {
  const withExceptions = item('Windows USB control', {
    name: 'Corp Windows USB Control',
    platform: 'Windows',
    description: 'Mass storage read-only on workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    settings: JSON.stringify({
      classes: [
        {
          id: 'MASS_STORAGE',
          action: 'READ_ONLY',
          exceptions: [
            { id: 'exc-approved-yubikey', action: 'FULL_ACCESS' },
            { id: 'exc-blocked-vendor', action: 'FULL_BLOCK' },
          ],
        },
      ],
    }),
  })
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          classes: [
            {
              id: 'MASS_STORAGE',
              action: 'READ_ONLY',
              exceptions: [
                { id: 'exc-blocked-vendor', action: 'FULL_BLOCK' },
                { id: 'exc-approved-yubikey', action: 'FULL_ACCESS' },
              ],
            },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([withExceptions]))

    assert.equal(result.hasDrift, false, `reordered exceptions are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: reports an exception whose action was changed by hand', async () => {
  const withExceptions = item('Windows USB control', {
    name: 'Corp Windows USB Control',
    platform: 'Windows',
    description: 'Mass storage read-only on workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    settings: JSON.stringify({
      classes: [
        {
          id: 'MASS_STORAGE',
          action: 'READ_ONLY',
          exceptions: [{ id: 'exc-blocked-vendor', action: 'FULL_BLOCK' }],
        },
      ],
    }),
  })
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          classes: [
            {
              id: 'MASS_STORAGE',
              action: 'READ_ONLY',
              exceptions: [{ id: 'exc-blocked-vendor', action: 'FULL_ACCESS' }],
            },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([withExceptions]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.settings')
    assert.ok(diff, `expected a settings diff, got ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: a policy that carries no settings at all is drift, not a match', async () => {
  const { restore } = recordFetch(lookup(live({ settings: undefined })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.settings')
    assert.ok(diff, `expected a settings diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'null')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: leaves settings unmanaged when the canvas declared none', async () => {
  const noSettings = item('Windows USB control', {
    name: 'Corp Windows USB Control',
    platform: 'Windows',
    description: 'Mass storage read-only on workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
  })
  const { restore } = recordFetch(
    lookup(live({ settings: { classes: [{ id: 'MASS_STORAGE', action: 'FULL_ACCESS' }] } })),
  )
  try {
    const result = await driftDetect(driftContext([noSettings]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Corp Windows USB Control.settings'),
      false,
      'undeclared settings must not drift',
    )
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: reports a host group detached in the console', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-workstations' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-workstations, hg-laptops')
    assert.equal(diff.actual, 'hg-workstations')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-laptops' }, { id: 'hg-workstations' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `reordered groups are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: reports a description edited by hand as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited in the console' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'edited in the console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ enabled: false, modified_by: 'alice@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows USB Control.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('usb-device-control-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows USB control', {
    name: 'Corp Windows USB Control',
    platform: 'Windows',
    description: 'Mass storage read-only on workstations',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    settings: JSON.stringify({ classes: [{ id: 'MASS_STORAGE', action: 'FULL_BLOCK' }] }),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
