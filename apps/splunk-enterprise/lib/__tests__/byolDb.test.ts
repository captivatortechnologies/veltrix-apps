import { createByol, updateByol, type ByolInput } from '../db/byol'

// =============================================================================
// Regression: create AND update must persist the deployment-target fields
// (network_mode, dns_mode, cloud_account_connection_id). updateByol previously
// dropped them, so editing an infra to Dedicated (BYOC) silently stayed shared.
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
    indexer_count: 3,
    search_head_count: 2,
    status: 'not_started',
    customer_id: 'cust-1',
    cloud_provider_id: 'cp-aws',
    hosting_type: 'AWS',
    region: 'us-east-1',
    network_mode: 'dedicated',
    dns_mode: 'managed',
    cloud_account_connection_id: 'acct-1',
    control_plane_layout: 'dedicated',
    heavy_forwarder_count: 1,
    indexer_placement: null,
    search_head_placement: null,
    instance_type: null,
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

const input: ByolInput = {
  name: 'Prod',
  deploymentType: 'distributed',
  environmentType: 'prod',
  hosting_type: 'AWS',
  region: 'us-east-1',
  indexerCount: 3,
  searchHeadCount: 2,
  cloudProviderId: 'cp-aws',
  networkMode: 'dedicated',
  dnsMode: 'managed',
  cloudAccountConnectionId: 'acct-1',
}

describe('updateByol persists the deployment target', () => {
  it('writes network_mode, dns_mode and cloud_account_connection_id', async () => {
    const { db, calls } = fakeDb()
    await updateByol(db, 'i1', input)

    const update = calls.find((c) => c.sql.includes('UPDATE splunk_byol_infrastructure'))
    expect(update).toBeTruthy()
    expect(update!.sql).toMatch(/network_mode\s*=/)
    expect(update!.sql).toMatch(/dns_mode\s*=/)
    expect(update!.sql).toMatch(/cloud_account_connection_id\s*=/)
    expect(update!.args).toContain('dedicated') // networkMode
    expect(update!.args).toContain('acct-1') // cloudAccountConnectionId
  })
})

describe('createByol persists the deployment target', () => {
  it('inserts network_mode, dns_mode and cloud_account_connection_id', async () => {
    const { db, calls } = fakeDb()
    await createByol(db, 'cust-1', input)

    const insert = calls.find((c) => c.sql.includes('INSERT INTO splunk_byol_infrastructure'))
    expect(insert).toBeTruthy()
    expect(insert!.sql).toMatch(/network_mode/)
    expect(insert!.sql).toMatch(/cloud_account_connection_id/)
    expect(insert!.args).toContain('dedicated')
    expect(insert!.args).toContain('acct-1')
  })
})
