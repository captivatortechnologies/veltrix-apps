// driftDetect for cloud-compliance-frameworks.
//
// The shared contract covers the invariants: drift never writes, a deleted
// framework is critical drift, and a 500 is never reported as the framework
// being gone. What is specific here is the comparison itself — description is
// always compared, version only when the canvas declares one (Falcon assigns it
// otherwise) — plus the attribution that rides on the live framework's
// `modified_by`.
//
// NOT ASSERTED, deliberately: `active`. Deploy writes `active: true` on every
// create AND every update, and rollback restores the prior value, so the field
// is plainly managed — but this handler never compares it, so a framework
// switched off in the Falcon console comes back as "in sync". Asserting the
// current behaviour either way would bless that; see the accompanying report.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  CannedResponse,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const FRAMEWORK = item('ACME cloud baseline', {
  name: 'ACME Cloud Baseline',
  description: 'Internal cloud control baseline',
})

registerDriftContract({ label: 'cloud-compliance-frameworks', handler: driftDetect, items: [FRAMEWORK] })

/** The live framework exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  uuid: 'fw-live-1',
  name: 'ACME Cloud Baseline',
  description: 'Internal cloud control baseline',
  active: true,
  version: '1.0',
  ...over,
})

/** The two-call lookup every frameworks read performs: id query, then get. */
function lookup(entity: Record<string, unknown>): CannedResponse[] {
  return [TOKEN, idsPage([String(entity.uuid)]), entityPage([entity])]
}

test('cloud-compliance-frameworks driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([FRAMEWORK]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: reports a description rewritten in the Falcon console', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([FRAMEWORK]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'ACME Cloud Baseline.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Internal cloud control baseline')
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: reports a description cleared in the console as "none"', async () => {
  const { restore } = recordFetch(lookup(live({ description: '' })))
  try {
    const result = await driftDetect(driftContext([FRAMEWORK]))

    const diff = result.diffs.find((d) => d.field === 'ACME Cloud Baseline.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'none')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: leaves the version unmanaged when the canvas declared none', async () => {
  // Falcon assigns the version, so a canvas that does not pin one does not own
  // it and a bump in the console is not this configuration's drift to report.
  const { restore } = recordFetch(lookup(live({ version: '3.7' })))
  try {
    const result = await driftDetect(driftContext([FRAMEWORK]))

    assert.equal(
      result.diffs.some((d) => d.field === 'ACME Cloud Baseline.version'),
      false,
      `an undeclared version must not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: reports a version that no longer matches the declared one', async () => {
  const pinned = item('ACME cloud baseline', {
    name: 'ACME Cloud Baseline',
    description: 'Internal cloud control baseline',
    version: '1.0',
  })
  const { restore } = recordFetch(lookup(live({ version: '3.7' })))
  try {
    const result = await driftDetect(driftContext([pinned]))

    const diff = result.diffs.find((d) => d.field === 'ACME Cloud Baseline.version')
    assert.ok(diff, `expected a version diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '1.0')
    assert.equal(diff.actual, '3.7')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        description: 'edited by hand',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([FRAMEWORK]))

    const diff = result.diffs.find((d) => d.field === 'ACME Cloud Baseline.description')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(live({ description: 'edited by hand', modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([FRAMEWORK]))

    const diff = result.diffs.find((d) => d.field === 'ACME Cloud Baseline.description')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-compliance-frameworks driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('ACME cloud baseline', {
    name: 'ACME Cloud Baseline',
    description: 'a description nobody has deployed yet',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([FRAMEWORK], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
