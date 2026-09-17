// deploy for ariel-copy-profiles.
//
// The shared contract covers the pre-flight refusals. What is specific here:
// QRadar allows exactly ONE profile per host, so `host_id` — not the canvas item
// id and not the canvas label — is the identity this deploy matches on, and the
// label must never reach the console. The excluded retention buckets are
// declared by NAME and resolved against two read-only lookups before writing,
// so an unresolvable name has to fail the item rather than write a short list
// and silently start replicating data the operator excluded.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  pathOf,
  qradarError,
  routeFetch,
  writeCalls,
  type CannedResponse,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/disaster_recovery/ariel_copy_profiles'

const EVENT_BUCKETS = [
  { id: 101, name: 'Noise' },
  { id: 102, name: 'Debug' },
]
const FLOW_BUCKETS = [{ id: 201, name: 'Flow Noise' }]

const LABEL = 'DR to secondary site'

const DR = item(
  LABEL,
  {
    name: LABEL,
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

/** The live profile that matches DR exactly, before per-test edits. */
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

registerDeployGuardContract({ label: 'ariel-copy-profiles', handler: deploy, sampleItems: [DR] })

/** Two bucket lookups and the profile list fan out in a `Promise.all`, so match
 * on URL rather than imposing a call order that is not a contract. */
function fakeConsole(opts: {
  eventBuckets?: unknown[]
  flowBuckets?: unknown[]
  profiles?: unknown[]
  write?: CannedResponse
  remove?: CannedResponse
} = {}) {
  return routeFetch([
    { url: /\/config\/event_retention_buckets/, respond: list(opts.eventBuckets ?? EVENT_BUCKETS) },
    { url: /\/config\/flow_retention_buckets/, respond: list(opts.flowBuckets ?? FLOW_BUCKETS) },
    { url: /\/ariel_copy_profiles/, method: 'GET', respond: list(opts.profiles ?? []) },
    { url: /\/ariel_copy_profiles/, method: 'POST', respond: opts.write ?? created({ id: 77 }) },
    { url: /\/ariel_copy_profiles/, method: 'DELETE', respond: opts.remove ?? ACCEPTED },
  ])
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ?? []
}

test('ariel-copy-profiles deploy: creates a profile keyed by host_id, with the bucket names resolved to ids', async () => {
  const { calls, restore } = fakeConsole({ profiles: [] })
  try {
    const result = await deploy(deployContext([DR]))

    assertQRadarHeaders(assert, calls)
    const reads = calls.filter((c) => c.method === 'GET').map((c) => pathOf(c))
    assert.ok(reads.includes('/config/event_retention_buckets'), 'the event bucket lookup must be read')
    assert.ok(reads.includes('/config/flow_retention_buckets'), 'the flow bucket lookup must be read')
    assert.ok(reads.includes(PATH))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), PATH)
    assert.deepEqual(bodyOf(writes[0]), {
      host_id: 53,
      destination_host_ip: '10.20.0.5',
      enabled: true,
      destination_port: 32011,
      frequency: 3600,
      bandwidth_limit: 10240,
      exclude_event_retention_bucket_ids: [101, 102],
      exclude_flow_retention_bucket_ids: [201],
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].hostId, 53)
    assert.equal(entries[0].id, 77)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: the canvas label never reaches the console', async () => {
  // "name" is a Veltrix-side label; QRadar has no such field on this object.
  // Sending it risks a 422 on a console that validates unknown properties.
  const { calls, restore } = fakeConsole({ profiles: [] })
  try {
    await deploy(deployContext([DR]))

    for (const call of calls) {
      assert.equal(call.body.includes(LABEL), false, `the canvas label leaked into ${call.method} ${pathOf(call)}`)
      assert.equal(call.body.includes('"name"'), false, 'this object has no name field in QRadar')
    }
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: matches on host_id, not on the canvas item id or label', async () => {
  // The live profile carries the same host under a different QRadar id. Keying
  // on anything but host_id creates a second profile, which QRadar rejects —
  // or worse, leaves two definitions fighting over the same host.
  const { calls, restore } = fakeConsole({ profiles: [liveProfile({ id: 900, enabled: false })] })
  try {
    const result = await deploy(deployContext([DR]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), `${PATH}/900`, 'an existing host profile is updated in place')
    assert.equal(entriesOf(result)[0].id, 900)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: a profile for another host is not treated as this one', async () => {
  const { calls, restore } = fakeConsole({ profiles: [liveProfile({ id: 88, host_id: 99 })] })
  try {
    await deploy(deployContext([DR]))

    const writes = writeCalls(calls)
    assert.equal(pathOf(writes[0]), PATH, 'host 53 has no profile yet, so this is a create')
    assert.equal((bodyOf(writes[0]) as Record<string, unknown>).host_id, 53)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: updating records the LIVE prior state, not the desired one', async () => {
  // Every field of the live profile deliberately differs from the canvas. A
  // handler that captured what it was about to write would roll the DR target
  // back to the value the deploy itself introduced.
  const { restore } = fakeConsole({
    profiles: [
      liveProfile({
        destination_host_ip: '10.99.0.9',
        destination_port: 32000,
        enabled: false,
        frequency: 7200,
        bandwidth_limit: 2048,
        exclude_event_retention_bucket_ids: [102],
        exclude_flow_retention_bucket_ids: [],
      }),
    ],
  })
  try {
    const result = await deploy(deployContext([DR]))

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, {
      destinationHostIp: '10.99.0.9',
      destinationPort: 32000,
      enabled: false,
      frequency: 7200,
      bandwidthLimit: 2048,
      // The live profile had no schedule window; the captured state keeps those
      // keys absent in the JSON the platform stores, not filled with a default.
      startDate: undefined,
      endDate: undefined,
      excludeEventRetentionBucketIds: [102],
      excludeFlowRetentionBucketIds: [],
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: a profile that already matches is not written, but is still recorded', async () => {
  const { calls, restore } = fakeConsole({ profiles: [liveProfile()] })
  try {
    const result = await deploy(deployContext([DR]))

    assert.equal(writeCalls(calls).length, 0, 'an unchanged profile must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'rollback still needs to know the profile was under management')
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: an unresolvable event retention bucket fails the item without writing it', async () => {
  // The lookup answered; the bucket simply is not on this console. Writing a
  // shortened exclude list would start copying data the operator excluded —
  // over the DR link, at the bandwidth limit they set for the rest.
  const { calls, restore } = fakeConsole({ eventBuckets: [EVENT_BUCKETS[0]], profiles: [] })
  try {
    const result = await deploy(deployContext([DR]))

    assert.equal(writeCalls(calls).length, 0, 'an unresolved bucket must never reach a write')
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown event retention bucket "Debug"/)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: an unresolvable flow retention bucket fails the item without writing it', async () => {
  const { calls, restore } = fakeConsole({ flowBuckets: [], profiles: [] })
  try {
    const result = await deploy(deployContext([DR]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown flow retention bucket "Flow Noise"/)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: a profile excluding nothing sends empty id lists, not absent ones', async () => {
  const BARE = item(
    'DR bare',
    { name: 'DR bare', hostId: 54, destinationHostIp: '10.20.0.6', enabled: true },
    'item-bare',
  )
  const { calls, restore } = fakeConsole({ profiles: [] })
  try {
    await deploy(deployContext([BARE]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {
      host_id: 54,
      destination_host_ip: '10.20.0.6',
      enabled: true,
      exclude_event_retention_bucket_ids: [],
      exclude_flow_retention_bucket_ids: [],
    })
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: a rejected create is a failed result, not a thrown error', async () => {
  // QRadar's one-profile-per-host rule surfaces as a 409 the operator has to see.
  const { restore } = fakeConsole({
    profiles: [],
    write: qradarError(409, 'host_id parameter already exists'),
  })
  try {
    const result = await deploy(deployContext([DR]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /host_id parameter already exists/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: deletes a profile it created before and no longer declares', async () => {
  const { calls, restore } = fakeConsole({ profiles: [] })
  try {
    const result = await deploy(
      deployContext([DR], {
        priorRollbackData: {
          entries: [
            { itemId: 'item-old', name: 'Retired DR', hostId: 60, existed: false, id: 61 },
            { itemId: 'item-op', name: 'Operator Owned', hostId: 70, existed: true, id: 71 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${PATH}/61`])
    assert.equal(
      deletes.some((p) => p.endsWith('/71')),
      false,
      'a profile that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: a prior entry whose host is still declared is kept', async () => {
  // The profile was re-declared under a new canvas item. Reconciling on the
  // canvas item id rather than the host would delete the live DR profile and
  // immediately recreate it, interrupting replication for no reason.
  const { calls, restore } = fakeConsole({ profiles: [liveProfile()] })
  try {
    const result = await deploy(
      deployContext([DR], {
        priorRollbackData: {
          entries: [{ itemId: 'item-old', name: 'Old label', hostId: 53, existed: false, id: 77 }],
        },
      }),
    )

    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'the host is still declared')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = fakeConsole({ profiles: [] })
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})
