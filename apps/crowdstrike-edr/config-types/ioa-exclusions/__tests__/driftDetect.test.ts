// driftDetect for ioa-exclusions.
//
// The shared contract covers the invariants: drift never writes, a deleted
// exclusion is critical drift, and a 500 is never reported as the exclusion
// being gone. What is specific here is the comparison: the pattern id decides
// WHICH behaviour is suppressed and the two regexes decide WHAT matches, while
// the targeting fields decide WHERE — an exclusion silently moved off the fleet
// (or onto it) is the change that stops it protecting what it was written for.

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

const GLOBAL_EXCLUSION = item('Deployment agent', {
  name: 'vendor-deployment-agent',
  patternId: '10197',
  clRegex: '.*deploy-agent\\.exe.*',
  ifnRegex: '.*\\\\Program Files\\\\Vendor\\\\.*',
  appliedGlobally: true,
})

const SCOPED_EXCLUSION = item('Build fleet', {
  name: 'build-fleet-compiler',
  patternId: '10321',
  clRegex: '.*msbuild\\.exe.*',
  ifnRegex: '.*\\\\build\\\\.*',
  appliedGlobally: false,
  hostGroups: 'hg-build-1, hg-build-2',
})

registerDriftContract({ label: 'ioa-exclusions', handler: driftDetect, items: [GLOBAL_EXCLUSION] })

/** The live exclusion exactly matching GLOBAL_EXCLUSION, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'ioa-live-1',
  name: 'vendor-deployment-agent',
  pattern_id: '10197',
  cl_regex: '.*deploy-agent\\.exe.*',
  ifn_regex: '.*\\\\Program Files\\\\Vendor\\\\.*',
  applied_globally: true,
  groups: [],
  ...over,
})

/** The live exclusion exactly matching SCOPED_EXCLUSION. */
const liveScoped = (over: Record<string, unknown> = {}) => ({
  id: 'ioa-live-2',
  name: 'build-fleet-compiler',
  pattern_id: '10321',
  cl_regex: '.*msbuild\\.exe.*',
  ifn_regex: '.*\\\\build\\\\.*',
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

test('ioa-exclusions driftDetect: reports no drift when the tenant matches', async () => {
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

test('ioa-exclusions driftDetect: reports a re-pointed pattern id as critical', async () => {
  // The exclusion now suppresses a different behaviour entirely — the pattern id
  // is the field that decides what is no longer being detected.
  const { restore } = recordFetch(lookup(live({ pattern_id: '10004' })))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'vendor-deployment-agent.patternId')
    assert.ok(diff, `expected a patternId diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '10197')
    assert.equal(diff.actual, '10004')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: reports a widened command-line regex', async () => {
  // `.*` matches every command line, so an exclusion edited this way suppresses
  // the whole pattern rather than one binary.
  const { restore } = recordFetch(lookup(live({ cl_regex: '.*' })))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'vendor-deployment-agent.clRegex')
    assert.ok(diff, `expected a clRegex diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '.*deploy-agent\\.exe.*')
    assert.equal(diff.actual, '.*')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: reports an image-filename regex cleared in the console', async () => {
  const { restore } = recordFetch(lookup(live({ ifn_regex: '' })))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'vendor-deployment-agent.ifnRegex')
    assert.ok(diff, `expected an ifnRegex diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: reports a fleet-wide exclusion narrowed to host groups as critical', async () => {
  const { restore } = recordFetch(
    lookup(live({ applied_globally: false, groups: [{ id: 'hg-legacy-1' }] })),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'vendor-deployment-agent.appliedGlobally')
    assert.ok(diff, `expected an appliedGlobally diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: reports a scoped exclusion widened to the whole fleet as critical', async () => {
  const { restore } = recordFetch(lookup(liveScoped({ applied_globally: true, groups: [] })))
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'build-fleet-compiler.appliedGlobally')
    assert.ok(diff, `expected an appliedGlobally diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, false)
    assert.equal(diff.actual, true)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: reports a host group removed from a scoped exclusion', async () => {
  const { restore } = recordFetch(lookup(liveScoped({ groups: [{ id: 'hg-build-1' }] })))
  try {
    const result = await driftDetect(driftContext([SCOPED_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'build-fleet-compiler.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-build-1, hg-build-2')
    assert.equal(diff.actual, 'hg-build-1')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: ignores host-group ORDER, which Falcon does not preserve', async () => {
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

test('ioa-exclusions driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        pattern_id: '10004',
        modified_by: 'alice@acme.com',
        last_modified: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'vendor-deployment-agent.patternId')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: does not attribute drift to our own API client', async () => {
  const { restore } = recordFetch(lookup(live({ pattern_id: '10004', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([GLOBAL_EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'vendor-deployment-agent.patternId')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ioa-exclusions driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // An edit the operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Deployment agent', {
    name: 'vendor-deployment-agent',
    patternId: '10321',
    clRegex: '.*deploy-agent\\.exe.*',
    ifnRegex: '.*\\\\Program Files\\\\Vendor\\\\.*',
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
