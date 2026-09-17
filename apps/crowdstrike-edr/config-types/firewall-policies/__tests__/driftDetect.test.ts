// driftDetect for firewall-policies.
//
// The shared contract covers the invariants: drift never writes, a deleted
// policy is critical drift, and a 500 is never reported as the policy being
// gone. What is specific here is that a firewall policy is SPLIT across two
// collections, so the check reads both: the /policy shell (enablement, host
// groups, description) and the fwmgr container (rule-group assignment — compared
// as an ORDERED list, because order is precedence — default in/out actions,
// enforce, test mode, local logging).

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  EMPTY,
  TOKEN,
  driftContext,
  entityPage,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const POLICY = item('Windows firewall', {
  name: 'Corp Windows Firewall',
  platform: 'Windows',
  description: 'Deny inbound, allow outbound',
  enabled: true,
  hostGroups: 'hg-workstations, hg-laptops',
  ruleGroups: 'rg-core, rg-rdp',
  defaultInbound: 'DENY',
  defaultOutbound: 'ALLOW',
  enforce: true,
  localLogging: true,
  testMode: false,
})

registerDriftContract({ label: 'firewall-policies', handler: driftDetect, items: [POLICY] })

/** The live policy shell exactly matching the canvas, overridable field by field. */
const shell = (over: Record<string, unknown> = {}) => ({
  id: 'pol-live-1',
  name: 'Corp Windows Firewall',
  platform_name: 'Windows',
  description: 'Deny inbound, allow outbound',
  enabled: true,
  groups: [{ id: 'hg-workstations' }, { id: 'hg-laptops' }],
  ...over,
})

/** Its fwmgr container exactly matching the canvas, overridable field by field. */
const container = (over: Record<string, unknown> = {}) => ({
  policy_id: 'pol-live-1',
  platform_id: '0',
  rule_group_ids: ['rg-core', 'rg-rdp'],
  default_inbound: 'DENY',
  default_outbound: 'ALLOW',
  enforce: true,
  test_mode: false,
  local_logging: true,
  tracking: 'track-1',
  ...over,
})

/** The two reads a firewall drift check performs: the shell, then the container. */
const lookup = (live: Record<string, unknown>, fwmgr: Record<string, unknown> | null) => [
  TOKEN,
  entityPage([live]),
  fwmgr === null ? EMPTY : entityPage([fwmgr]),
]

