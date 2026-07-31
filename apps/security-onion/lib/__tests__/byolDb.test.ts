import { createByol, updateByol, type ByolInput } from '../db/byol'

// =============================================================================
// The generic per-tier `node_tiers` column (added by migration 004) must be
// written on both create and update — from the caller's `nodeTiers` when
// given, or derived from the legacy scalar fields (matching the migration's
// own backfill shape) for a store caller that predates the generic topology.
// =============================================================================

interface Captured {
  sql: string
  args: unknown[]
}

/** A minimal db double that records $queryRawUnsafe calls and returns a fake row. */
function fakeDb() {
  const calls: Captured[] = []
  const row: Record<string, unknown> = {
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
    node_tiers: '[]',
    created_at: new Date(),
    updated_at: new Date(),
  }
  const db = {
    $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args })
      if (/_region\b/.test(sql)) return Promise.resolve([]) // attachRegions lookups
      return Promise.resolve([row])
    },
    $executeRawUnsafe: () => Promise.resolve(1), // usage/state event
  } as any
  return { db, calls }
}

const baseInput: ByolInput = {
  name: 'Prod',
  deploymentType: 'distributed',
  environmentType: 'prod',
  hosting_type: 'AWS',
  region: 'us-east-1',
  indexerCount: 4,
  searchHeadCount: 2,
  cloudProviderId: 'cp-aws',
}

describe('createByol persists node_tiers', () => {
  it('writes the caller-supplied nodeTiers verbatim', async () => {
    const { db, calls } = fakeDb()
    await createByol(db, 'cust-1', {
      ...baseInput,
      nodeTiers: [
        { key: 'search', count: 4, placement: null },
        { key: 'heavy', count: 2, placement: null },
      ],
    })

    const insert = calls.find((c) => c.sql.includes('INSERT INTO so_byol_infrastructure'))
    expect(insert).toBeTruthy()
    expect(insert!.sql).toMatch(/node_tiers/)
    const nodeTiersArg = insert!.args[insert!.args.length - 1] as string
    expect(JSON.parse(nodeTiersArg)).toEqual([
      { key: 'search', count: 4, placement: null },
      { key: 'heavy', count: 2, placement: null },
    ])
  })

  it('derives node_tiers from the legacy scalar fields when nodeTiers is absent', async () => {
    const { db, calls } = fakeDb()
    await createByol(db, 'cust-1', baseInput)

    const insert = calls.find((c) => c.sql.includes('INSERT INTO so_byol_infrastructure'))
    const nodeTiersArg = insert!.args[insert!.args.length - 1] as string
    expect(JSON.parse(nodeTiersArg)).toEqual([
      { key: 'search', count: 4, placement: null },
      { key: 'heavy', count: 2, placement: null },
    ])
  })
})

describe('updateByol persists node_tiers', () => {
  it('writes the caller-supplied nodeTiers verbatim', async () => {
    const { db, calls } = fakeDb()
    await updateByol(db, 'i1', {
      ...baseInput,
      nodeTiers: [
        { key: 'search', count: 6, placement: null },
        { key: 'heavy', count: 3, placement: null },
      ],
    })

    const update = calls.find((c) => c.sql.includes('UPDATE so_byol_infrastructure'))
    expect(update).toBeTruthy()
    expect(update!.sql).toMatch(/node_tiers\s*=/)
    const nodeTiersArg = update!.args[update!.args.length - 1] as string
    expect(JSON.parse(nodeTiersArg)).toEqual([
      { key: 'search', count: 6, placement: null },
      { key: 'heavy', count: 3, placement: null },
    ])
  })

  it('derives node_tiers from the legacy scalar fields when nodeTiers is absent', async () => {
    const { db, calls } = fakeDb()
    await updateByol(db, 'i1', baseInput)

    const update = calls.find((c) => c.sql.includes('UPDATE so_byol_infrastructure'))
    const nodeTiersArg = update!.args[update!.args.length - 1] as string
    expect(JSON.parse(nodeTiersArg)).toEqual([
      { key: 'search', count: 4, placement: null },
      { key: 'heavy', count: 2, placement: null },
    ])
  })
})
