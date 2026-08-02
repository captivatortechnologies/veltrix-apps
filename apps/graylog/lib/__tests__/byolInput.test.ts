import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readByol } from '../byolInput'

// =============================================================================
// BYOL request validation (node_tiers-native) — the generic `tiers` array the
// SDK's <ByolInfrastructureManager> sends (graylog / opensearch), per-tier
// minimums (with the distributed OpenSearch ≥3 rule), the emitted `nodeTiers`
// shape, and the placement / topology-authoring fields.
// =============================================================================

function distributedBody(over: Record<string, unknown> = {}) {
  return {
    name: 'Prod',
    deploymentType: 'distributed',
    hosting_type: 'AWS',
    region: 'us-east-1',
    cloudProviderId: 'cp-1',
    tiers: [
      { key: 'graylog', count: 2 },
      { key: 'opensearch', count: 3 },
    ],
    ...over,
  }
}

// --- required + basic coercion ----------------------------------------------

test('readByol rejects a missing name', () => {
  assert.match(readByol({}).error ?? '', /Name is required/)
})

test('readByol defaults single-instance topology fields', () => {
  const { data } = readByol({
    name: 'Dev',
    deploymentType: 'single',
    tiers: [{ key: 'graylog', count: 1 }, { key: 'opensearch', count: 1 }],
  })
  assert.equal(data.controlPlaneLayout, 'dedicated')
  assert.equal(data.heavyForwarderCount, 1)
  const tiers = data.nodeTiers as Array<{ key: string; placement: unknown }>
  assert.equal(tiers[0].placement, null)
})

// --- generic tiers shape -----------------------------------------------------

test('readByol reads per-tier counts from the tiers array', () => {
  const { data, error } = readByol(distributedBody())
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; count: number }>
  assert.equal(tiers.find((t) => t.key === 'graylog')!.count, 2)
  assert.equal(tiers.find((t) => t.key === 'opensearch')!.count, 3)
})

test('readByol emits nodeTiers in [graylog, opensearch] order regardless of input order', () => {
  const { data } = readByol(
    distributedBody({
      tiers: [
        { key: 'opensearch', count: 3 },
        { key: 'graylog', count: 2 },
      ],
    }),
  )
  const tiers = data.nodeTiers as Array<{ key: string; count: number }>
  assert.deepEqual(tiers.map((t) => t.key), ['graylog', 'opensearch'])
  assert.equal(tiers[0].count, 2)
  assert.equal(tiers[1].count, 3)
})

test('readByol defaults a missing tier to a count of 1', () => {
  // Single deployment so the distributed opensearch ≥3 rule does not apply.
  const { data, error } = readByol({
    name: 'Dev',
    deploymentType: 'single',
    tiers: [{ key: 'graylog', count: 4 }],
  })
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; count: number }>
  assert.deepEqual(tiers, [
    { key: 'graylog', count: 4, placement: null },
    { key: 'opensearch', count: 1, placement: null },
  ])
})

// --- distributed guardrails (per-tier minimums) ------------------------------

test('readByol requires at least 1 Graylog nodes', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'graylog', count: 0 }, { key: 'opensearch', count: 3 }] }))
  assert.match(error ?? '', /Graylog nodes must be at least 1/)
})

test('readByol requires at least 3 OpenSearch nodes for a distributed cluster', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'graylog', count: 1 }, { key: 'opensearch', count: 2 }] }))
  assert.match(error ?? '', /OpenSearch nodes must be at least 3/)
})

test('readByol accepts a distributed OpenSearch cluster of exactly 3', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'graylog', count: 1 }, { key: 'opensearch', count: 3 }] }))
  assert.equal(error, undefined)
})

test('readByol allows a single-node deployment with one OpenSearch node', () => {
  const { error, data } = readByol({
    name: 'Eval',
    deploymentType: 'single',
    tiers: [{ key: 'graylog', count: 1 }, { key: 'opensearch', count: 1 }],
  })
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; count: number }>
  assert.equal(tiers.find((t) => t.key === 'opensearch')!.count, 1)
})

// --- control plane + forwarders ----------------------------------------------

test('readByol normalizes the control-plane layout and keeps a valid one', () => {
  assert.equal(readByol(distributedBody({ controlPlaneLayout: 'consolidated' })).data.controlPlaneLayout, 'consolidated')
  assert.equal(readByol(distributedBody({ controlPlaneLayout: 'bogus' })).data.controlPlaneLayout, 'dedicated')
})

