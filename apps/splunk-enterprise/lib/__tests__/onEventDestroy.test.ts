import onEvent from '../../hooks/onEvent'
import type { Row } from '../db/mappers'

// A destroy terminal must set the infra to 'deprovisioned' (never 'active') and reset
// its resources to 'not_started' (never 'ready') — so a torn-down environment doesn't
// read as live or re-trigger an activation email. Verified against the fake db.

interface Call { sql: string; params: unknown[] }
class FakeDb {
  calls: Call[] = []
  private queued: Row[][] = []
  queue(rows: Row[]): void { this.queued.push(rows) }
  async $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<Row[]> {
    this.calls.push({ sql, params }); return this.queued.shift() ?? []
  }
  async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    this.calls.push({ sql, params }); return 1
  }
  find(re: RegExp): Call | undefined { return this.calls.find((c) => re.test(c.sql)) }
}

const infraRow = {
  id: 'i1', name: 'BYOL001', customer_id: 'c1', status: 'deprovisioned',
  deployment_type: 'distributed', environment_type: 'prod', hosting_type: 'AWS',
  region: 'us-east-1', indexer_count: 3, search_head_count: 2, cloud_provider_id: null,
  network_mode: 'dedicated', dns_mode: 'managed', cloud_account_connection_id: null,
  control_plane_layout: 'dedicated', heavy_forwarder_count: 1, indexer_placement: null,
  search_head_placement: null, instance_type: null,
} as unknown as Row

describe('onEvent — destroy terminal', () => {
  it('maps a destroy completion to deprovisioned + not_started, never active/ready', async () => {
    const db = new FakeDb()
    db.queue([])          // getLatestDeployment() → none (action comes from payload)
    db.queue([infraRow])  // setByolStatusIfExists() UPDATE ... RETURNING *
    db.queue([])          // reconcileTerminal() → getLatestDeployment() → none

    // The CI path emits 'completed' for a destroy too; the explicit action disambiguates.
    await onEvent({
      db: db as any,
      topic: 'deployment.status',
      payload: { infrastructureId: 'i1', status: 'completed', action: 'destroy' },
    } as any)

    // toEqual pins the exact status, so a regression to 'active'/'ready' fails here.
    const infraUpd = db.find(/UPDATE splunk_byol_infrastructure SET status = \$2/)
    expect(infraUpd?.params).toEqual(['i1', 'deprovisioned'])

    const resUpd = db.find(/UPDATE splunk_byol_resource SET status = \$2/)
    expect(resUpd?.params).toEqual(['i1', 'not_started'])
  })
})
