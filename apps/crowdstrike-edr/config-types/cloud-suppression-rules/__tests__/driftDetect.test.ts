// driftDetect for cloud-suppression-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison of the two structured filters. A suppression
// widened by hand is invisible by definition — the findings it hides simply stop
// appearing — so every selection and scope list is compared, order-insensitively,
// and an expiry is compared by instant rather than by string.

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

const RULE = item('Sandbox noise', {
  name: 'suppress-sandbox-noise',
  ruleSelectionType: 'specific',
  ruleSeverities: 'medium, low',
  ruleProviders: 'AWS',
  ruleServices: 'S3, EC2',
  ruleIds: 'rule-1, rule-2',
  scopeType: 'account',
  accountIds: '111122223333, 444455556666',
  cloudProviders: 'AWS',
  regions: 'us-east-1',
  resourceTypes: 'AWS::S3::Bucket',
  suppressionReason: 'Accepted risk for sandbox accounts',
  expiration: '2027-12-31T00:00:00Z',
  enabled: true,
})

registerDriftContract({ label: 'cloud-suppression-rules', handler: driftDetect, items: [RULE] })

/** The live rule exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'sup-live-1',
  name: 'suppress-sandbox-noise',
  rule_selection_type: 'specific',
  rule_selection_filter: {
    rule_severities: ['Medium', 'Low'],
    rule_providers: ['aws'],
    rule_services: ['S3', 'EC2'],
    rule_ids: ['rule-1', 'rule-2'],
  },
  scope_type: 'account',
  scope_asset_filter: {
    account_ids: ['111122223333', '444455556666'],
    cloud_providers: ['aws'],
    regions: ['us-east-1'],
    resource_types: ['AWS::S3::Bucket'],
  },
  suppression_reason: 'Accepted risk for sandbox accounts',
  suppression_expiration_date: '2027-12-31T00:00:00Z',
  disabled: false,
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('cloud-suppression-rules driftDetect: reports no drift when the tenant matches', async () => {
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

test('cloud-suppression-rules driftDetect: reports a selection widened from specific to all', async () => {
  const { restore } = recordFetch(lookup(live({ rule_selection_type: 'all' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.ruleSelectionType')
    assert.ok(diff, `expected a ruleSelectionType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'specific')
    assert.equal(diff.actual, 'all')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: reports a severity added to the suppression', async () => {
  // Critical findings now stop being alerted on. Nothing else in the platform
  // would surface that — the alerts simply never arrive.
  const { restore } = recordFetch(
    lookup(
      live({
        rule_selection_filter: {
          rule_severities: ['Medium', 'Low', 'Critical'],
          rule_providers: ['aws'],
          rule_services: ['S3', 'EC2'],
          rule_ids: ['rule-1', 'rule-2'],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.ruleSeverities')
    assert.ok(diff, `expected a ruleSeverities diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Medium, Low')
    assert.equal(diff.actual, 'Medium, Low, Critical')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: reports a production account added to the scope', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        scope_asset_filter: {
          account_ids: ['111122223333', '444455556666', '000011112222'],
          cloud_providers: ['aws'],
          regions: ['us-east-1'],
          resource_types: ['AWS::S3::Bucket'],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.accountIds')
    assert.ok(diff, `expected an accountIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /000011112222/)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: reports a scope filter emptied in the console', async () => {
  // An absent `scope_asset_filter` is a tenant-wide suppression, not a match.
  const { restore } = recordFetch(lookup(live({ scope_asset_filter: undefined })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.accountIds')
    assert.ok(diff, `expected an accountIds diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'none')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: ignores list ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        rule_selection_filter: {
          rule_severities: ['Low', 'Medium'],
          rule_providers: ['aws'],
          rule_services: ['EC2', 'S3'],
          rule_ids: ['rule-2', 'rule-1'],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(
      result.hasDrift,
      false,
      `reordered filter lists are not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: reports an expiry pushed out in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ suppression_expiration_date: '2030-01-01T00:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.expiration')
    assert.ok(diff, `expected an expiration diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2027-12-31T00:00:00Z')
    assert.equal(diff.actual, '2030-01-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: accepts the same expiry in a different format', async () => {
  // Falcon echoes timestamps with millisecond precision; comparing strings would
  // report drift on every run for a rule nobody touched.
  const { restore } = recordFetch(
    lookup(live({ suppression_expiration_date: '2027-12-31T00:00:00.000Z' })),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(
      result.diffs.some((d) => d.field === 'suppress-sandbox-noise.expiration'),
      false,
      'the same instant in another format is not drift',
    )
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: reports a rule disabled in the console', async () => {
  const { restore } = recordFetch(lookup(live({ disabled: true })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: leaves enablement unreported when the API omits it', async () => {
  // `disabled` is a best-effort write field; a live rule that does not report it
  // must not produce a diff against a value that was never readable.
  const { restore } = recordFetch(lookup(live({ disabled: undefined })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(
      result.diffs.some((d) => d.field === 'suppress-sandbox-noise.enabled'),
      false,
      'an unreported field is not drift',
    )
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        rule_selection_type: 'all',
        modified_by: 'alice@acme.com',
        last_modified_at: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.ruleSelectionType')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: does not attribute drift to our own API client', async () => {
  const { restore } = recordFetch(
    lookup(live({ rule_selection_type: 'all', modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'suppress-sandbox-noise.ruleSelectionType')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // An edit the operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Sandbox noise', {
    name: 'suppress-sandbox-noise',
    ruleSelectionType: 'all',
    ruleSeverities: 'medium, low',
    ruleProviders: 'AWS',
    ruleServices: 'S3, EC2',
    ruleIds: 'rule-1, rule-2',
    scopeType: 'account',
    accountIds: '111122223333, 444455556666',
    cloudProviders: 'AWS',
    regions: 'us-east-1',
    resourceTypes: 'AWS::S3::Bucket',
    suppressionReason: 'Accepted risk for sandbox accounts',
    expiration: '2027-12-31T00:00:00Z',
    enabled: true,
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
