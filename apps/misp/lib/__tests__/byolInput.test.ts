import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readByol } from '../byolInput'

// =============================================================================
// BYOL request validation — scalar coercion, the generic `tiers` shape the
// SDK's <ByolInfrastructureManager> now sends (database/core), its fallback to
// the legacy indexerCount/searchHeadCount/*Placement fields, and the
// topology-authoring fields (control-plane layout, heavy forwarders, placement).
// =============================================================================

function distributedBody(over: Record<string, unknown> = {}) {
  return {
    name: 'Prod',
    deploymentType: 'distributed',
    hosting_type: 'AWS',
    region: 'us-east-1',
    cloudProviderId: 'cp-1',
    tiers: [
      { key: 'database', count: 3 },
      { key: 'core', count: 2 },
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
    tiers: [{ key: 'database', count: 1 }, { key: 'core', count: 1 }],
  })
  assert.equal(data.controlPlaneLayout, 'dedicated')
  assert.equal(data.heavyForwarderCount, 1)
  assert.equal(data.indexerPlacement, null)
  assert.equal(data.searchHeadPlacement, null)
})

// --- generic tiers shape -----------------------------------------------------

test('readByol reads indexerCount/searchHeadCount from the tiers array', () => {
  const { data, error } = readByol(distributedBody())
  assert.equal(error, undefined)
  assert.equal(data.indexerCount, 3)
  assert.equal(data.searchHeadCount, 2)
})

test('readByol exposes nodeTiers in [database, core] order regardless of input shape', () => {
  const { data } = readByol(distributedBody())
  const tiers = data.nodeTiers as Array<{ key: string; count: number }>
  assert.equal(tiers[0].key, 'database')
  assert.equal(tiers[0].count, 3)
  assert.equal(tiers[1].key, 'core')
  assert.equal(tiers[1].count, 2)
})

test('readByol falls back to the legacy scalar fields when tiers is absent', () => {
  const { data, error } = readByol({
    name: 'Prod',
    deploymentType: 'distributed',
    hosting_type: 'AWS',
    region: 'us-east-1',
    cloudProviderId: 'cp-1',
    indexerCount: 5,
    searchHeadCount: 3,
  })
  assert.equal(error, undefined)
  assert.equal(data.indexerCount, 5)
  assert.equal(data.searchHeadCount, 3)
  const tiers = data.nodeTiers as Array<{ key: string; count: number; placement: unknown }>
  assert.deepEqual(tiers[0], { key: 'database', count: 5, placement: null })
  assert.deepEqual(tiers[1], { key: 'core', count: 3, placement: null })
})

test('readByol falls back per-tier when the tiers array only partially overrides the legacy fields', () => {
  const { data } = readByol(
    distributedBody({
      tiers: [{ key: 'database', count: 6 }],
      searchHeadCount: 3,
    }),
  )
  assert.equal(data.indexerCount, 6)
  assert.equal(data.searchHeadCount, 3)
})

// --- distributed guardrails (per-tier minimums) ------------------------------

test('readByol requires at least 1 Database nodes', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'database', count: 0 }, { key: 'core', count: 2 }] }))
  assert.match(error ?? '', /Database nodes must be at least 1/)
})

test('readByol requires at least 1 MISP core nodes', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'database', count: 3 }, { key: 'core', count: 0 }] }))
  assert.match(error ?? '', /MISP core nodes must be at least 1/)
})

test('readByol accepts the minimums exactly (1 database / 1 core)', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'database', count: 1 }, { key: 'core', count: 1 }] }))
  assert.equal(error, undefined)
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

// --- placement (via tiers) ----------------------------------------------------

test('readByol accepts a valid multi-site placement on the database tier', () => {
  const { data, error } = readByol(
    distributedBody({
      tiers: [
        {
          key: 'database',
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
        { key: 'core', count: 2 },
      ],
    }),
  )
  assert.equal(error, undefined)
  assert.equal((data.indexerPlacement as any).mode, 'multi-site')
})

test('readByol rejects placement whose percentages do not total 100, naming the tier', () => {
  const { error } = readByol(
    distributedBody({
      tiers: [
        {
          key: 'database',
          count: 4,
          placement: {
            mode: 'multi-site',
            sites: [
              { site: 'us-east-1a', percent: 60 },
              { site: 'us-east-1b', percent: 30 },
            ],
          },
        },
        { key: 'core', count: 2 },
      ],
    }),
  )
  assert.match(error ?? '', /Database nodes placement: .*total 100/)
})

test('readByol rejects more sites than nodes on the core tier', () => {
  const { error } = readByol(
    distributedBody({
      tiers: [
        { key: 'database', count: 4 },
        {
          key: 'core',
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
      ],
    }),
  )
  assert.match(error ?? '', /MISP core nodes placement: .*Too many sites/)
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
    distributedBody({ tiers: [{ key: 'database', count: 4, placement: regionPlacement }, { key: 'core', count: 2 }] }),
  )
  assert.match(error ?? '', /multi-region placement requires a dedicated cloud fabric/)
})

test('readByol allows region-granularity placement in a dedicated (BYOC) deployment', () => {
  const { error } = readByol(
    distributedBody({
      networkMode: 'dedicated',
      cloudAccountConnectionId: 'acct-1',
      tiers: [{ key: 'database', count: 4, placement: regionPlacement }, { key: 'core', count: 2 }],
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
        key: 'database',
        count: 1,
        placement: { mode: 'multi-site', sites: [{ site: 'a', percent: 50 }, { site: 'b', percent: 50 }] },
      },
      { key: 'core', count: 1 },
    ],
  })
  assert.equal(data.indexerPlacement, null)
})
