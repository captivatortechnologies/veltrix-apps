// driftDetect for sv-exclusions.
//
// The shared contract covers the invariants: drift never writes, a deleted
// exclusion is critical drift, and a 500 is never reported as the exclusion
// being gone. A sensor visibility exclusion has exactly one managed dimension
// beyond its identity — WHERE it applies — so everything specific here is about
// targeting: an exclusion narrowed from the fleet to a host group stops
// suppressing the telemetry it was written to suppress, and one widened the
// other way blinds the sensor on hosts nobody agreed to.

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

const GLOBAL_EXCLUSION = item('Backup agent', {
  value: '/opt/backup/agent/**',
  appliedGlobally: true,
})

const SCOPED_EXCLUSION = item('Build fleet', {
  value: '/opt/build/**',
  appliedGlobally: false,
  hostGroups: 'hg-build-1, hg-build-2',
})

registerDriftContract({ label: 'sv-exclusions', handler: driftDetect, items: [GLOBAL_EXCLUSION] })

/** The live exclusion exactly matching GLOBAL_EXCLUSION, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'sv-live-1',
  value: '/opt/backup/agent/**',
  applied_globally: true,
  groups: [],
  ...over,
})

/** The live exclusion exactly matching SCOPED_EXCLUSION. */
const liveScoped = (over: Record<string, unknown> = {}) => ({
  id: 'sv-live-2',
  value: '/opt/build/**',
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

test('sv-exclusions driftDetect: reports no drift when the tenant matches', async () => {
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

test('sv-exclusions driftDetect: reports a fleet-wide exclusion narrowed to host groups as critical', async () => {
  const { restore } = recordFetch(
    lookup(live({ applied_globally: false, groups: [{ id: 'hg-legacy-1' }] })),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/backup/agent/**.appliedGlobally')
    assert.ok(diff, `expected an appliedGlobally diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('sv-exclusions driftDetect: reports a scoped exclusion widened to the whole fleet as critical', async () => {
  // Every host in the tenant is now blind to the matching path. That is the more
  // dangerous direction, and it must not be reported as a mere warning.
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

test('sv-exclusions driftDetect: reports a host group added to a scoped exclusion', async () => {
  const { restore } = recordFetch(
    lookup(
      liveScoped({ groups: [{ id: 'hg-build-1' }, { id: 'hg-build-2' }, { id: 'hg-prod-1' }] }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/build/**.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-build-1, hg-build-2')
    assert.equal(diff.actual, 'hg-build-1, hg-build-2, hg-prod-1')
  } finally {
    restore()
  }
})

test('sv-exclusions driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
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

test('sv-exclusions driftDetect: reads host groups whether Falcon returns ids or objects', async () => {
  // `exclusionGroupIds` accepts both shapes; a bare-string groups array must not
  // read as "no host groups" and produce phantom drift.
  const { restore } = recordFetch(lookup(liveScoped({ groups: ['hg-build-1', 'hg-build-2'] })))
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('sv-exclusions driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        applied_globally: false,
        groups: [{ id: 'hg-legacy-1' }],
        modified_by: 'alice@acme.com',
        last_modified: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/backup/agent/**.appliedGlobally')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('sv-exclusions driftDetect: does not attribute drift to our own API client', async () => {
  const { restore } = recordFetch(
    lookup(live({ applied_globally: false, groups: [{ id: 'hg-legacy-1' }], modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === '/opt/backup/agent/**.appliedGlobally')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('sv-exclusions driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // An edit the operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Backup agent', {
    value: '/opt/backup/agent/**',
    appliedGlobally: false,
    hostGroups: 'hg-build-1',
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
