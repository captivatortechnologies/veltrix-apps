// driftDetect for idp-policy-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is which fields decide whether the policy actually protects
// anything — `enabled` and `action` are critical, `simulationMode` turns an
// enforcing rule into a logging one, and each condition key the canvas declares
// is compared structurally (key order is not drift).

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  CannedResponse,
  EMPTY,
  driftContext,
  entityPage,
  idsPage,
  item,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/identity-protection\/queries\/policy-rules\/v1/
const ENTITY = /\/identity-protection\/entities\/policy-rules\/v1/

const RULE = item('Block legacy auth', {
  name: 'Block legacy authentication',
  enabled: 'true',
  simulationMode: 'false',
  action: 'DENY',
  conditions: '{"activity":{"accessType":["LEGACY"]}}',
})

registerDriftContract({ label: 'idp-policy-rules', handler: driftDetect, items: [RULE] })

/** The live rule exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'rule-live-1',
  name: 'Block legacy authentication',
  enabled: true,
  simulationMode: false,
  action: 'DENY',
  activity: { accessType: ['LEGACY'] },
  ...over,
})

/** The id query, then the entity read it feeds. */
function tenant(rule: Record<string, unknown> | null, entity?: CannedResponse) {
  return routeFetch([
    { url: ENTITY, method: 'GET', respond: entity ?? (rule ? entityPage([rule]) : EMPTY) },
    { url: QUERY, respond: rule || entity ? idsPage(['rule-live-1']) : EMPTY },
  ])
}

test('idp-policy-rules driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = tenant(live())
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: reports a rule disabled in the console as critical', async () => {
  // A disabled Identity Protection rule enforces nothing at all.
  const { restore } = tenant(live({ enabled: false }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: reports an action changed in the console as critical', async () => {
  // DENY turned into ALLOW is the rule doing the opposite of what it was
  // deployed to do.
  const { restore } = tenant(live({ action: 'ALLOW' }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'DENY')
    assert.equal(diff.actual, 'ALLOW')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: reports simulation mode switched on', async () => {
  // Still enabled, still DENY — but now it only logs. The rule looks healthy on
  // a presence check and protects nothing.
  const { restore } = tenant(live({ simulationMode: true }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.simulationMode')
    assert.ok(diff, `expected a simulationMode diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, false)
    assert.equal(diff.actual, true)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: reports a declared condition edited in the console', async () => {
  const { restore } = tenant(live({ activity: { accessType: ['RDP'] } }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.conditions.activity')
    assert.ok(diff, `expected a conditions diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.expected), /LEGACY/)
    assert.match(String(diff.actual), /RDP/)
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: reports a declared condition removed in the console', async () => {
  const { restore } = tenant(live({ activity: undefined }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.conditions.activity')
    assert.ok(diff, `expected a conditions diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: ignores condition KEY ORDER, which JSON does not preserve', async () => {
  const ordered = item('Block legacy auth', {
    name: 'Block legacy authentication',
    enabled: 'true',
    simulationMode: 'false',
    action: 'DENY',
    conditions: '{"activity":{"accessType":["LEGACY"],"protocol":"NTLM"}}',
  })
  const { restore } = tenant(live({ activity: { protocol: 'NTLM', accessType: ['LEGACY'] } }))
  try {
    const result = await driftDetect(driftContext([ordered]))

    assert.equal(result.hasDrift, false, `reordered keys are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: leaves undeclared conditions unmanaged', async () => {
  // A rule the canvas scopes only by activity does not own the tenant's other
  // condition trees, so a destination set by hand is not this configuration's
  // drift to report.
  const { restore } = tenant(live({ destination: { domain: ['corp.example'] } }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(
      result.diffs.some((d) => String(d.field).includes('destination')),
      false,
      `an undeclared condition must not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: a rule that could not be READ is never reported as absent', async () => {
  // The id query resolved; the entity read 500ed. That is "I could not look",
  // and telling an operator their authentication policy was deleted sends them
  // to recreate a rule that is still there.
  const { restore } = tenant(null, serverError())
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(
      result.diffs.some((d) => d.actual === 'missing'),
      false,
      `a 500 became "missing": ${JSON.stringify(result.diffs)}`,
    )
    assert.equal(result.hasDrift, true, 'an unreadable rule must not come back as "in sync"')
    assert.match(String(result.diffs[0].actual), /unreachable/)
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: does not adopt a rule under a different name', async () => {
  // Comparing the declared rule against an unrelated one would report drift on a
  // rule nobody deployed — and hide that the declared one is gone.
  const { restore } = tenant({ id: 'rule-other-1', name: 'Some other rule', enabled: true, action: 'ALLOW' })
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication')
    assert.ok(diff, `expected the declared rule to read as absent, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'missing')
    assert.equal(diff.severity, 'critical')
    assert.equal(
      result.diffs.some((d) => String(d.field).startsWith('Some other rule')),
      false,
      'an undeclared rule must never appear in this configuration’s diffs',
    )
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: attributes a manual change when the rule carries a modifier', async () => {
  // Identity Protection rules are not documented to expose one, so this is
  // best-effort wiring — but when the field is there it must be read.
  const { restore } = tenant(
    live({ enabled: false, modified_by: 'bob@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' }),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'bob@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = tenant(live({ enabled: false, modified_by: CLIENT_ID }))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block legacy authentication.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('idp-policy-rules driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Block legacy auth', {
    name: 'Block legacy authentication',
    enabled: 'false',
    simulationMode: 'true',
    action: 'ALLOW',
    conditions: '{"activity":{"accessType":["RDP"]}}',
  })
  const { restore } = tenant(live())
  try {
    const result = await driftDetect(driftContext([RULE], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
