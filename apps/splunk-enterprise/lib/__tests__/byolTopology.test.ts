import { buildByolResourcePlan, TIER_ORDER } from '../byolTopology'

// =============================================================================
// App-owned topology builder — mirror of the SDK's `byol/topology.ts`. Pins the
// copy to the same contract: consolidation layouts, multi-site placement (indexer
// / search only), configurable heavy forwarders. Keep in sync with the SDK test.
// =============================================================================

const distributed = (overrides = {}) =>
  buildByolResourcePlan({
    deploymentType: 'distributed',
    indexerCount: 3,
    searchHeadCount: 2,
    hostingType: 'AWS',
    isCloud: true,
    region: 'us-east-1',
    ...overrides,
  })

const controlPlane = (plan: ReturnType<typeof buildByolResourcePlan>) =>
  plan.filter((p) => p.tier === 'control-plane')

describe('buildByolResourcePlan (app copy) — baseline', () => {
  it('provisions the full dedicated control plane by default', () => {
    const cp = controlPlane(distributed())
    expect(cp).toHaveLength(5)
    expect(cp.every((p) => p.roles?.length === 1)).toBe(true)
  })

  it('creates one resource per indexer and search head', () => {
    const plan = distributed({ indexerCount: 6, searchHeadCount: 3 })
    expect(plan.filter((p) => p.kind === 'indexer')).toHaveLength(6)
    expect(plan.filter((p) => p.kind === 'search-head')).toHaveLength(3)
  })

  it('assigns unique plan keys and groups every item into a known tier', () => {
    const plan = distributed()
    const keys = plan.map((p) => p.planKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const item of plan) expect(TIER_ORDER).toContain(item.tier)
  })
})

describe('buildByolResourcePlan (app copy) — control-plane consolidation', () => {
  it('consolidated keeps CM + SH-deployer isolated and combines the rest', () => {
    const cp = controlPlane(distributed({ controlPlaneLayout: 'consolidated' }))
    expect(cp).toHaveLength(3)
    expect(cp.find((p) => p.kind === 'management-node')?.roles).toEqual([
      'license-manager',
      'deployment-server',
      'monitoring-console',
    ])
  })

  it('single collapses every role onto one management node', () => {
    const cp = controlPlane(distributed({ controlPlaneLayout: 'single' }))
    expect(cp).toHaveLength(1)
    expect(cp[0].kind).toBe('management-node')
    expect(cp[0].roles).toHaveLength(5)
  })
})

describe('buildByolResourcePlan (app copy) — heavy forwarders', () => {
  const hf = (plan: ReturnType<typeof buildByolResourcePlan>) => plan.filter((p) => p.kind === 'heavy-forwarder')

  it('defaults to a single heavy forwarder', () => {
    expect(hf(distributed())).toHaveLength(1)
  })

  it('emits the requested number, all in the main region', () => {
    const forwarders = hf(distributed({ heavyForwarderCount: 3 }))
    expect(forwarders).toHaveLength(3)
    expect(forwarders.every((p) => p.region === 'us-east-1')).toBe(true)
  })
})

describe('buildByolResourcePlan (app copy) — multi-site placement', () => {
  const indexers = (plan: ReturnType<typeof buildByolResourcePlan>) => plan.filter((p) => p.kind === 'indexer')

  it('AZ granularity keeps the main region and varies the zone', () => {
    const idx = indexers(
      distributed({
        indexerCount: 4,
        indexerPlacement: { mode: 'multi-site', granularity: 'az', sites: [
          { site: 'us-east-1a', percent: 50 },
          { site: 'us-east-1b', percent: 50 },
        ] },
      }),
    )
    expect(idx.every((p) => p.region === 'us-east-1')).toBe(true)
    expect(idx.map((p) => p.zone).filter((z) => z === 'us-east-1a')).toHaveLength(2)
  })

  it('region granularity places nodes in the site region with no zone', () => {
    const idx = indexers(
      distributed({
        indexerCount: 4,
        indexerPlacement: { mode: 'multi-site', granularity: 'region', sites: [
          { site: 'us-east-1', percent: 75 },
          { site: 'us-west-2', percent: 25 },
        ] },
      }),
    )
    expect(idx.filter((p) => p.region === 'us-west-2')).toHaveLength(1)
    expect(idx.every((p) => p.zone == null)).toBe(true)
  })

  it('does not spread the search tier when only the indexer tier is placed', () => {
    const plan = distributed({
      indexerPlacement: { mode: 'multi-site', granularity: 'region', sites: [
        { site: 'us-east-1', percent: 50 },
        { site: 'us-west-2', percent: 50 },
      ] },
    })
    expect(plan.filter((p) => p.kind === 'search-head').every((p) => p.region === 'us-east-1')).toBe(true)
  })
})
