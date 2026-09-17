// driftDetect for cloud-image-assessment-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is the comparison — enablement and the rule action
// are the two fields that decide whether an image is admitted, so both are
// critical, while the declared conditions are matched as a SUBSET (a threshold
// added in the console is not this configuration's drift to report).

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

const POLICY = item('Registry gate', {
  name: 'Registry gate',
  description: 'Block critical CVEs at admission',
  action: 'prevent',
  enabled: true,
  rules: '[{"prop":"severity","value":"critical"}]',
})

registerDriftContract({
  label: 'cloud-image-assessment-policies',
  handler: driftDetect,
  items: [POLICY],
})

/** The live policy exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'Registry gate',
  description: 'Block critical CVEs at admission',
  is_enabled: true,
  policy_data: {
    rules: [
      { action: 'prevent', policy_rules_data: { conditions: [{ prop: 'severity', value: 'critical' }] } },
    ],
  },
  ...over,
})

/** The single listing read a policy comparison performs. */
const lookup = (entity: Record<string, unknown>) => [TOKEN, entityPage([entity])]

test('cloud-image-assessment-policies driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: reports a policy disabled in the console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ is_enabled: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Registry gate.enabled')
    assert.ok(diff, `expected an enablement diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical', 'a policy that should be on but is off assesses nothing')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: reports an action downgraded from prevent to alert as critical', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        policy_data: {
          rules: [
            { action: 'alert', policy_rules_data: { conditions: [{ prop: 'severity', value: 'critical' }] } },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Registry gate.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'prevent')
    assert.equal(diff.actual, 'alert')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: reports a policy whose rules were emptied in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ policy_data: { rules: [{ action: 'prevent', policy_rules_data: { conditions: [] } }] } })),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Registry gate.rules')
    assert.ok(diff, `expected a rules diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, '[]')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: ignores extra live conditions the canvas does not declare', async () => {
  // This config type models one action over a declared threshold set; a further
  // threshold added by hand is not something the canvas owns.
  const { restore } = recordFetch(
    lookup(
      live({
        policy_data: {
          rules: [
            {
              action: 'prevent',
              policy_rules_data: {
                conditions: [
                  { prop: 'severity', value: 'critical' },
                  { prop: 'secret', value: 'any' },
                ],
              },
            },
          ],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Registry gate.rules'),
      false,
      `an extra live condition must not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: reports a description edited in the console as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Registry gate.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'info', 'a description does not change what the policy admits')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: attributes a manual change to the operator who made it', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'Registry gate.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ is_enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Registry gate.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Registry gate', {
    name: 'Registry gate',
    description: 'Block critical CVEs at admission',
    action: 'alert',
    enabled: false,
    rules: '[{"prop":"severity","value":"critical"}]',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
