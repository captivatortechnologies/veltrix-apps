import { mapByol } from '../db/mappers'

// =============================================================================
// mapByol must surface the generic `node_tiers` JSONB column as `tiers` — the
// shape the SDK's <ByolInfrastructureManager> GET responses read — whether the
// driver hands it back as a parsed array (the normal pg case) or a raw JSON
// string, and degrade to [] rather than throw on anything malformed/absent.
// =============================================================================

const baseRow = {
  id: 'i1',
  name: 'Prod',
  deployment_type: 'distributed',
  environment_type: 'prod',
  indexer_count: 4,
  search_head_count: 2,
  status: 'not_started',
  customer_id: 'cust-1',
  cloud_provider_id: 'cp-aws',
  hosting_type: 'AWS',
  region: 'us-east-1',
  network_mode: 'shared',
  dns_mode: 'managed',
  cloud_account_connection_id: null,
  control_plane_layout: 'dedicated',
  heavy_forwarder_count: 1,
  indexer_placement: null,
  search_head_placement: null,
  instance_type: null,
  created_at: new Date(),
  updated_at: new Date(),
}

describe('mapByol — tiers', () => {
  it('parses an already-decoded node_tiers array (the normal pg jsonb shape)', () => {
    const dto = mapByol({
      ...baseRow,
      node_tiers: [
        { key: 'search', count: 4, placement: null },
        { key: 'heavy', count: 2, placement: null },
      ],
    })
    expect(dto.tiers).toEqual([
      { key: 'search', count: 4, placement: null },
      { key: 'heavy', count: 2, placement: null },
    ])
  })

  it('parses a raw JSON string node_tiers value', () => {
    const dto = mapByol({
      ...baseRow,
      node_tiers: JSON.stringify([{ key: 'search', count: 3, placement: null }]),
    })
    expect(dto.tiers).toEqual([{ key: 'search', count: 3, placement: null }])
  })

  it('carries a tier placement through', () => {
    const placement = { mode: 'multi-site', granularity: 'az', sites: [{ site: 'us-east-1a', percent: 100 }] }
    const dto = mapByol({
      ...baseRow,
      node_tiers: [{ key: 'search', count: 1, placement }],
    })
    expect(dto.tiers[0].placement).toEqual(placement)
  })

  it('degrades to [] for absent, malformed or non-array node_tiers', () => {
    expect(mapByol({ ...baseRow, node_tiers: null }).tiers).toEqual([])
    expect(mapByol({ ...baseRow, node_tiers: undefined }).tiers).toEqual([])
    expect(mapByol({ ...baseRow, node_tiers: 'not json' }).tiers).toEqual([])
    expect(mapByol({ ...baseRow, node_tiers: { not: 'an array' } }).tiers).toEqual([])
  })
})
