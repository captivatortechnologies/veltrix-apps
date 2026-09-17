// driftDetect for ml-exclusions.
//
// The shared contract covers the invariants: drift never writes, a deleted
// exclusion is critical drift, and a 500 is never reported as the exclusion
// being gone. What is specific here is the comparison — excluded-from sources
// and, above all, the targeting: an exclusion silently narrowed from the whole
// fleet to a host group (or widened the other way) is the change that stops it
// protecting what it was written to protect.

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

const GLOBAL_EXCLUSION = item('Vendor agent', {
  value: '/opt/vendor/agent/**',
  excludedFrom: 'blocking, extraction',
  appliedGlobally: true,
})

const SCOPED_EXCLUSION = item('Build fleet', {
  value: '/opt/build/**',
  excludedFrom: 'blocking',
  appliedGlobally: false,
  hostGroups: 'hg-build-1, hg-build-2',
})

registerDriftContract({ label: 'ml-exclusions', handler: driftDetect, items: [GLOBAL_EXCLUSION] })

/** The live exclusion exactly matching GLOBAL_EXCLUSION, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'ml-live-1',
  value: '/opt/vendor/agent/**',
  excluded_from: ['blocking', 'extraction'],
  applied_globally: true,
  groups: [],
  ...over,
})

/** The live exclusion exactly matching SCOPED_EXCLUSION. */
const liveScoped = (over: Record<string, unknown> = {}) => ({
  id: 'ml-live-2',
  value: '/opt/build/**',
  excluded_from: ['blocking'],
  applied_globally: false,
  groups: [{ id: 'hg-build-1' }, { id: 'hg-build-2' }],
  ...over,
})

/** The two-call lookup every exclusion-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('ml-exclusions driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: reports an excluded-from source removed in the console', async () => {
  const { restore } = recordFetch(lookup(live({ excluded_from: ['extraction'] })))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === '/opt/vendor/agent/**.excludedFrom')
    assert.ok(diff, `expected an excludedFrom diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'blocking, extraction')
    assert.equal(diff.actual, 'extraction')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: reports a fleet-wide exclusion narrowed to host groups as critical', async () => {
  // The exclusion no longer covers the fleet it was written for. This is the
  // silent change the whole config type exists to catch.
  const { restore } = recordFetch(
    lookup(live({ applied_globally: false, groups: [{ id: 'hg-legacy-1' }] })),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/vendor/agent/**.appliedGlobally')
    assert.ok(diff, `expected an appliedGlobally diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: reports a scoped exclusion widened to the whole fleet as critical', async () => {
  const { restore } = recordFetch(lookup(liveScoped({ applied_globally: true, groups: [] })))
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/build/**.appliedGlobally')
    assert.ok(diff, `expected an appliedGlobally diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, false)
    assert.equal(diff.actual, true)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: reports a host group removed from a scoped exclusion', async () => {
  const { restore } = recordFetch(lookup(liveScoped({ groups: [{ id: 'hg-build-1' }] })))
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/build/**.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-build-1, hg-build-2')
    assert.equal(diff.actual, 'hg-build-1')
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(
    lookup(liveScoped({ groups: [{ id: 'hg-build-2' }, { id: 'hg-build-1' }] })),
  )
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    assert.equal(
      result.hasDrift,
      false,
      `reordered host groups are not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: leaves host groups unreported while the exclusion is still global', async () => {
  // Falcon reports a globally applied exclusion with an empty groups array; a
  // group list echoed back alongside applied_globally:true changes nothing about
  // what the exclusion covers, so it is not this configuration's drift.
  const { restore } = recordFetch(lookup(live({ groups: [{ id: 'hg-noise-1' }] })))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    assert.equal(
      result.diffs.some((d) => d.field === '/opt/vendor/agent/**.hostGroups'),
      false,
      'host groups are not managed while the exclusion applies globally',
    )
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        excluded_from: ['extraction'],
        modified_by: 'alice@acme.com',
        last_modified: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/vendor/agent/**.excludedFrom')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(live({ excluded_from: ['extraction'], modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/vendor/agent/**.excludedFrom')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ml-exclusions driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Vendor agent', {
    value: '/opt/vendor/agent/**',
    excludedFrom: 'blocking',
    appliedGlobally: true,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION], { canvasItems: [edited] }))

    assert.equal(
      result.hasDrift,
      false,
      `compared against the canvas: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})
