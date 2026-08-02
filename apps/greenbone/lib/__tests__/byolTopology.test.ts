import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildByolResourcePlan, tierCount, TIER_ORDER } from '../byolTopology'

// =============================================================================
// The node_tiers-native resource plan: tier counts are read BY KEY from the
// generic `tiers` array, the two scalable tiers (manager / scanner) expand to N
// nodes each, and the fixed supporting services (PostgreSQL, Redis) are added
// once per distributed stack.
// =============================================================================

function kinds(plan: ReturnType<typeof buildByolResourcePlan>) {
  return plan.map((p) => p.kind)
}

test('tierCount reads a tier count by key and clamps to a minimum of 1', () => {
  const tiers = [{ key: 'manager', count: 3 }, { key: 'scanner', count: 0 }]
  assert.equal(tierCount(tiers, 'manager'), 3)
  assert.equal(tierCount(tiers, 'scanner'), 1) // clamped
  assert.equal(tierCount(tiers, 'missing'), 1) // absent → default 1
  assert.equal(tierCount(undefined, 'manager'), 1)
})

test('a single-instance deployment is the foundation plus one all-in-one node', () => {
  const plan = buildByolResourcePlan({ deploymentType: 'single', region: 'us-east-1' })
  const k = kinds(plan)
  assert.deepEqual(k, ['network', 'tls', 'secrets', 'standalone'])
  const standalone = plan.find((p) => p.kind === 'standalone')!
  assert.deepEqual(standalone.roles, ['gvmd', 'gsa', 'scanner', 'postgres', 'redis'])
})

test('a distributed cloud stack expands every tier and adds the fixed services once', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: true,
    region: 'us-east-1',
    tiers: [
      { key: 'manager', count: 2 },
      { key: 'scanner', count: 3 },
    ],
  })
  const k = kinds(plan)
  // Foundation includes the load balancer + DNS for a distributed cloud stack.
  assert.ok(k.includes('load-balancer'))
  assert.ok(k.includes('dns'))
  // Scalable tiers expand to N nodes each.
  assert.equal(k.filter((x) => x === 'greenbone').length, 2)
  assert.equal(k.filter((x) => x === 'scanner').length, 3)
  // Fixed supporting services appear exactly once.
  assert.equal(k.filter((x) => x === 'postgres').length, 1)
  assert.equal(k.filter((x) => x === 'redis').length, 1)
})

test('a distributed self-hosted stack omits the cloud load balancer + DNS', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: false,
    tiers: [{ key: 'manager', count: 1 }, { key: 'scanner', count: 1 }],
  })
  const k = kinds(plan)
  assert.ok(!k.includes('load-balancer'))
  assert.ok(!k.includes('dns'))
  assert.ok(k.includes('greenbone'))
})

test('the manager tier carries gvmd/gsa roles and is an ALB target kind', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: true,
    tiers: [{ key: 'manager', count: 1 }, { key: 'scanner', count: 1 }],
  })
  const manager = plan.find((p) => p.kind === 'greenbone')!
  assert.deepEqual(manager.roles, ['gvmd', 'gsa'])
  assert.equal(manager.tier, 'app')
})

test('every plan item carries a tier in TIER_ORDER and a stable sortOrder', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: true,
    tiers: [{ key: 'manager', count: 1 }, { key: 'scanner', count: 1 }],
  })
  plan.forEach((item, i) => {
    assert.ok((TIER_ORDER as readonly string[]).includes(item.tier), `unknown tier ${item.tier}`)
    assert.equal(item.sortOrder, i)
  })
})
