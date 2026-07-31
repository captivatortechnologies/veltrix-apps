import { readByol } from '../byolInput'

// =============================================================================
// BYOL request validation — scalar coercion, the generic `tiers` shape the
// SDK's <ByolInfrastructureManager> now sends (search/heavy), its fallback to
// the legacy indexerCount/searchHeadCount/*Placement fields, and the
// topology-authoring fields (control-plane layout, heavy forwarders, placement).
// =============================================================================

const distributedBody = (over: Record<string, unknown> = {}) => ({
  name: 'Prod',
  deploymentType: 'distributed',
  hosting_type: 'AWS',
  region: 'us-east-1',
  cloudProviderId: 'cp-1',
  tiers: [
    { key: 'search', count: 4 },
    { key: 'heavy', count: 2 },
  ],
  ...over,
})

describe('readByol — required + basic coercion', () => {
  it('rejects a missing name', () => {
    expect(readByol({}).error).toMatch(/Name is required/)
  })

  it('defaults single-instance topology fields', () => {
    const { data } = readByol({
      name: 'Dev',
      deploymentType: 'single',
      tiers: [{ key: 'search', count: 1 }, { key: 'heavy', count: 1 }],
    })
    expect(data.controlPlaneLayout).toBe('dedicated')
    expect(data.heavyForwarderCount).toBe(1)
    expect(data.indexerPlacement).toBeNull()
    expect(data.searchHeadPlacement).toBeNull()
  })
})

describe('readByol — generic tiers shape', () => {
  it('reads indexerCount/searchHeadCount from the tiers array', () => {
    const { data, error } = readByol(distributedBody())
    expect(error).toBeUndefined()
    expect(data.indexerCount).toBe(4)
    expect(data.searchHeadCount).toBe(2)
  })

  it('exposes nodeTiers in [search, heavy] order regardless of input shape', () => {
    const { data } = readByol(distributedBody())
    const tiers = data.nodeTiers as Array<{ key: string; count: number }>
    expect(tiers[0].key).toBe('search')
    expect(tiers[0].count).toBe(4)
    expect(tiers[1].key).toBe('heavy')
    expect(tiers[1].count).toBe(2)
  })

  it('falls back to the legacy scalar fields when tiers is absent', () => {
    const { data, error } = readByol({
      name: 'Prod',
      deploymentType: 'distributed',
      hosting_type: 'AWS',
      region: 'us-east-1',
      cloudProviderId: 'cp-1',
      indexerCount: 5,
      searchHeadCount: 3,
    })
    expect(error).toBeUndefined()
    expect(data.indexerCount).toBe(5)
    expect(data.searchHeadCount).toBe(3)
    const tiers = data.nodeTiers as Array<{ key: string; count: number }>
    expect(tiers[0]).toEqual({ key: 'search', count: 5, placement: null })
    expect(tiers[1]).toEqual({ key: 'heavy', count: 3, placement: null })
  })

  it('falls back per-tier when the tiers array only partially overrides the legacy fields', () => {
    const { data } = readByol(
      distributedBody({
        tiers: [{ key: 'search', count: 6 }],
        searchHeadCount: 3,
      }),
    )
    expect(data.indexerCount).toBe(6)
    expect(data.searchHeadCount).toBe(3)
  })
})

describe('readByol — distributed guardrails (per-tier minimums)', () => {
  it('requires at least 2 Search nodes', () => {
    const { error } = readByol(distributedBody({ tiers: [{ key: 'search', count: 1 }, { key: 'heavy', count: 2 }] }))
    expect(error).toMatch(/at least 2 Search nodes/)
  })

  it('requires at least 1 Heavy node (caught by the absolute floor, same value as the distributed minimum)', () => {
    const { error } = readByol(distributedBody({ tiers: [{ key: 'search', count: 4 }, { key: 'heavy', count: 0 }] }))
    expect(error).toMatch(/Heavy nodes must be at least 1/)
  })

  it('accepts the minimums exactly (2 search / 1 heavy)', () => {
    const { error } = readByol(distributedBody({ tiers: [{ key: 'search', count: 2 }, { key: 'heavy', count: 1 }] }))
    expect(error).toBeUndefined()
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

describe('readByol — placement (via tiers)', () => {
  it('accepts a valid multi-site placement on the search tier', () => {
    const { data, error } = readByol(
      distributedBody({
        tiers: [
          {
            key: 'search',
            count: 4,
            placement: { mode: 'multi-site', granularity: 'az', sites: [
              { site: 'us-east-1a', percent: 50 },
              { site: 'us-east-1b', percent: 50 },
            ] },
          },
          { key: 'heavy', count: 2 },
        ],
      }),
    )
    expect(error).toBeUndefined()
    expect((data.indexerPlacement as any).mode).toBe('multi-site')
  })

  it('rejects placement whose percentages do not total 100, naming the tier', () => {
    const { error } = readByol(
      distributedBody({
        tiers: [
          {
            key: 'search',
            count: 4,
            placement: { mode: 'multi-site', sites: [
              { site: 'us-east-1a', percent: 60 },
              { site: 'us-east-1b', percent: 30 },
            ] },
          },
          { key: 'heavy', count: 2 },
        ],
      }),
    )
    expect(error).toMatch(/Search nodes placement: .*total 100/)
  })

  it('rejects more sites than nodes on the heavy tier', () => {
    const { error } = readByol(
      distributedBody({
        tiers: [
          { key: 'search', count: 4 },
          {
            key: 'heavy',
            count: 2,
            placement: { mode: 'multi-site', sites: [
              { site: 'us-east-1a', percent: 34 },
              { site: 'us-east-1b', percent: 33 },
              { site: 'us-east-1c', percent: 33 },
            ] },
          },
        ],
      }),
    )
    expect(error).toMatch(/Heavy nodes placement: .*Too many sites/)
  })

  const regionPlacement = { mode: 'multi-site', granularity: 'region', sites: [
    { site: 'us-east-1', percent: 50 },
    { site: 'us-west-2', percent: 50 },
  ] } as const

  it('rejects region-granularity placement unless the network is dedicated (BYOC)', () => {
    const { error } = readByol(
      distributedBody({ tiers: [{ key: 'search', count: 4, placement: regionPlacement }, { key: 'heavy', count: 2 }] }),
    )
    expect(error).toMatch(/multi-region placement requires a dedicated cloud fabric/)
  })

  it('allows region-granularity placement in a dedicated (BYOC) deployment', () => {
    const { error } = readByol(
      distributedBody({
        networkMode: 'dedicated',
        cloudAccountConnectionId: 'acct-1',
        tiers: [{ key: 'search', count: 4, placement: regionPlacement }, { key: 'heavy', count: 2 }],
      }),
    )
    expect(error).toBeUndefined()
  })

  it('drops placement entirely for a single-instance deployment', () => {
    const { data } = readByol({
      name: 'Dev',
      deploymentType: 'single',
      tiers: [
        { key: 'search', count: 1, placement: { mode: 'multi-site', sites: [{ site: 'a', percent: 50 }, { site: 'b', percent: 50 }] } },
        { key: 'heavy', count: 1 },
      ],
    })
    expect(data.indexerPlacement).toBeNull()
  })
})
