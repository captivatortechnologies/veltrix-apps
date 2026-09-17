// driftDetect for recon-monitoring-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the FQL filter — the field that decides what the rule watches
// for, reported as critical — the immutable topic (a mismatch means the rule was
// recreated under the same name), and the notification actions, which are only
// compared when the canvas declares them.

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

const ACTIONS_JSON =
  '[{"type":"email","frequency":"asap","recipients":["soc@acme.com"],"contentFormat":"enhanced"}]'

const RULE = item('Leaked corporate credentials', {
  name: 'acme-leaked-credentials',
  topic: 'SA_EMAIL',
  filter: "email_domain:'acme.com'",
  priority: 'high',
  permissions: 'public',
  breachMonitoring: true,
  substringMatching: false,
})

const RULE_WITH_ACTIONS = item('Leaked corporate credentials', {
  ...(RULE.fields as Record<string, unknown>),
  actions: ACTIONS_JSON,
})

registerDriftContract({ label: 'recon-monitoring-rules', handler: driftDetect, items: [RULE] })

/** The live rule exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'recon-live-1',
  name: 'acme-leaked-credentials',
  topic: 'SA_EMAIL',
  filter: "email_domain:'acme.com'",
  priority: 'high',
  permissions: 'public',
  breach_monitoring_enabled: true,
  substring_matching_enabled: false,
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('recon-monitoring-rules driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: reports an FQL filter edited in the console', async () => {
  // The filter decides what the rule watches for. Narrowed by hand, the rule
  // stops matching the exposures it was deployed to catch.
  const { restore } = recordFetch(lookup(live({ filter: "email_domain:'not-acme.example'" })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'acme-leaked-credentials.filter')
    assert.ok(diff, `expected a filter diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, "email_domain:'acme.com'")
    assert.equal(diff.actual, "email_domain:'not-acme.example'")
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: reports a topic mismatch, which means the rule was recreated', async () => {
  // topic is immutable, so a different one under the same name is a different
  // rule — not something an update could have caused.
  const { restore } = recordFetch(lookup(live({ topic: 'SA_DOMAIN' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'acme-leaked-credentials.topic')
    assert.ok(diff, `expected a topic diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'SA_EMAIL')
    assert.equal(diff.actual, 'SA_DOMAIN')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: reports priority, permissions and the matching flags', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        priority: 'low',
        permissions: 'private',
        breach_monitoring_enabled: false,
        substring_matching_enabled: true,
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const fields = result.diffs.map((d) => d.field)
    assert.ok(fields.includes('acme-leaked-credentials.priority'), `got ${fields.join(', ')}`)
    assert.ok(fields.includes('acme-leaked-credentials.permissions'), `got ${fields.join(', ')}`)
    assert.ok(fields.includes('acme-leaked-credentials.breachMonitoring'), `got ${fields.join(', ')}`)
    assert.ok(fields.includes('acme-leaked-credentials.substringMatching'), `got ${fields.join(', ')}`)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: reports a declared notification action removed in the console', async () => {
  const { restore } = recordFetch([...lookup(live()), { status: 200, body: { resources: [] } }])
  try {
    const result = await driftDetect(driftContext([RULE_WITH_ACTIONS]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'acme-leaked-credentials.actions.soc@acme.com')
    assert.ok(diff, `expected a missing-action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not present on rule')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: reports an action added on the rule that the canvas does not declare', async () => {
  const stray = {
    id: 'action-stray-1',
    rule_id: 'recon-live-1',
    type: 'email',
    frequency: 'weekly',
    recipients: ['legacy-dl@acme.com'],
    content_format: 'standard',
  }
  const declared = {
    id: 'action-live-1',
    rule_id: 'recon-live-1',
    type: 'email',
    frequency: 'asap',
    recipients: ['soc@acme.com'],
    content_format: 'enhanced',
  }
  const { restore } = recordFetch([
    ...lookup(live()),
    idsPage(['action-live-1', 'action-stray-1']),
    entityPage([declared, stray]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE_WITH_ACTIONS]))

    const diff = result.diffs.find(
      (d) => d.field === 'acme-leaked-credentials.actions.legacy-dl@acme.com',
    )
    assert.ok(diff, `expected an undeclared-action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'present on rule')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: leaves actions unmanaged when the canvas declares none', async () => {
  // A blank actions field means "not managed here" — a notification the customer
  // added themselves is not this configuration's drift to report.
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(
      result.diffs.some((d) => d.field.includes('.actions')),
      false,
      'an undeclared actions field must not drift',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('/recon/queries/actions/') || c.url.includes('/recon/entities/actions/')).length,
      0,
      'an undeclared actions field must not even be read',
    )
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: attributes a manual change to the operator who made it', async () => {
  // Recon records its last writer as `user_name` rather than the policy APIs'
  // `modified_by`, so the handler bridges the field names.
  const { restore } = recordFetch(
    lookup(
      live({
        priority: 'low',
        user_name: 'alice@acme.com',
        updated_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'acme-leaked-credentials.priority')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ priority: 'low', user_name: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'acme-leaked-credentials.priority')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Leaked corporate credentials', {
    ...(RULE.fields as Record<string, unknown>),
    filter: "email_domain:'something-else.example'",
    priority: 'low',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
