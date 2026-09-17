// driftDetect for cloud-iom-custom-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison — the cloud provider and resource type decide
// WHAT the rule evaluates and are critical; the Rego logic is only compared for
// a fully-custom rule, and controls only when the canvas declared them, so an
// inherited rule is not reported as drifting against its parent.

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

const RULE = item('Public S3 buckets', {
  name: 'block-public-s3',
  description: 'Flags S3 buckets that allow public read access',
  cloudProvider: 'aws',
  resourceType: 'AWS::S3::Bucket',
  severity: 'high',
  logic: 'package veltrix\ndeny { input.public_read }',
  controls: '[{"authority":"CIS","code":"2.1.5"}]',
})

registerDriftContract({ label: 'cloud-iom-custom-rules', handler: driftDetect, items: [RULE] })

/** The live rule exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'rule-live-1',
  name: 'block-public-s3',
  description: 'Flags S3 buckets that allow public read access',
  cloud_provider: 'aws',
  resource_type: 'AWS::S3::Bucket',
  severity: 'high',
  logic: 'package veltrix\ndeny { input.public_read }',
  controls: [{ authority: 'CIS', code: '2.1.5' }],
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('cloud-iom-custom-rules driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: reports a re-pointed cloud provider as critical', async () => {
  const { restore } = recordFetch(lookup(live({ cloud_provider: 'azure' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'block-public-s3.cloudProvider')
    assert.ok(diff, `expected a cloudProvider diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'aws')
    assert.equal(diff.actual, 'azure')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: reports a re-pointed resource type as critical', async () => {
  // The rule still exists and still runs — against a resource type nobody asked
  // it to cover, so the resources it was written for go unevaluated.
  const { restore } = recordFetch(lookup(live({ resource_type: 'AWS::EC2::Instance' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'block-public-s3.resourceType')
    assert.ok(diff, `expected a resourceType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: reports a severity downgraded in the console', async () => {
  const { restore } = recordFetch(lookup(live({ severity: 'Informational' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'block-public-s3.severity')
    assert.ok(diff, `expected a severity diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'high')
    assert.equal(diff.actual, 'informational', 'live severity casing is normalised before comparison')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: reports edited Rego logic as critical without echoing it', async () => {
  // The diff says the policy changed; it does not paste a tenant's Rego source
  // into a drift record.
  const { restore } = recordFetch(lookup(live({ logic: 'package veltrix\ndeny { false }' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'block-public-s3.logic')
    assert.ok(diff, `expected a logic diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'declared Rego policy')
    assert.equal(diff.actual, 'modified Rego policy')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: leaves logic unmanaged for a rule that inherits it', async () => {
  // An inherited rule's live logic comes from its parent and was never authored
  // here, so it is not this configuration's drift to report.
  const inherited = item('Inherited rule', {
    name: 'inherited-rule',
    description: 'Inherits its logic from a built-in rule',
    cloudProvider: 'gcp',
    resourceType: 'compute.googleapis.com/Instance',
    severity: 'medium',
    parentRuleId: 'parent-1',
  })
  const { restore } = recordFetch(
    lookup({
      id: 'rule-live-9',
      name: 'inherited-rule',
      description: 'Inherits its logic from a built-in rule',
      cloud_provider: 'gcp',
      resource_type: 'compute.googleapis.com/Instance',
      severity: 'medium',
      logic: 'package parent\ndeny { input.anything }',
      parent_rule_id: 'parent-1',
    }),
  )
  try {
    const result = await driftDetect(driftContext([inherited]))

    assert.equal(
      result.diffs.some((d) => d.field === 'inherited-rule.logic'),
      false,
      'an undeclared logic body must not drift',
    )
    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: reports a compliance control removed in the console', async () => {
  const { restore } = recordFetch(lookup(live({ controls: [] })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'block-public-s3.controls')
    assert.ok(diff, `expected a controls diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'CIS:2.1.5')
    assert.equal(diff.actual, 'none')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: ignores control ORDER, which Falcon does not preserve', async () => {
  const twoControls = item('Public S3 buckets', {
    name: 'block-public-s3',
    description: 'Flags S3 buckets that allow public read access',
    cloudProvider: 'aws',
    resourceType: 'AWS::S3::Bucket',
    severity: 'high',
    logic: 'package veltrix\ndeny { input.public_read }',
    controls: '[{"authority":"CIS","code":"2.1.5"},{"authority":"NIST","code":"AC-2"}]',
  })
  const { restore } = recordFetch(
    lookup(
      live({
        controls: [
          { authority: 'NIST', code: 'AC-2' },
          { authority: 'CIS', code: '2.1.5' },
        ],
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([twoControls]))

    assert.equal(
      result.hasDrift,
      false,
      `reordered controls are not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        severity: 'informational',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'block-public-s3.severity')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ severity: 'informational', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'block-public-s3.severity')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Public S3 buckets', {
    name: 'block-public-s3',
    description: 'Flags S3 buckets that allow public read access',
    cloudProvider: 'aws',
    resourceType: 'AWS::S3::Bucket',
    severity: 'critical',
    logic: 'package veltrix\ndeny { input.public_read }',
    controls: '[{"authority":"CIS","code":"2.1.5"}]',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE], { canvasItems: [edited] }))

    assert.equal(
      result.hasDrift,
      false,
      `compared against the canvas: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})
