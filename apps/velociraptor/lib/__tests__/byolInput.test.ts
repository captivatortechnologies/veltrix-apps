import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readByol } from '../byolInput'

// =============================================================================
// BYOL request validation — scalar coercion, the generic `tiers` shape the
// SDK's <ByolInfrastructureManager> sends (frontend/datastore), the per-tier
// minimums (with tier LABELS in the errors), and the topology-authoring fields
// (control-plane layout, placement). This app is node_tiers-native, so counts
// are read straight off `tiers` and always emitted back as `nodeTiers`.
// =============================================================================

function distributedBody(over: Record<string, unknown> = {}) {
  return {
    name: 'Prod',
    deploymentType: 'distributed',
    hosting_type: 'AWS',
    region: 'us-east-1',
    cloudProviderId: 'cp-1',
    tiers: [
      { key: 'frontend', count: 3 },
      { key: 'datastore', count: 2 },
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
    tiers: [{ key: 'frontend', count: 1 }, { key: 'datastore', count: 1 }],
  })
  assert.equal(data.controlPlaneLayout, 'dedicated')
})

// --- generic tiers shape -----------------------------------------------------

test('readByol emits nodeTiers in [frontend, datastore] order from the tiers array', () => {
  const { data, error } = readByol(distributedBody())
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; count: number }>
  assert.equal(tiers[0].key, 'frontend')
  assert.equal(tiers[0].count, 3)
  assert.equal(tiers[1].key, 'datastore')
  assert.equal(tiers[1].count, 2)
})

test('readByol falls back to the tier minimum when a tier is omitted from the array', () => {
  const { data, error } = readByol(distributedBody({ tiers: [{ key: 'frontend', count: 4 }] }))
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; count: number; placement: unknown }>
  assert.deepEqual(tiers[0], { key: 'frontend', count: 4, placement: null })
  assert.deepEqual(tiers[1], { key: 'datastore', count: 1, placement: null })
})

// --- distributed guardrails (per-tier minimums) ------------------------------

test('readByol requires at least 1 Frontend nodes', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'frontend', count: 0 }, { key: 'datastore', count: 2 }] }))
  assert.match(error ?? '', /Frontend nodes must be at least 1/)
})

test('readByol requires at least 1 Datastore nodes (MinIO)', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'frontend', count: 3 }, { key: 'datastore', count: 0 }] }))
  assert.match(error ?? '', /Datastore nodes \(MinIO\) must be at least 1/)
})

test('readByol accepts the minimums exactly (1 frontend / 1 datastore)', () => {
  const { error } = readByol(distributedBody({ tiers: [{ key: 'frontend', count: 1 }, { key: 'datastore', count: 1 }] }))
  assert.equal(error, undefined)
})

// --- control plane -----------------------------------------------------------

test('readByol normalizes the control-plane layout and keeps a valid one', () => {
  assert.equal(readByol(distributedBody({ controlPlaneLayout: 'consolidated' })).data.controlPlaneLayout, 'consolidated')
  assert.equal(readByol(distributedBody({ controlPlaneLayout: 'bogus' })).data.controlPlaneLayout, 'dedicated')
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

test('readByol accepts a valid multi-site placement on the frontend tier', () => {
  const { data, error } = readByol(
    distributedBody({
      tiers: [
        {
          key: 'frontend',
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
        { key: 'datastore', count: 2 },
      ],
    }),
  )
  assert.equal(error, undefined)
  const tiers = data.nodeTiers as Array<{ key: string; placement: any }>
  assert.equal(tiers[0].placement.mode, 'multi-site')
})

test('readByol rejects placement whose percentages do not total 100, naming the tier', () => {
  const { error } = readByol(
    distributedBody({
      tiers: [
        {
          key: 'frontend',
          count: 4,
          placement: {
            mode: 'multi-site',
            sites: [
              { site: 'us-east-1a', percent: 60 },
              { site: 'us-east-1b', percent: 30 },
            ],
          },
        },
        { key: 'datastore', count: 2 },
      ],
    }),
  )
  assert.match(error ?? '', /Frontend nodes placement: .*total 100/)
})

test('readByol rejects more sites than nodes on the datastore tier', () => {
  const { error } = readByol(
    distributedBody({
      tiers: [
        { key: 'frontend', count: 4 },
        {
          key: 'datastore',
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
  assert.match(error ?? '', /Datastore nodes \(MinIO\) placement: .*Too many sites/)
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
    distributedBody({ tiers: [{ key: 'frontend', count: 4, placement: regionPlacement }, { key: 'datastore', count: 2 }] }),
  )
  assert.match(error ?? '', /multi-region placement requires a dedicated cloud fabric/)
})

test('readByol allows region-granularity placement in a dedicated (BYOC) deployment', () => {
  const { error } = readByol(
    distributedBody({
      networkMode: 'dedicated',
      cloudAccountConnectionId: 'acct-1',
      tiers: [{ key: 'frontend', count: 4, placement: regionPlacement }, { key: 'datastore', count: 2 }],
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
        key: 'frontend',
        count: 1,
        placement: { mode: 'multi-site', sites: [{ site: 'a', percent: 50 }, { site: 'b', percent: 50 }] },
      },
      { key: 'datastore', count: 1 },
    ],
  })
  const tiers = data.nodeTiers as Array<{ key: string; placement: unknown }>
  assert.equal(tiers[0].placement, null)
})

// --- BYOC target -------------------------------------------------------------

test('readByol requires a cloud account for a BYOC (dedicated) deployment', () => {
  const { error } = readByol(distributedBody({ networkMode: 'dedicated' }))
  assert.match(error ?? '', /A cloud account is required/)
})