test('readByol clamps the heavy forwarder count to a minimum of one', () => {
  assert.equal(readByol(distributedBody({ heavyForwarderCount: 3 })).data.heavyForwarderCount, 3)
  assert.equal(readByol(distributedBody({ heavyForwarderCount: 0 })).data.heavyForwarderCount, 1)
})

// --- instance type ------------------------------------------------------------

test('readByol trims a provided instance type', () => {
  assert.equal(readByol(distributedBody({ instanceType: '  t2.large ' })).data.instanceType, 't2.large')
})

test('readByol coerces an empty/absent instance type to null (cloud default)', () => {
  assert.equal(readByol(distributedBody({ instanceType: '   ' })).data.instanceType, null)
  assert.equal(readByol(distributedBody()).data.instanceType, null)
})

// --- deployment target --------------------------------------------------------

test('readByol requires a cloud account for a BYOC (dedicated) deployment', () => {
  const { error } = readByol(distributedBody({ networkMode: 'dedicated' }))
  assert.match(error ?? '', /cloud account is required/)
})

// --- placement (via tiers) ----------------------------------------------------

test('readByol accepts a valid multi-site placement on the opensearch tier', () => {
  const { data, error } = readByol(
    distributedBody({
      tiers: [
        { key: 'graylog', count: 2 },
        {
          key: 'opensearch',
          count: 4,
          placement: {
            mode: 'multi-site',
            granularity: 'az',
            sites: [
              { site: 'us-east-1a', percent: 50 },
              { site: 'us-east-1b', percent: 50 },
            ],
          },
        },
      ],
    }),
  )
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; placement: any }>
  assert.equal(tiers.find((t) => t.key === 'opensearch')!.placement.mode, 'multi-site')
})

test('readByol rejects placement whose percentages do not total 100, naming the tier', () => {
  const { error } = readByol(
    distributedBody({
      tiers: [
        { key: 'graylog', count: 2 },
        {
          key: 'opensearch',
          count: 4,
          placement: {
            mode: 'multi-site',
            sites: [
              { site: 'us-east-1a', percent: 60 },
              { site: 'us-east-1b', percent: 30 },
            ],
          },
        },
      ],
    }),
  )
  assert.match(error ?? '', /OpenSearch nodes placement: .*total 100/)
})

test('readByol rejects more sites than nodes on the graylog tier', () => {
  const { error } = readByol(
    distributedBody({
      tiers: [
        {
          key: 'graylog',
          count: 2,
          placement: {
            mode: 'multi-site',
            sites: [
              { site: 'us-east-1a', percent: 34 },
              { site: 'us-east-1b', percent: 33 },
              { site: 'us-east-1c', percent: 33 },
            ],
          },
        },
        { key: 'opensearch', count: 3 },
      ],
    }),
  )
  assert.match(error ?? '', /Graylog nodes placement: .*Too many sites/)
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
  const { error } = readByol(
    distributedBody({
      tiers: [{ key: 'graylog', count: 2 }, { key: 'opensearch', count: 4, placement: regionPlacement }],
    }),
  )
  assert.match(error ?? '', /multi-region placement requires a dedicated cloud fabric/)
})

test('readByol allows region-granularity placement in a dedicated (BYOC) deployment', () => {
  const { error } = readByol(
    distributedBody({
      networkMode: 'dedicated',
      cloudAccountConnectionId: 'acct-1',
      tiers: [{ key: 'graylog', count: 2 }, { key: 'opensearch', count: 4, placement: regionPlacement }],
    }),
  )
  assert.equal(error, undefined)
})

test('readByol drops placement entirely for a single-instance deployment', () => {
  const { data } = readByol({
    name: 'Dev',
    deploymentType: 'single',
    tiers: [
      {
        key: 'graylog',
        count: 1,
        placement: { mode: 'multi-site', sites: [{ site: 'a', percent: 50 }, { site: 'b', percent: 50 }] },
      },
      { key: 'opensearch', count: 1 },
    ],
  })
  const tiers = data.nodeTiers as Array<{ key: string; placement: unknown }>
  assert.equal(tiers[0].placement, null)
})