test('firewall-policies driftDetect: reports no drift when both halves match', async () => {
  const { calls, restore } = recordFetch(lookup(shell(), container()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a policy switched off in the Falcon console as critical', async () => {
  const { restore } = recordFetch(lookup(shell({ enabled: false }), container()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a rule group removed from the container', async () => {
  const { restore } = recordFetch(lookup(shell(), container({ rule_group_ids: ['rg-core'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.ruleGroups')
    assert.ok(diff, `expected a ruleGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'rg-core, rg-rdp')
    assert.equal(diff.actual, 'rg-core')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: treats a REORDERED rule-group list as drift', async () => {
  // Unlike host groups, rule-group order is precedence: the same two groups in
  // the other order is a different firewall, so this one is deliberately not
  // order-insensitive.
  const { restore } = recordFetch(lookup(shell(), container({ rule_group_ids: ['rg-rdp', 'rg-core'] })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.ruleGroups')
    assert.ok(diff, `reordered rule groups are drift: ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'rg-rdp, rg-core')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a default inbound action opened up in the console', async () => {
  const { restore } = recordFetch(lookup(shell(), container({ default_inbound: 'ALLOW' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.defaultInbound')
    assert.ok(diff, `expected a defaultInbound diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'DENY')
    assert.equal(diff.actual, 'ALLOW')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a default outbound action changed in the console', async () => {
  const { restore } = recordFetch(lookup(shell(), container({ default_outbound: 'DENY' })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.defaultOutbound')
    assert.ok(diff)
    assert.equal(diff.actual, 'DENY')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports enforcement turned off in the console', async () => {
  // Enforcement off means the rules are present but not applied — the policy
  // reads as deployed while the host is unprotected by it.
  const { restore } = recordFetch(lookup(shell(), container({ enforce: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.enforce')
    assert.ok(diff, `expected an enforce diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports test mode and local logging flipped in the console', async () => {
  const { restore } = recordFetch(lookup(shell(), container({ test_mode: true, local_logging: false })))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const testMode = result.diffs.find((d) => d.field === 'Corp Windows Firewall.testMode')
    assert.ok(testMode)
    assert.equal(testMode.actual, true)
    assert.equal(testMode.severity, 'info')

    const logging = result.diffs.find((d) => d.field === 'Corp Windows Firewall.localLogging')
    assert.ok(logging)
    assert.equal(logging.actual, false)
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a policy whose container is gone field by field, not as a match', async () => {
  // No container means none of the declared firewall settings are in effect.
  const { restore } = recordFetch(lookup(shell(), null))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.find((d) => d.field === 'Corp Windows Firewall.defaultInbound')?.actual, 'unknown')
    assert.equal(result.diffs.find((d) => d.field === 'Corp Windows Firewall.ruleGroups')?.actual, 'none')
    assert.equal(
      result.diffs.some((d) => d.actual === 'missing'),
      false,
      'the policy itself still exists — only its container did not come back',
    )
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: a failed container read is never reported as settings being gone', async () => {
  // The shell read succeeds and the fwmgr read 500s. That is "I could not look"
  // at the container, and it must not become a list of wide-open defaults.
  const { calls, restore } = routeFetch(
    [
      { url: /oauth2\/token/, respond: TOKEN },
      { url: /\/policy\/combined\/firewall\/v1/, respond: entityPage([shell()]) },
      { url: /\/fwmgr\/entities\/policies\/v1/, respond: serverError('internal server error') },
    ],
    EMPTY,
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Corp Windows Firewall.defaultInbound'),
      false,
      'an unreadable container must not be reported as a changed default action',
    )
    assert.ok(
      result.diffs.some((d) => String(d.actual).startsWith('unreachable')),
      `expected the read failure to be surfaced, got ${JSON.stringify(result.diffs)}`,
    )
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a host group detached in the console', async () => {
  const { restore } = recordFetch(lookup(shell({ groups: [{ id: 'hg-workstations' }] }), container()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-workstations, hg-laptops')
    assert.equal(diff.actual, 'hg-workstations')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(
    lookup(shell({ groups: [{ id: 'hg-laptops' }, { id: 'hg-workstations' }] }), container()),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    assert.equal(result.hasDrift, false, `reordered groups are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reports a description edited by hand as informational', async () => {
  const { restore } = recordFetch(lookup(shell({ description: 'edited in the console' }), container()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'edited in the console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      shell({ enabled: false, modified_by: 'alice@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' }),
      container(),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: attributes container drift to the shell modifier too', async () => {
  // Rule-group drift is produced before attribution runs, so a change made only
  // on the fwmgr side still carries the policy's recorded last modifier.
  const { restore } = recordFetch(
    lookup(
      shell({ modified_by: 'alice@acme.com', modified_timestamp: '2026-01-04T10:00:00Z' }),
      container({ rule_group_ids: [] }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.ruleGroups')
    assert.ok(diff, `expected a ruleGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actor?.email, 'alice@acme.com')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(shell({ enabled: false, modified_by: CLIENT_ID }), container()))
  try {
    const result = await driftDetect(driftContext([POLICY]))

    const diff = result.diffs.find((d) => d.field === 'Corp Windows Firewall.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('firewall-policies driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows firewall', {
    name: 'Corp Windows Firewall',
    platform: 'Windows',
    description: 'Deny inbound, allow outbound',
    enabled: true,
    hostGroups: 'hg-workstations, hg-laptops',
    ruleGroups: 'rg-core, rg-rdp, rg-new',
    defaultInbound: 'DENY',
    defaultOutbound: 'ALLOW',
    enforce: true,
    localLogging: true,
    testMode: false,
  })
  const { restore } = recordFetch(lookup(shell(), container()))
  try {
    const result = await driftDetect(driftContext([POLICY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
