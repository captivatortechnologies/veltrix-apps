import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildByolResourcePlan, tierCount, TIER_ORDER } from '../byolTopology'

// =============================================================================
// The node_tiers-native resource plan: tier counts are read BY KEY from the
// generic `tiers` array, the two scalable tiers (application / search) expand to
// N nodes each, and the fixed PostgreSQL is added once per stack (single and
// distributed alike).
// =============================================================================

function kinds(plan: ReturnType<typeof buildByolResourcePlan>) {
  return plan.map((p) => p.kind)
}

test('tierCount reads a tier count by key and clamps to a minimum of 1', () => {
  const tiers = [{ key: 'application', count: 3 }, { key: 'search', count: 0 }]
  assert.equal(tierCount(tiers, 'application'), 3)
  assert.equal(tierCount(tiers, 'search'), 1) // clamped
  assert.equal(tierCount(undefined, 'application'), 1)
})

test('a single-instance deployment is the foundation plus PostgreSQL and one all-in-one node', () => {
  const plan = buildByolResourcePlan({ deploymentType: 'single', region: 'us-east-1' })
  const k = kinds(plan)
  assert.deepEqual(k, ['network', 'tls', 'secrets', 'postgres', 'standalone'])
  const standalone = plan.find((p) => p.kind === 'standalone')!
  assert.deepEqual(standalone.roles, ['web', 'compute', 'search'])
})

test('a distributed cloud stack expands every tier and adds PostgreSQL once', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: true,
    region: 'us-east-1',
    tiers: [
      { key: 'application', count: 2 },
      { key: 'search', count: 3 },
    ],
  })
  const k = kinds(plan)
  // Foundation includes the load balancer + DNS for a distributed cloud stack.
  assert.ok(k.includes('load-balancer'))
  assert.ok(k.includes('dns'))
  // Scalable tiers expand to N nodes each.
  assert.equal(k.filter((x) => x === 'sonarqube-app').length, 2)
  assert.equal(k.filter((x) => x === 'search').length, 3)
  // PostgreSQL appears exactly once.
  assert.equal(k.filter((x) => x === 'postgres').length, 1)
})

test('a distributed self-hosted stack omits the cloud load balancer + DNS', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: false,
    tiers: [{ key: 'application', count: 1 }, { key: 'search', count: 3 }],
  })
  const k = kinds(plan)
  assert.ok(!k.includes('load-balancer'))
  assert.ok(!k.includes('dns'))
  assert.ok(k.includes('sonarqube-app'))
})

test('the application tier carries web/compute roles and is an ALB target kind', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: true,
    tiers: [{ key: 'application', count: 1 }, { key: 'search', count: 3 }],
  })
  const app = plan.find((p) => p.kind === 'sonarqube-app')!
  assert.deepEqual(app.roles, ['web', 'compute'])
  assert.equal(app.tier, 'app')
})

test('every plan item carries a tier in TIER_ORDER and a stable sortOrder', () => {
  const plan = buildByolResourcePlan({
    deploymentType: 'distributed',
    isCloud: true,
    tiers: [{ key: 'application', count: 1 }, { key: 'search', count: 3 }],
  })
  plan.forEach((item, i) => {
    assert.ok((TIER_ORDER as readonly string[]).includes(item.tier), `unknown tier ${item.tier}`)
    assert.equal(item.sortOrder, i)
  })
})
