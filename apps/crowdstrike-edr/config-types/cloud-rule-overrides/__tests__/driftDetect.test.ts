// driftDetect for cloud-rule-overrides.
//
// The shared contract covers the invariants: drift never writes, a removed
// override is critical drift, and a 500 is never reported as the override being
// gone. What is specific here is the comparison — the override type decides
// whether the built-in rule is suppressed at all, and the expiry decides for how
// long, so an expiry quietly pushed out keeps a Cloud Security rule off for
// years without anybody re-approving it.

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

const OVERRIDE = item('Public bucket exception', {
  ruleId: 'rule-1234',
  overrideType: 'exception',
  overrideDetails: 'Bucket is a public website origin',
  reason: 'Approved by the cloud security review board',
  crn: 'crn:aws:111122223333',
  targetRegion: 'us-east-1',
  expiresAt: '2027-12-31T00:00:00Z',
})

registerDriftContract({ label: 'cloud-rule-overrides', handler: driftDetect, items: [OVERRIDE] })

/** The live override exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'ov-live-1',
  rule_id: 'rule-1234',
  crn: 'crn:aws:111122223333',
  override_type: 'exception',
  overrides_details: 'Bucket is a public website origin',
  reason: 'Approved by the cloud security review board',
  target_region: 'us-east-1',
  expires_at: '2027-12-31T00:00:00Z',
  ...over,
})

/** This collection has no queries endpoint — the read is a single call. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, entityPage([entity])]
}

test('cloud-rule-overrides driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reports a changed override type as critical', async () => {
  const { restore } = recordFetch(lookup(live({ override_type: 'suppression' })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'rule-1234.overrideType')
    assert.ok(diff, `expected an overrideType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'exception')
    assert.equal(diff.actual, 'suppression')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reports override details edited in the console', async () => {
  const { restore } = recordFetch(lookup(live({ overrides_details: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    const diff = result.diffs.find((d) => d.field === 'rule-1234.overrideDetails')
    assert.ok(diff, `expected an overrideDetails diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'edited by hand')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reports a target region cleared in the console', async () => {
  // An override with no target region applies in every region, not just the one
  // it was scoped to.
  const { restore } = recordFetch(lookup(live({ target_region: undefined })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    const diff = result.diffs.find((d) => d.field === 'rule-1234.targetRegion')
    assert.ok(diff, `expected a targetRegion diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'us-east-1')
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reports an expiry pushed out in the console', async () => {
  const { restore } = recordFetch(lookup(live({ expires_at: '2030-01-01T00:00:00Z' })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    const diff = result.diffs.find((d) => d.field === 'rule-1234.expiresAt')
    assert.ok(diff, `expected an expiresAt diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2027-12-31T00:00:00Z')
    assert.equal(diff.actual, '2030-01-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reports an expiry removed entirely', async () => {
  // A never-expiring exception is the most consequential edit this config type
  // can suffer, and it reads as an absent field rather than a changed one.
  const { restore } = recordFetch(lookup(live({ expires_at: undefined })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    const diff = result.diffs.find((d) => d.field === 'rule-1234.expiresAt')
    assert.ok(diff, `expected an expiresAt diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: accepts the same expiry in a different format', async () => {
  // Falcon echoes timestamps with millisecond precision; comparing strings would
  // report drift on every run for an override nobody touched.
  const { restore } = recordFetch(lookup(live({ expires_at: '2027-12-31T00:00:00.000Z' })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    assert.equal(
      result.diffs.some((d) => d.field === 'rule-1234.expiresAt'),
      false,
      'the same instant in another format is not drift',
    )
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reports an override moved to another cloud account as missing', async () => {
  // The read returns an override for the rule, but on a different account. The
  // declared scope no longer has one, so the built-in rule is enforced there.
  const { restore } = recordFetch(lookup(live({ crn: 'crn:aws:999988887777' })))
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    assert.equal(result.hasDrift, true)
    assert.ok(
      result.diffs.some((d) => d.actual === 'missing' && d.severity === 'critical'),
      `expected a critical missing diff, got ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        override_type: 'suppression',
        modified_by: 'alice@acme.com',
        modified_at: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    const diff = result.diffs.find((d) => d.field === 'rule-1234.overrideType')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: does not attribute drift to our own API client', async () => {
  const { restore } = recordFetch(
    lookup(live({ override_type: 'suppression', modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([OVERRIDE]))

    const diff = result.diffs.find((d) => d.field === 'rule-1234.overrideType')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // An edit the operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Public bucket exception', {
    ruleId: 'rule-1234',
    overrideType: 'exception',
    overrideDetails: 'Rewritten but not yet deployed',
    reason: 'Approved by the cloud security review board',
    crn: 'crn:aws:111122223333',
    targetRegion: 'us-east-1',
    expiresAt: '2027-12-31T00:00:00Z',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([OVERRIDE], { canvasItems: [edited] }))

    assert.equal(
      result.hasDrift,
      false,
      `compared against the canvas: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})
