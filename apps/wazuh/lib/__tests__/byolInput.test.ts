// =============================================================================
// BYOL request validation — scalar coercion, distributed guardrails, the
// topology-authoring fields (control-plane layout, dashboards, placement), and
// the generic `tiers: [{ key, count, placement }]` array the SDK's
// ByolInfrastructureManager now sends in place of the old fixed
// indexerCount/searchHeadCount pair. Wazuh's two tiers: 'indexer' (Wazuh
// indexer/OpenSearch) and 'worker' (Wazuh manager worker nodes).
// =============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readByol } from '../byolInput'

const distributedBody = (over: Record<string, unknown> = {}) => ({
  name: 'Prod',
  deploymentType: 'distributed',
  hosting_type: 'AWS',
  region: 'us-east-1',
  cloudProviderId: 'cp-1',
  indexerCount: 4,
  searchHeadCount: 2,
  ...over,
})

const tiersOf = (
  indexerCount: number,
  workerCount: number,
  placements: Record<string, unknown> = {},
) => [
  { key: 'indexer', count: indexerCount, placement: placements.indexer ?? null },
  { key: 'worker', count: workerCount, placement: placements.worker ?? null },
]

// --- required + basic coercion ----------------------------------------------

test('readByol rejects a missing name', () => {
  assert.match(String(readByol({}).error), /Name is required/)
})

test('readByol defaults single-instance topology fields', () => {
  const { data } = readByol({ name: 'Dev', deploymentType: 'single', indexerCount: 1, searchHeadCount: 1 })
  assert.equal(data.controlPlaneLayout, 'dedicated')
  assert.equal(data.heavyForwarderCount, 1)
  assert.equal(data.indexerPlacement, null)
  assert.equal(data.searchHeadPlacement, null)
})

// --- legacy body (no tiers array) -------------------------------------------

test('readByol reads indexerCount/searchHeadCount straight off the body when tiers is absent', () => {
  const { data } = readByol(distributedBody({ indexerCount: 5, searchHeadCount: 3 }))
  assert.equal(data.indexerCount, 5)
  assert.equal(data.searchHeadCount, 3)
})

test('readByol still populates an ordered nodeTiers snapshot for a legacy caller', () => {
  const { data } = readByol(distributedBody({ indexerCount: 5, searchHeadCount: 3 }))
  assert.deepEqual(data.nodeTiers, [
    { key: 'indexer', count: 5, placement: null },
    { key: 'worker', count: 3, placement: null },
  ])
})

// --- generic tiers array -----------------------------------------------------

test('readByol reads counts from tiers[], overriding any stray legacy fields', () => {
  const { data } = readByol(
    distributedBody({
      indexerCount: 999,
      searchHeadCount: 999,
      tiers: tiersOf(4, 2),
    }),
  )
  assert.equal(data.indexerCount, 4)
  assert.equal(data.searchHeadCount, 2)
})

test('readByol builds nodeTiers in [indexer, worker] order from the tiers array', () => {
  const { data } = readByol(distributedBody({ tiers: tiersOf(6, 3) }))
  assert.deepEqual(data.nodeTiers, [
    { key: 'indexer', count: 6, placement: null },
    { key: 'worker', count: 3, placement: null },
  ])
})

test('readByol ignores unknown tier keys and defaults indexer/worker to 1 (no legacy fallback once tiers is present)', () => {
  const { error } = readByol(
    distributedBody({
      indexerCount: 4,
      searchHeadCount: 2,
      tiers: [{ key: 'bogus-tier', count: 99, placement: null }],
    }),
  )
  // `tiers` is present (even without 'indexer'/'worker' entries), so the
  // legacy indexerCount/searchHeadCount = 4/2 on the body are NOT consulted —
  // both tiers default to 1, tripping the distributed minimum.
  assert.match(String(error), /at least 3 indexers/)
})

// --- distributed guardrails ---------------------------------------------------

test('readByol requires at least 3 indexers / 2 manager workers (legacy body)', () => {
  assert.match(String(readByol(distributedBody({ indexerCount: 2 })).error), /at least 3 indexers/)
  assert.match(String(readByol(distributedBody({ searchHeadCount: 1 })).error), /at least 2 manager workers/)
})

test('readByol requires at least 3 indexers / 2 manager workers (tiers array)', () => {
  assert.match(String(readByol(distributedBody({ tiers: tiersOf(2, 2) })).error), /at least 3 indexers/)
  assert.match(String(readByol(distributedBody({ tiers: tiersOf(3, 1) })).error), /at least 2 manager workers/)
})

// --- control plane + forwarders -----------------------------------------------

test('readByol normalizes the control-plane layout and keeps a valid one', () => {
  assert.equal(readByol(distributedBody({ controlPlaneLayout: 'consolidated' })).data.controlPlaneLayout, 'consolidated')
  assert.equal(readByol(distributedBody({ controlPlaneLayout: 'bogus' })).data.controlPlaneLayout, 'dedicated')
})

