import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapByol } from '../db/mappers'

// =============================================================================
// mapByol must surface the generic `node_tiers` JSONB column as `tiers` — the
// shape the SDK's <ByolInfrastructureManager> GET responses read — whether the
// driver hands it back as a parsed array (the normal pg case) or a raw JSON
// string. This app is node_tiers-native, so an absent/empty/malformed column
// maps to `undefined` (NOT `[]`) so the SDK form's legacy fallback stays falsy.
// =============================================================================

const baseRow = {
  id: 'i1',
  name: 'Prod',
  deployment_type: 'distributed',
  environment_type: 'prod',
  status: 'not_started',
  customer_id: 'cust-1',
  cloud_provider_id: 'cp-aws',
  hosting_type: 'AWS',
  region: 'us-east-1',
  network_mode: 'shared',
  dns_mode: 'managed',
  cloud_account_connection_id: null,
  control_plane_layout: 'dedicated',
  instance_type: null,
  created_at: new Date(),
  updated_at: new Date(),
}

test('mapByol parses an already-decoded node_tiers array (the normal pg jsonb shape)', () => {
  const dto = mapByol({
    ...baseRow,
    node_tiers: [
      { key: 'frontend', count: 3, placement: null },
      { key: 'datastore', count: 2, placement: null },
    ],
  })
  assert.deepEqual(dto.tiers, [
    { key: 'frontend', count: 3, placement: null },
    { key: 'datastore', count: 2, placement: null },
  ])
})

test('mapByol parses a raw JSON string node_tiers value', () => {
  const dto = mapByol({
    ...baseRow,
    node_tiers: JSON.stringify([{ key: 'frontend', count: 1, placement: null }]),
  })
  assert.deepEqual(dto.tiers, [{ key: 'frontend', count: 1, placement: null }])
})

test('mapByol carries a tier placement through', () => {
  const placement = { mode: 'multi-site', granularity: 'az', sites: [{ site: 'us-east-1a', percent: 100 }] }
  const dto = mapByol({
    ...baseRow,
    node_tiers: [{ key: 'frontend', count: 1, placement }],
  })
  assert.deepEqual(dto.tiers![0].placement, placement)
})

test('mapByol maps absent, malformed or non-array node_tiers to undefined (falsy for the SDK fallback)', () => {
  assert.equal(mapByol({ ...baseRow, node_tiers: null }).tiers, undefined)
  assert.equal(mapByol({ ...baseRow, node_tiers: undefined }).tiers, undefined)
  assert.equal(mapByol({ ...baseRow, node_tiers: 'not json' }).tiers, undefined)
  assert.equal(mapByol({ ...baseRow, node_tiers: { not: 'an array' } }).tiers, undefined)
  assert.equal(mapByol({ ...baseRow, node_tiers: '[]' }).tiers, undefined)
})
