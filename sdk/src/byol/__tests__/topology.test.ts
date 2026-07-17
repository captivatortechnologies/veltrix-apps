import { describe, it, expect } from 'vitest'
import { buildByolResourcePlan, TIER_ORDER } from '../topology'

describe('buildByolResourcePlan — single instance', () => {
  const plan = buildByolResourcePlan({ deploymentType: 'single', hostingType: 'Self-Hosted', region: 'local' })
  const kinds = plan.map((p) => p.kind)

  it('collapses to an all-in-one node plus foundation', () => {
    expect(kinds).toContain('standalone')
    expect(kinds).toContain('network')
    expect(kinds).toContain('license-file')
    expect(kinds).toContain('hec')
  })

  it('has no distributed control plane or indexer cluster', () => {
    expect(kinds).not.toContain('cluster-manager')
    expect(kinds).not.toContain('license-manager')
    expect(kinds).not.toContain('indexer')
    expect(kinds).not.toContain('search-head')
  })

  it('has no load balancer / DNS (not a distributed cloud)', () => {
    expect(kinds).not.toContain('load-balancer')
    expect(kinds).not.toContain('dns')
  })
})

describe('buildByolResourcePlan — distributed cloud', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    indexerCount: 6,
    searchHeadCount: 3,
    hostingType: 'AWS',
    isCloud: true,
    region: 'us-east-1',
    indexerRegions: ['us-east-1', 'eu-west-1'],
    searchHeadRegions: ['us-east-1'],
  })
  const kinds = plan.map((p) => p.kind)

  it('provisions the full control plane', () => {
    for (const k of ['license-manager', 'cluster-manager', 'sh-deployer', 'deployment-server', 'monitoring-console']) {
      expect(kinds).toContain(k)
    }
  })

  it('creates one resource per indexer and search head', () => {
    expect(kinds.filter((k) => k === 'indexer')).toHaveLength(6)
    expect(kinds.filter((k) => k === 'search-head')).toHaveLength(3)
  })

  it('includes load balancer + DNS for a distributed cloud deployment', () => {
    expect(kinds).toContain('load-balancer')
    expect(kinds).toContain('dns')
  })

  it('distributes indexer peers across the provided regions', () => {
    const indexerRegions = plan.filter((p) => p.kind === 'indexer').map((p) => p.region)
    expect(indexerRegions).toContain('us-east-1')
    expect(indexerRegions).toContain('eu-west-1')
  })

  it('assigns unique, stable plan keys and an increasing sort order', () => {
    const keys = plan.map((p) => p.planKey)
    expect(new Set(keys).size).toBe(keys.length)
    const orders = plan.map((p) => p.sortOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(orders[0]).toBe(0)
  })

  it('groups every resource into a known tier', () => {
    for (const item of plan) expect(TIER_ORDER).toContain(item.tier)
  })
})

describe('buildByolResourcePlan — distributed self-hosted', () => {
  it('omits cloud-only foundation (load balancer / DNS)', () => {
    const plan = buildByolResourcePlan({
      deploymentType: 'distributed',
      indexerCount: 3,
      searchHeadCount: 2,
      hostingType: 'Self-Hosted',
      isCloud: false,
    })
    const kinds = plan.map((p) => p.kind)
    expect(kinds).not.toContain('load-balancer')
    expect(kinds).not.toContain('dns')
    expect(kinds).toContain('cluster-manager')
  })
})

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

