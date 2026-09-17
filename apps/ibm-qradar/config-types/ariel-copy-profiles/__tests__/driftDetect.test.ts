// driftDetect for ariel-copy-profiles.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the live profile is found by HOST ID, so "no profile for this
// host" is the absence that matters, and the destination host IP is the one
// field flagged CRITICAL — a DR copy repointed at another address is data
// leaving the customer's estate for somewhere nobody declared.
//
// NOTE: the schedule window (start_date / end_date) is compared by deploy but
// not here, so a console edit to it reads as in sync. That gap is in the defect
// report; no test here asserts it as correct.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, pathOf, routeFetch, writeCalls } from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/disaster_recovery/ariel_copy_profiles'

const EVENT_BUCKETS = [
  { id: 101, name: 'Noise' },
  { id: 102, name: 'Debug' },
]
const FLOW_BUCKETS = [{ id: 201, name: 'Flow Noise' }]

const DR = item(
  'DR to secondary site',
  {
    name: 'DR to secondary site',
    hostId: 53,
    destinationHostIp: '10.20.0.5',
    destinationPort: 32011,
    enabled: true,
    frequency: 3600,
    bandwidthLimit: 10240,
    excludeEventRetentionBucketNames: 'Noise\nDebug',
    excludeFlowRetentionBucketNames: 'Flow Noise',
  },
  'item-dr',
)

function liveProfile(over: Record<string, unknown> = {}) {
  return {
    id: 77,
    host_id: 53,
    destination_host_ip: '10.20.0.5',
    destination_port: 32011,
    enabled: true,
    frequency: 3600,
    bandwidth_limit: 10240,
    exclude_event_retention_bucket_ids: [101, 102],
    exclude_flow_retention_bucket_ids: [201],
    ...over,
  }
}

registerDriftGuardContract({ label: 'ariel-copy-profiles', handler: driftDetect, sampleItems: [DR] })

function fakeConsole(opts: { eventBuckets?: unknown[]; flowBuckets?: unknown[]; profiles?: unknown[] } = {}) {
  return routeFetch([
    { url: /\/config\/event_retention_buckets/, respond: list(opts.eventBuckets ?? EVENT_BUCKETS) },
    { url: /\/config\/flow_retention_buckets/, respond: list(opts.flowBuckets ?? FLOW_BUCKETS) },
    { url: /\/ariel_copy_profiles/, respond: list(opts.profiles ?? []) },
  ])
}

test('ariel-copy-profiles driftDetect: reports in sync when the live profile matches', async () => {
  const { calls, restore } = fakeConsole({ profiles: [liveProfile()] })
  try {
    const result = await driftDetect(driftContext([DR]))

    assert.ok(calls.some((c) => pathOf(c) === PATH))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`; reading it would report
  // the real profile as absent.
  const { restore } = fakeConsole({ profiles: [liveProfile()] })
  try {
    const result = await driftDetect(driftContext([DR]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: a profile removed from the host is critical', async () => {
  // The console answered the list; there is simply no profile for host 53, so
  // nothing is being replicated off it at all.
  const { restore } = fakeConsole({ profiles: [liveProfile({ id: 88, host_id: 99 })] })
  try {
    const result = await driftDetect(driftContext([DR]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'DR to secondary site', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: a destination repointed in the console is critical', async () => {
  const { restore } = fakeConsole({ profiles: [liveProfile({ destination_host_ip: '203.0.113.9' })] })
  try {
    const result = await driftDetect(driftContext([DR]))

    const diff = result.diffs.find((d) => d.field === 'DR to secondary site.destinationHostIp')
    assert.ok(diff, `expected a destinationHostIp diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, '10.20.0.5')
    assert.equal(diff.actual, '203.0.113.9')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: a profile switched off in the console is a warning', async () => {
  const { restore } = fakeConsole({ profiles: [liveProfile({ enabled: false })] })
  try {
    const result = await driftDetect(driftContext([DR]))

    const diff = result.diffs.find((d) => d.field === 'DR to secondary site.enabled')
    assert.ok(diff)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: an excluded bucket added back in the console is reported', async () => {
  // The declared names are resolved through the same read-only lookups deploy
  // uses, so the comparison is id-to-id and the diff is shown by name.
  const { restore } = fakeConsole({ profiles: [liveProfile({ exclude_event_retention_bucket_ids: [101] })] })
  try {
    const result = await driftDetect(driftContext([DR]))

    const diff = result.diffs.find((d) => d.field === 'DR to secondary site.excludeEventRetentionBucketNames')
    assert.ok(diff, `expected an exclude-list diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'Noise, Debug')
    assert.equal(diff.actual, '101')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: an exclude list returned in another order is not drift', async () => {
  // QRadar does not promise an order for these ids; comparing them as given
  // would raise drift on every run for a profile nobody touched.
  const { restore } = fakeConsole({ profiles: [liveProfile({ exclude_event_retention_bucket_ids: [102, 101] })] })
  try {
    const result = await driftDetect(driftContext([DR]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: reports the bandwidth limit and frequency lowered in the console', async () => {
  const { restore } = fakeConsole({ profiles: [liveProfile({ bandwidth_limit: 128, frequency: 86400 })] })
  try {
    const result = await driftDetect(driftContext([DR]))

    assert.deepEqual(
      result.diffs.map((d) => `${d.field}:${d.severity}`),
      ['DR to secondary site.frequency:warning', 'DR to secondary site.bandwidthLimit:warning'],
    )
  } finally {
    restore()
  }
})

test('ariel-copy-profiles driftDetect: an empty deployed config checks nothing and never writes', async () => {
  const { calls, restore } = fakeConsole({ profiles: [] })
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
