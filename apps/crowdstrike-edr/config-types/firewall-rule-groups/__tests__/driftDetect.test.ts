// driftDetect for firewall-rule-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is that the rules live INSIDE the group, so a group that is
// still present and still enabled can have had its DENY rule flipped to ALLOW.
//
// The undeclared-rule diff matters for a second reason: deploy treats the canvas
// as the complete rule set and REMOVES live rules it does not declare, so this
// diff is the only warning an operator gets before that happens.

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

const DECLARED_RULE = {
  name: 'Block outbound SMB',
  description: 'No SMB egress',
  action: 'DENY',
  direction: 'OUT',
  protocol: 'TCP',
  addressFamily: 'IP4',
  remotePorts: [445],
  enabled: true,
}

const GROUP = item('Windows egress controls', {
  name: 'veltrix-fw-windows',
  platform: 'windows',
  description: 'No SMB egress',
  enabled: true,
  rules: JSON.stringify([DECLARED_RULE]),
})

registerDriftContract({ label: 'firewall-rule-groups', handler: driftDetect, items: [GROUP] })

/** The live counterpart of DECLARED_RULE — canonically equal to it. */
const liveSmbRule = (over: Record<string, unknown> = {}) => ({
  id: 'fr-smb',
  name: 'Block outbound SMB',
  description: 'No SMB egress',
  enabled: true,
  action: 'DENY',
  direction: 'OUT',
  protocol: '6',
  address_family: 'IP4',
  local_port: [],
  remote_port: [{ start: 445, end: 0 }],
  local_address: [],
  remote_address: [],
  fields: [{ name: 'network_location', type: 'set', values: ['ANY'] }],
  ...over,
})

/** The live group exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'frg-live-1',
  name: 'veltrix-fw-windows',
  platform: 'windows',
  description: 'No SMB egress',
  enabled: true,
  tracking: 'tracking-token-abc',
  rules: [liveSmbRule()],
  ...over,
})

/** The two-call lookup every fwmgr rule-group read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('firewall-rule-groups driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a group disabled in the console as critical', async () => {
  const { restore } = recordFetch(lookup(live({ enabled: false })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a DENY rule flipped to ALLOW inside a live group', async () => {
  // The group is present, enabled, and the rule is still there under the same
  // name — only its action changed, and the egress it blocked is now permitted.
  const { restore } = recordFetch(lookup(live({ rules: [liveSmbRule({ action: 'ALLOW' })] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.rules.Block outbound SMB')
    assert.ok(diff, `expected a rule diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.expected), /DENY/)
    assert.match(String(diff.actual), /ALLOW/)
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a declared rule removed from the group as critical', async () => {
  const { restore } = recordFetch(lookup(live({ rules: [] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.rules.Block outbound SMB')
    assert.ok(diff, `expected a rule-presence diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not present on group')
    assert.equal(diff.severity, 'critical', 'a declared enabled rule that is gone is not enforcing')
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a rule disabled inside the group', async () => {
  const { restore } = recordFetch(lookup(live({ rules: [liveSmbRule({ enabled: false })] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.ok(
      result.diffs.some((d) => d.field === 'veltrix-fw-windows.rules.Block outbound SMB'),
      `expected a rule diff, got ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a live rule this canvas never declared', async () => {
  // Deploy treats the canvas as the complete rule set and would REMOVE this
  // rule. Reporting it here is the only warning before that happens.
  const analyst = { ...liveSmbRule(), id: 'fr-analyst', name: 'Allow lab RDP', action: 'ALLOW' }
  const { restore } = recordFetch(lookup(live({ rules: [liveSmbRule(), analyst] })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.rules.Allow lab RDP')
    assert.ok(diff, `expected an undeclared-rule diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'not declared')
    assert.equal(diff.actual, 'present on group (undeclared)')
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a group recreated on another platform', async () => {
  // findRuleGroup pins name AND platform, so a platform change means the group
  // this configuration deployed is no longer resolvable under that name.
  const { restore } = recordFetch(lookup(live({ platform: 'mac' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    assert.ok(
      result.diffs.some((d) => d.field === 'veltrix-fw-windows'),
      `expected the group to read as unresolvable, got ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reports a description change as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.description')
    assert.ok(diff)
    assert.equal(diff.severity, 'info', 'a description change does not change what is enforced')
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ enabled: false, modified_by: 'alice@acme.com', modified_on: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ enabled: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-fw-windows.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('firewall-rule-groups driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Windows egress controls', {
    name: 'veltrix-fw-windows',
    platform: 'windows',
    description: 'No SMB egress',
    enabled: false,
    rules: JSON.stringify([{ ...DECLARED_RULE, action: 'ALLOW' }]),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GROUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
