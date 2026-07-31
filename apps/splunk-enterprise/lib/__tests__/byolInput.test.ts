import { readByol } from '../byolInput'

// =============================================================================
// BYOL request validation — scalar coercion, distributed guardrails, and the
// topology-authoring fields (control-plane layout, heavy forwarders, placement).
// =============================================================================

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

describe('readByol — required + basic coercion', () => {
  it('rejects a missing name', () => {
    expect(readByol({}).error).toMatch(/Name is required/)
  })

  it('defaults single-instance topology fields', () => {
    const { data } = readByol({ name: 'Dev', deploymentType: 'single', indexerCount: 1, searchHeadCount: 1 })
    expect(data.controlPlaneLayout).toBe('dedicated')
    expect(data.heavyForwarderCount).toBe(1)
    expect(data.indexerPlacement).toBeNull()
    expect(data.searchHeadPlacement).toBeNull()
  })
})

describe('readByol — distributed guardrails', () => {
  it('requires at least 3 indexers / 2 search heads', () => {
    expect(readByol(distributedBody({ indexerCount: 2 })).error).toMatch(/at least 3 indexers/)
    expect(readByol(distributedBody({ searchHeadCount: 1 })).error).toMatch(/at least 2 search heads/)
  })
})

// =============================================================================
// Generic `tiers: [{ key, count, placement }]` array — the SDK's
// ByolInfrastructureManager now sends this instead of the old fixed
// indexerCount/searchHeadCount pair. Splunk's two tiers: 'indexer' and
// 'searchHead'. A legacy client (no `tiers` field) still works via the
// top-level indexerCount/searchHeadCount/indexerPlacement/searchHeadPlacement
// fields, matching every test above this block.
// =============================================================================

const tiersOf = (
  indexerCount: number,
  searchHeadCount: number,
  placements: Record<string, unknown> = {},
) => [
  { key: 'indexer', count: indexerCount, placement: placements.indexer ?? null },
  { key: 'searchHead', count: searchHeadCount, placement: placements.searchHead ?? null },
]

describe('readByol — legacy body (no tiers array)', () => {
  it('reads indexerCount/searchHeadCount straight off the body', () => {
    const { data } = readByol(distributedBody({ indexerCount: 5, searchHeadCount: 3 }))
    expect(data.indexerCount).toBe(5)
    expect(data.searchHeadCount).toBe(3)
  })

  it('still populates an ordered nodeTiers snapshot for a legacy caller', () => {
    const { data } = readByol(distributedBody({ indexerCount: 5, searchHeadCount: 3 }))
    expect(data.nodeTiers).toEqual([
      { key: 'indexer', count: 5, placement: null },
      { key: 'searchHead', count: 3, placement: null },
    ])
  })
})

describe('readByol — generic tiers array', () => {
  it('reads counts from tiers[], overriding any stray legacy fields', () => {
    const { data } = readByol(
      distributedBody({ indexerCount: 999, searchHeadCount: 999, tiers: tiersOf(4, 2) }),
    )
    expect(data.indexerCount).toBe(4)
    expect(data.searchHeadCount).toBe(2)
  })

  it('builds nodeTiers in [indexer, searchHead] order from the tiers array', () => {
    const { data } = readByol(distributedBody({ tiers: tiersOf(6, 3) }))
    expect(data.nodeTiers).toEqual([
      { key: 'indexer', count: 6, placement: null },
      { key: 'searchHead', count: 3, placement: null },
    ])
  })

  it('ignores unknown tier keys and defaults indexer/searchHead to 1 (no legacy fallback once tiers is present)', () => {
    // `tiers` is present (even with no 'indexer'/'searchHead' entries), so the
    // legacy indexerCount/searchHeadCount = 4/2 on the body are NOT consulted —
    // both tiers default to 1, tripping the distributed minimum.
    const { error } = readByol(
      distributedBody({ indexerCount: 4, searchHeadCount: 2, tiers: [{ key: 'bogus-tier', count: 99, placement: null }] }),
    )
    expect(error).toMatch(/at least 3 indexers/)
  })

  it('requires at least 3 indexers / 2 search heads via the tiers array', () => {
    expect(readByol(distributedBody({ tiers: tiersOf(2, 2) })).error).toMatch(/at least 3 indexers/)
    expect(readByol(distributedBody({ tiers: tiersOf(3, 1) })).error).toMatch(/at least 2 search heads/)
  })

  it('parses placement out of the matching tier entry', () => {
    const multiSite = {
      mode: 'multi-site',
      granularity: 'az',
      sites: [
        { site: 'us-east-1a', percent: 50 },
        { site: 'us-east-1b', percent: 50 },
      ],
    }
    const { data, error } = readByol(distributedBody({ tiers: tiersOf(4, 2, { indexer: multiSite }) }))
    expect(error).toBeUndefined()
    expect((data.indexerPlacement as any).mode).toBe('multi-site')
    expect(data.nodeTiers).toEqual([
      { key: 'indexer', count: 4, placement: multiSite },
      { key: 'searchHead', count: 2, placement: null },
    ])
  })

  it('reports a placement error using the existing tier label, sourced from the tiers array', () => {
    const badPlacement = {
      mode: 'multi-site',
      sites: [
        { site: 'a', percent: 60 },
        { site: 'b', percent: 20 },
      ],
    }
    const { error } = readByol(distributedBody({ tiers: tiersOf(4, 2, { searchHead: badPlacement }) }))
    expect(error).toMatch(/Search head placement: .*total 100/)
  })
})

