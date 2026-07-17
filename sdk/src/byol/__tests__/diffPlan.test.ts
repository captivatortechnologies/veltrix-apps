import { describe, it, expect } from 'vitest'
import { diffPlan, buildByolPlan, planHasChanges } from '../diffPlan'
import type { PlanDiffCurrent, PlanDiffDesired } from '../diffPlan'

// A desired topology item (what buildByolResourcePlan emits, minimally).
const desiredItem = (over: Partial<PlanDiffDesired> & { planKey: string }): PlanDiffDesired => ({
  tier: 'foundation',
  kind: 'network',
  name: 'Network',
  role: 'net',
  region: 'us-east-1',
  ...over,
})

// A persisted resource row (what listResources returns, minimally).
const currentRow = (over: Partial<PlanDiffCurrent> & { planKey: string }): PlanDiffCurrent => ({
  tier: 'foundation',
  kind: 'network',
  name: 'Network',
  role: 'net',
  region: 'us-east-1',
  status: 'ready',
  ...over,
})

describe('diffPlan', () => {
  it('classifies a brand-new desired item as add', () => {
    const diff = diffPlan([], [desiredItem({ planKey: 'foundation/network' })])
    expect(diff.add).toHaveLength(1)
    expect(diff.change).toHaveLength(0)
    expect(diff.destroy).toHaveLength(0)
    expect(diff.noop).toHaveLength(0)
    expect(diff.add[0].planKey).toBe('foundation/network')
  })

  it('classifies an identical row as noop', () => {
    const key = 'foundation/network'
    const diff = diffPlan([currentRow({ planKey: key })], [desiredItem({ planKey: key })])
    expect(diff.noop).toHaveLength(1)
    expect(diff.add).toHaveLength(0)
    expect(diff.change).toHaveLength(0)
  })

  it('classifies a row whose fields differ as change', () => {
    const key = 'data/indexer-1'
    const current = [currentRow({ planKey: key, kind: 'indexer', name: 'Indexer peer 1', region: 'us-east-1' })]
    const desired = [desiredItem({ planKey: key, kind: 'indexer', name: 'Indexer peer 1', region: 'eu-west-1' })]
    const diff = diffPlan(current, desired)
    expect(diff.change).toHaveLength(1)
    expect(diff.change[0].region).toBe('eu-west-1')
    expect(diff.noop).toHaveLength(0)
  })

  it('re-plans a failed/attention row even when its fields still match', () => {
    const key = 'foundation/network'
    for (const status of ['failed', 'attention']) {
      const diff = diffPlan([currentRow({ planKey: key, status })], [desiredItem({ planKey: key })])
      expect(diff.change).toHaveLength(1)
      expect(diff.noop).toHaveLength(0)
    }
  })

  it('classifies a current row absent from the plan as destroy', () => {
    const diff = diffPlan(
      [currentRow({ planKey: 'ingest/heavy-forwarder-2', kind: 'heavy-forwarder', name: 'Heavy Forwarder 2' })],
      [desiredItem({ planKey: 'foundation/network' })],
    )
    expect(diff.destroy).toHaveLength(1)
    expect(diff.destroy[0].planKey).toBe('ingest/heavy-forwarder-2')
    expect(diff.add).toHaveLength(1)
  })

  it('treats null vs undefined role/region as equal (no spurious change)', () => {
    const key = 'foundation/tls'
    const diff = diffPlan(
      [currentRow({ planKey: key, region: null, role: null, status: 'ready' })],
      [desiredItem({ planKey: key, region: null, role: null })],
    )
    expect(diff.noop).toHaveLength(1)
    expect(diff.change).toHaveLength(0)
  })

  it('does not mutate its inputs', () => {
    const current = [currentRow({ planKey: 'a' })]
    const desired = [desiredItem({ planKey: 'a' })]
    const snapCurrent = JSON.stringify(current)
    const snapDesired = JSON.stringify(desired)
    diffPlan(current, desired)
    expect(JSON.stringify(current)).toBe(snapCurrent)
    expect(JSON.stringify(desired)).toBe(snapDesired)
  })
})

describe('buildByolPlan', () => {
  const desired: PlanDiffDesired[] = [
    desiredItem({ planKey: 'foundation/network', tier: 'foundation', sortOrder: 0 }),
    desiredItem({ planKey: 'control-plane/cluster-manager', tier: 'control-plane', kind: 'cluster-manager', name: 'Cluster Manager', sortOrder: 1 }),
    desiredItem({ planKey: 'data/indexer-1', tier: 'data', kind: 'indexer', name: 'Indexer peer 1', sortOrder: 2 }),
  ]

  it('summarises the four action counts', () => {
    // network exists identically (noop), cluster-manager is new (add),
    // indexer-1 differs (change), and an old row is destroyed.
    const current: PlanDiffCurrent[] = [
      currentRow({ planKey: 'foundation/network', tier: 'foundation' }),
      currentRow({ planKey: 'data/indexer-1', tier: 'data', kind: 'indexer', name: 'Indexer peer 1', region: 'eu-west-1' }),
      currentRow({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector' }),
    ]
    const plan = buildByolPlan(current, desired)
    expect(plan.summary).toEqual({ add: 1, change: 1, destroy: 1, noop: 1 })
  })

  it('groups items by tier in provisioning order and tags each action', () => {
    const plan = buildByolPlan([], desired)
    expect(plan.groups.map((g) => g.tier)).toEqual(['foundation', 'control-plane', 'data'])
    const actions = plan.groups.flatMap((g) => g.items.map((i) => i.action))
    expect(actions).toEqual(['add', 'add', 'add'])
  })

  it('places destroyed rows into their tier group', () => {
    const current: PlanDiffCurrent[] = [
      currentRow({ planKey: 'data/indexer-9', tier: 'data', kind: 'indexer', name: 'Indexer peer 9' }),
    ]
    const plan = buildByolPlan(current, desired)
    const dataGroup = plan.groups.find((g) => g.tier === 'data')
    expect(dataGroup).toBeDefined()
    const destroyed = dataGroup!.items.find((i) => i.action === 'destroy')
    expect(destroyed?.planKey).toBe('data/indexer-9')
  })

  it('planHasChanges is false only for a pure no-op plan', () => {
    const current: PlanDiffCurrent[] = desired.map((d) => currentRow({ ...d, status: 'ready' }))
    const noopPlan = buildByolPlan(current, desired)
    expect(noopPlan.summary).toEqual({ add: 0, change: 0, destroy: 0, noop: 3 })
    expect(planHasChanges(noopPlan.summary)).toBe(false)
    expect(planHasChanges(buildByolPlan([], desired).summary)).toBe(true)
  })
})