test('readByol clamps the heavy forwarder count to a minimum of one', () => {
  assert.equal(readByol(distributedBody({ heavyForwarderCount: 3 })).data.heavyForwarderCount, 3)
  assert.equal(readByol(distributedBody({ heavyForwarderCount: 0 })).data.heavyForwarderCount, 1)
})

// --- instance type -------------------------------------------------------------

test('readByol trims a provided instance type', () => {
  assert.equal(readByol(distributedBody({ instanceType: '  t2.large ' })).data.instanceType, 't2.large')
})

test('readByol coerces an empty/absent instance type to null (cloud default)', () => {
  assert.equal(readByol(distributedBody({ instanceType: '   ' })).data.instanceType, null)
  assert.equal(readByol(distributedBody()).data.instanceType, null)
})

// --- placement (legacy top-level fields) ---------------------------------------

test('readByol accepts a valid multi-site indexer placement (legacy field)', () => {
  const { data, error } = readByol(
    distributedBody({
      indexerCount: 4,
      indexerPlacement: {
        mode: 'multi-site',
        granularity: 'az',
        sites: [
          { site: 'us-east-1a', percent: 50 },
          { site: 'us-east-1b', percent: 50 },
        ],
      },
    }),
  )
  assert.equal(error, undefined)
  assert.equal((data.indexerPlacement as any).mode, 'multi-site')
})

test('readByol rejects placement whose percentages do not total 100, error uses the tier label', () => {
  const { error } = readByol(
    distributedBody({
      indexerPlacement: {
        mode: 'multi-site',
        sites: [
          { site: 'us-east-1a', percent: 60 },
          { site: 'us-east-1b', percent: 30 },
        ],
      },
    }),
  )
  assert.match(String(error), /Indexers placement: .*total 100/)
})

test('readByol rejects more sites than nodes, error uses the "Manager workers" tier label', () => {
  const { error } = readByol(
    distributedBody({
      searchHeadCount: 2,
      searchHeadPlacement: {
        mode: 'multi-site',
        sites: [
          { site: 'us-east-1a', percent: 34 },
          { site: 'us-east-1b', percent: 33 },
          { site: 'us-east-1c', percent: 33 },
        ],
      },
    }),
  )
  assert.match(String(error), /Manager workers placement: .*Too many sites/)
})

const regionPlacement = {
  mode: 'multi-site',
  granularity: 'region',
  sites: [
    { site: 'us-east-1', percent: 50 },
    { site: 'us-west-2', percent: 50 },
  ],
} as const

test('readByol rejects region-granularity placement unless the network is dedicated (BYOC)', () => {
  const { error } = readByol(distributedBody({ indexerPlacement: regionPlacement }))
  assert.match(String(error), /multi-region placement requires a dedicated cloud fabric/)
})

test('readByol allows region-granularity placement in a dedicated (BYOC) deployment', () => {
  const { error } = readByol(
    distributedBody({
      networkMode: 'dedicated',
      cloudAccountConnectionId: 'acct-1',
      indexerPlacement: regionPlacement,
    }),
  )
  assert.equal(error, undefined)
})

test('readByol drops placement entirely for a single-instance deployment', () => {
  const { data } = readByol({
    name: 'Dev',
    deploymentType: 'single',
    indexerCount: 1,
    searchHeadCount: 1,
    indexerPlacement: {
      mode: 'multi-site',
      sites: [
        { site: 'a', percent: 50 },
        { site: 'b', percent: 50 },
      ],
    },
  })
  assert.equal(data.indexerPlacement, null)
})

// --- placement (generic tiers array) --------------------------------------------

const multiSite = {
  mode: 'multi-site',
  granularity: 'az',
  sites: [
    { site: 'us-east-1a', percent: 50 },
    { site: 'us-east-1b', percent: 50 },
  ],
}

test('readByol parses placement out of the matching tier entry', () => {
  const { data, error } = readByol(distributedBody({ tiers: tiersOf(4, 2, { indexer: multiSite }) }))
  assert.equal(error, undefined)
  assert.equal((data.indexerPlacement as any).mode, 'multi-site')
  assert.deepEqual(data.nodeTiers, [
    { key: 'indexer', count: 4, placement: multiSite },
    { key: 'worker', count: 2, placement: null },
  ])
})

test('readByol reports a placement error using the tier label, sourced from the tiers array', () => {
  const badPlacement = {
    mode: 'multi-site',
    sites: [
      { site: 'a', percent: 60 },
      { site: 'b', percent: 20 },
    ],
  }
  const { error } = readByol(distributedBody({ tiers: tiersOf(4, 2, { worker: badPlacement }) }))
  assert.match(String(error), /Manager workers placement: .*total 100/)
})
