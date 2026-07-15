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
