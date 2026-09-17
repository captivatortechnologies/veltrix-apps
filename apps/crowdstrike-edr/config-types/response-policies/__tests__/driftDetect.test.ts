// driftDetect for response-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the comparison itself — enablement, each
// DECLARED capability toggle (a toggle the canvas never mentioned is the
// tenant's business), host-group assignment and description — plus the
// attribution that rides on the live policy's `modified_by`.

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

const POLICY = item('Windows responders', {
  name: 'Corp Windows RTR',
  platform: 'Windows',
  description: 'Tier 2 responder capabilities',
  enabled: true,
  hostGroups: 'hg-workstations, hg-laptops',
  settings: JSON.stringify([
    { id: 'RealTimeFunctionality', value: { enabled: true } },
    { id: 'CustomScripts', value: { enabled: false } },
  ]),
})

registerDriftContract({ label: 'response-policies', handler: driftDetect, items: [POLICY] })

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'Corp Windows RTR',
  platform_name: 'Windows',
  description: 'Tier 2 responder capabilities',
  enabled: true,
  groups: [{ id: 'hg-workstations' }, { id: 'hg-laptops' }],
  settings: [
    { id: 'RealTimeFunctionality', value: { enabled: true } },
    { id: 'CustomScripts', value: { enabled: false } },
  ],
  ...over,
})

/** The single combined-query call a policy-family lookup performs. */
const lookup = (policy: Record<string, unknown>) => [TOKEN, entityPage([policy])]

test('response-policies driftDetect: reports no drift when the tenant matches', async () => {
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

test('response-policies driftDetect: reads settings nested under a settings object too', async () => {
  // Some Falcon policy families wrap the toggle array in `{ settings: [...] }`.
  // Reading only the flat shape would report every declared toggle as absent.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: {
          settings: [
            { id: 'RealTimeFunctionality', value: { enabled: true } },
            { id: 'CustomScripts', value: { enabled: false } },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reports a policy switched off in the Falcon console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reports a declared capability revoked by hand as critical', async () => {
  // The canvas grants RealTimeFunctionality and the tenant has it off — the
  // responders this policy exists for cannot connect.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: [
          { id: 'RealTimeFunctionality', value: { enabled: false } },
          { id: 'CustomScripts', value: { enabled: false } },
        ],
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.settings.RealTimeFunctionality')
    assert.ok(diff, `expected a settings diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reports a capability granted by hand as a warning, not critical', async () => {
  // The canvas withholds CustomScripts and the tenant has switched it on. That
  // is drift worth reporting, but nothing the canvas asked for has been lost.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: [
          { id: 'RealTimeFunctionality', value: { enabled: true } },
          { id: 'CustomScripts', value: { enabled: true } },
        ],
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.settings.CustomScripts')
    assert.ok(diff)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reports a declared toggle the policy no longer carries', async () => {
  const { restore } = recordFetch(
    lookup(live({ settings: [{ id: 'RealTimeFunctionality', value: { enabled: true } }] })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.settings.CustomScripts')
    assert.ok(diff)
    assert.equal(diff.actual, 'not present on policy')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: leaves toggles the canvas never declared unmanaged', async () => {
  // This configuration owns the toggles it lists, not the whole policy.
  const { restore } = recordFetch(
    lookup(
      live({
        settings: [
          { id: 'RealTimeFunctionality', value: { enabled: true } },
          { id: 'CustomScripts', value: { enabled: false } },
          { id: 'PutFiles', value: { enabled: true } },
        ],
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `undeclared toggles drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reports a host group detached in the console', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-workstations' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-workstations, hg-laptops')
    assert.equal(diff.actual, 'hg-workstations')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-laptops' }, { id: 'hg-workstations' }] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `reordered groups are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reports a description edited by hand as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited in the console' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'edited in the console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ enabled: false, modified_by: 'alice@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows RTR.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('response-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows responders', {
    name: 'Corp Windows RTR',
    platform: 'Windows',
    description: 'Tier 2 responder capabilities',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    settings: JSON.stringify([
      { id: 'RealTimeFunctionality', value: { enabled: true } },
      { id: 'CustomScripts', value: { enabled: true } },
    ]),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