describe('buildByolResourcePlan — control-plane consolidation', () => {
  it('dedicated (default) yields five single-role instances', () => {
    const cp = controlPlane(distributed())
    expect(cp).toHaveLength(5)
    expect(cp.map((p) => p.kind).sort()).toEqual(
      ['cluster-manager', 'deployment-server', 'license-manager', 'monitoring-console', 'sh-deployer'].sort(),
    )
    expect(cp.every((p) => p.roles?.length === 1)).toBe(true)
  })

  it('consolidated keeps CM + SH-deployer isolated and combines the rest', () => {
    const cp = controlPlane(distributed({ controlPlaneLayout: 'consolidated' }))
    expect(cp).toHaveLength(3)
    const cm = cp.find((p) => p.kind === 'cluster-manager')
    const shd = cp.find((p) => p.kind === 'sh-deployer')
    const mgmt = cp.find((p) => p.kind === 'management-node')
    expect(cm?.roles).toEqual(['cluster-manager'])
    expect(shd?.roles).toEqual(['sh-deployer'])
    expect(mgmt?.roles).toEqual(['license-manager', 'deployment-server', 'monitoring-console'])
    // No standalone LM / DS / MC instances anymore.
    expect(cp.filter((p) => p.kind === 'license-manager')).toHaveLength(0)
  })

  it('single collapses every management role onto one node', () => {
    const cp = controlPlane(distributed({ controlPlaneLayout: 'single' }))
    expect(cp).toHaveLength(1)
    expect(cp[0].kind).toBe('management-node')
    expect(cp[0].roles).toEqual([
      'license-manager',
      'cluster-manager',
      'sh-deployer',
      'deployment-server',
      'monitoring-console',
    ])
  })

  it('control-plane instances stay in the main region regardless of placement', () => {
    const cp = controlPlane(
      distributed({
        controlPlaneLayout: 'consolidated',
        indexerPlacement: { mode: 'multi-site', granularity: 'region', sites: [
          { site: 'us-east-1', percent: 50 },
          { site: 'us-west-2', percent: 50 },
        ] },
      }),
    )
    expect(cp.every((p) => p.region === 'us-east-1')).toBe(true)
  })
})

describe('buildByolResourcePlan — heavy forwarders', () => {
  const hf = (plan: ReturnType<typeof buildByolResourcePlan>) => plan.filter((p) => p.kind === 'heavy-forwarder')

  it('defaults to a single heavy forwarder', () => {
    expect(hf(distributed())).toHaveLength(1)
  })

  it('emits the requested number of heavy forwarders, all in the main region', () => {
    const forwarders = hf(distributed({ heavyForwarderCount: 3, region: 'us-east-1' }))
    expect(forwarders).toHaveLength(3)
    expect(forwarders.every((p) => p.region === 'us-east-1')).toBe(true)
    expect(new Set(forwarders.map((p) => p.planKey)).size).toBe(3)
  })

  it('never drops below one forwarder', () => {
    expect(hf(distributed({ heavyForwarderCount: 0 }))).toHaveLength(1)
  })
})

describe('buildByolResourcePlan — multi-site placement', () => {
  const indexers = (plan: ReturnType<typeof buildByolResourcePlan>) => plan.filter((p) => p.kind === 'indexer')

  it('AZ granularity keeps the main region and varies the zone', () => {
    const plan = distributed({
      indexerCount: 4,
      region: 'us-east-1',
      indexerPlacement: { mode: 'multi-site', granularity: 'az', sites: [
        { site: 'us-east-1a', percent: 50 },
        { site: 'us-east-1b', percent: 50 },
      ] },
    })
    const idx = indexers(plan)
    expect(idx.every((p) => p.region === 'us-east-1')).toBe(true)
    const zones = idx.map((p) => p.zone)
    expect(zones.filter((z) => z === 'us-east-1a')).toHaveLength(2)
    expect(zones.filter((z) => z === 'us-east-1b')).toHaveLength(2)
  })

  it('region granularity places nodes in the site region with no zone', () => {
    const plan = distributed({
      indexerCount: 4,
      region: 'us-east-1',
      indexerPlacement: { mode: 'multi-site', granularity: 'region', sites: [
        { site: 'us-east-1', percent: 75 },
        { site: 'us-west-2', percent: 25 },
      ] },
    })
    const idx = indexers(plan)
    expect(idx.filter((p) => p.region === 'us-east-1')).toHaveLength(3)
    expect(idx.filter((p) => p.region === 'us-west-2')).toHaveLength(1)
    expect(idx.every((p) => p.zone == null)).toBe(true)
  })

  it('single-site placement leaves every node in the main region', () => {
    const plan = distributed({ indexerCount: 3, region: 'us-east-1', indexerPlacement: { mode: 'single' } })
    const idx = indexers(plan)
    expect(idx.every((p) => p.region === 'us-east-1' && p.zone == null)).toBe(true)
  })

  it('placement on the indexer tier does not affect the search tier', () => {
    const plan = distributed({
      indexerCount: 2,
      searchHeadCount: 2,
      region: 'us-east-1',
      indexerPlacement: { mode: 'multi-site', granularity: 'region', sites: [
        { site: 'us-east-1', percent: 50 },
        { site: 'us-west-2', percent: 50 },
      ] },
    })
    const searchHeads = plan.filter((p) => p.kind === 'search-head')
    expect(searchHeads.every((p) => p.region === 'us-east-1')).toBe(true)
  })
})
