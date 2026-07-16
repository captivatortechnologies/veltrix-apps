import { diffPlan, buildByolPlan, planHasChanges } from '../byolPlanDiff'
import type { PlanDiffCurrent, PlanDiffDesired } from '../byolPlanDiff'

// =============================================================================
// Plan diff (app copy) — the non-mutating mirror of seedResources' delete-not-
// in-plan + upsert arithmetic that powers GET /byol/:id/plan. Kept in sync with
// the SDK copy (sdk/src/byol/diffPlan.ts); this pins the same classification so
// Plan and Apply agree.
// =============================================================================

const desiredItem = (over: Partial<PlanDiffDesired> & { planKey: string }): PlanDiffDesired => ({
  tier: 'foundation',
  kind: 'network',
  name: 'Network',
  role: 'net',
  region: 'us-east-1',
  ...over,
})

const currentRow = (over: Partial<PlanDiffCurrent> & { planKey: string }): PlanDiffCurrent => ({
  tier: 'foundation',
  kind: 'network',
  name: 'Network',
  role: 'net',
  region: 'us-east-1',
  status: 'ready',
  ...over,
})

describe('diffPlan (app copy)', () => {
  it('adds a desired key with no current row', () => {
    const diff = diffPlan([], [desiredItem({ planKey: 'foundation/network' })])
    expect(diff.add).toHaveLength(1)
    expect(diff.add[0].planKey).toBe('foundation/network')
    expect(diff.destroy).toHaveLength(0)
  })

  it('treats an identical row as noop and a differing row as change', () => {
    const key = 'data/indexer-1'
    const base = { planKey: key, tier: 'data', kind: 'indexer', name: 'Indexer peer 1' }
    const same = diffPlan([currentRow({ ...base })], [desiredItem({ ...base })])
    expect(same.noop).toHaveLength(1)

    const moved = diffPlan(
      [currentRow({ ...base, region: 'us-east-1' })],
      [desiredItem({ ...base, region: 'eu-west-1' })],
    )
    expect(moved.change).toHaveLength(1)
  })

  it('re-plans failed/attention rows and destroys rows dropped from the plan', () => {
    const failed = diffPlan(
      [currentRow({ planKey: 'foundation/network', status: 'failed' })],
      [desiredItem({ planKey: 'foundation/network' })],
    )
    expect(failed.change).toHaveLength(1)

    const dropped = diffPlan(
      [currentRow({ planKey: 'ingest/heavy-forwarder-2', tier: 'ingest', kind: 'heavy-forwarder', name: 'HF2' })],
      [desiredItem({ planKey: 'foundation/network' })],
    )
    expect(dropped.destroy).toHaveLength(1)
    expect(dropped.destroy[0].planKey).toBe('ingest/heavy-forwarder-2')
  })
})

describe('buildByolPlan (app copy)', () => {
  const desired: PlanDiffDesired[] = [
    desiredItem({ planKey: 'foundation/network', tier: 'foundation', sortOrder: 0 }),
    desiredItem({ planKey: 'control-plane/cluster-manager', tier: 'control-plane', kind: 'cluster-manager', name: 'Cluster Manager', sortOrder: 1 }),
    desiredItem({ planKey: 'data/indexer-1', tier: 'data', kind: 'indexer', name: 'Indexer peer 1', sortOrder: 2 }),
  ]

  it('summarises action counts and groups tiers in provisioning order', () => {
    const current: PlanDiffCurrent[] = [
      currentRow({ planKey: 'foundation/network', tier: 'foundation' }),
      currentRow({ planKey: 'data/indexer-1', tier: 'data', kind: 'indexer', name: 'Indexer peer 1', region: 'eu-west-1' }),
      currentRow({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector' }),
    ]
    const plan = buildByolPlan(current, desired)
    expect(plan.summary).toEqual({ add: 1, change: 1, destroy: 1, noop: 1 })
    // foundation before control-plane before data before the dropped ingest row
    expect(plan.groups.map((g) => g.tier)).toEqual(['foundation', 'control-plane', 'data', 'ingest'])
  })

  it('planHasChanges is false only for a pure no-op plan', () => {
    const current: PlanDiffCurrent[] = desired.map((d) => currentRow({ ...d, status: 'ready' }))
    expect(planHasChanges(buildByolPlan(current, desired).summary)).toBeFalsy()
    expect(planHasChanges(buildByolPlan([], desired).summary)).toBeTruthy()
  })
})