describe('readByol — control plane + forwarders', () => {
  it('normalizes the control-plane layout and keeps a valid one', () => {
    expect(readByol(distributedBody({ controlPlaneLayout: 'consolidated' })).data.controlPlaneLayout).toBe('consolidated')
    expect(readByol(distributedBody({ controlPlaneLayout: 'bogus' })).data.controlPlaneLayout).toBe('dedicated')
  })

  it('clamps the heavy forwarder count to a minimum of one', () => {
    expect(readByol(distributedBody({ heavyForwarderCount: 3 })).data.heavyForwarderCount).toBe(3)
    expect(readByol(distributedBody({ heavyForwarderCount: 0 })).data.heavyForwarderCount).toBe(1)
  })
})

describe('readByol — instance type', () => {
  it('trims a provided instance type', () => {
    expect(readByol(distributedBody({ instanceType: '  t2.large ' })).data.instanceType).toBe('t2.large')
  })

  it('coerces an empty/absent instance type to null (cloud default)', () => {
    expect(readByol(distributedBody({ instanceType: '   ' })).data.instanceType).toBeNull()
    expect(readByol(distributedBody()).data.instanceType).toBeNull()
  })
})

describe('readByol — version selection', () => {
  it('trims a provided versionId', () => {
    expect(readByol(distributedBody({ versionId: '  v-10-4  ' })).data.versionId).toBe('v-10-4')
  })

  it('coerces an empty/absent versionId to null (no version selected)', () => {
    expect(readByol(distributedBody({ versionId: '   ' })).data.versionId).toBeNull()
    expect(readByol(distributedBody()).data.versionId).toBeNull()
  })
})

describe('readByol — placement', () => {
  it('accepts a valid multi-site indexer placement', () => {
    const { data, error } = readByol(
      distributedBody({
        indexerCount: 4,
        indexerPlacement: { mode: 'multi-site', granularity: 'az', sites: [
          { site: 'us-east-1a', percent: 50 },
          { site: 'us-east-1b', percent: 50 },
        ] },
      }),
    )
    expect(error).toBeUndefined()
    expect((data.indexerPlacement as any).mode).toBe('multi-site')
  })

  it('rejects placement whose percentages do not total 100', () => {
    const { error } = readByol(
      distributedBody({
        indexerPlacement: { mode: 'multi-site', sites: [
          { site: 'us-east-1a', percent: 60 },
          { site: 'us-east-1b', percent: 30 },
        ] },
      }),
    )
    expect(error).toMatch(/Indexer placement: .*total 100/)
  })

  it('rejects more sites than nodes', () => {
    const { error } = readByol(
      distributedBody({
        searchHeadCount: 2,
        searchHeadPlacement: { mode: 'multi-site', sites: [
          { site: 'us-east-1a', percent: 34 },
          { site: 'us-east-1b', percent: 33 },
          { site: 'us-east-1c', percent: 33 },
        ] },
      }),
    )
    expect(error).toMatch(/Search head placement: .*Too many sites/)
  })

  const regionPlacement = { mode: 'multi-site', granularity: 'region', sites: [
    { site: 'us-east-1', percent: 50 },
    { site: 'us-west-2', percent: 50 },
  ] } as const

  it('rejects region-granularity placement unless the network is dedicated (BYOC)', () => {
    const { error } = readByol(distributedBody({ indexerPlacement: regionPlacement }))
    expect(error).toMatch(/multi-region placement requires a dedicated cloud fabric/)
  })

  it('allows region-granularity placement in a dedicated (BYOC) deployment', () => {
    const { error } = readByol(
      distributedBody({
        networkMode: 'dedicated',
        cloudAccountConnectionId: 'acct-1',
        indexerPlacement: regionPlacement,
      }),
    )
    expect(error).toBeUndefined()
  })

  it('allows availability-zone placement', () => {
    const { error } = readByol(
      distributedBody({
        indexerCount: 4,
        indexerPlacement: { mode: 'multi-site', granularity: 'az', sites: [
          { site: 'us-east-1a', percent: 50 },
          { site: 'us-east-1b', percent: 50 },
        ] },
      }),
    )
    expect(error).toBeUndefined()
  })

  it('drops placement entirely for a single-instance deployment', () => {
    const { data } = readByol({
      name: 'Dev',
      deploymentType: 'single',
      indexerCount: 1,
      searchHeadCount: 1,
      indexerPlacement: { mode: 'multi-site', sites: [{ site: 'a', percent: 50 }, { site: 'b', percent: 50 }] },
    })
    expect(data.indexerPlacement).toBeNull()
  })
})
