import { seedResources, reconcileTerminal, listResources } from '../db/byolProvisioning'
import type { Row } from '../db/mappers'

// =============================================================================
// Provisioning store — verified against a fake db client that records the SQL it
// is handed and serves canned rows for reads. This pins the shape of the writes
// (delete-stale + upsert-per-plan-item; terminal reconciliation) without a real
// Postgres, in the same spirit as the fetch-stub deploy tests.
// =============================================================================

interface Call {
  sql: string
  params: unknown[]
}

class FakeDb {
  calls: Call[] = []
  private queued: Row[][] = []

  /** Queue rows to be returned by the next $queryRawUnsafe call (FIFO). */
  queue(rows: Row[]): void {
    this.queued.push(rows)
  }

  async $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<Row[]> {
    this.calls.push({ sql, params })
    return this.queued.shift() ?? []
  }

  async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    this.calls.push({ sql, params })
    return 1
  }

  find(re: RegExp): Call | undefined {
    return this.calls.find((c) => re.test(c.sql))
  }

  all(re: RegExp): Call[] {
    return this.calls.filter((c) => re.test(c.sql))
  }
}

const PLAN = [
  { planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'net', region: null, sortOrder: 0 },
  { planKey: 'data/standalone', tier: 'data', kind: 'standalone', name: 'Splunk instance', role: 'aio', region: 'local', sortOrder: 1 },
] as any

describe('seedResources', () => {
  it('drops stale rows then upserts one row per plan item', async () => {
    const db = new FakeDb()
    db.queue([]) // final listResources() SELECT

    await seedResources(db as any, 'infra-1', 'cust-1', PLAN)

    const del = db.find(/DELETE FROM splunk_byol_resource/)
    expect(del).toBeTruthy()
    // second param is the array of plan keys to keep
    expect(del?.params[1]).toEqual(['foundation/network', 'data/standalone'])

    const upserts = db.all(/INSERT INTO splunk_byol_resource/)
    expect(upserts).toHaveLength(2)
    // every upsert seeds the row as 'provisioning'
    for (const u of upserts) expect(u.sql).toContain("'provisioning'")
  })

  it('returns the persisted rows, mapped to camelCase', async () => {
    const db = new FakeDb()
    db.queue([
      {
        id: 'r1',
        infrastructure_id: 'infra-1',
        tier: 'foundation',
        kind: 'network',
        name: 'Network',
        role: 'net',
        region: null,
        status: 'provisioning',
        plan_key: 'foundation/network',
        sort_order: 0,
        customer_id: 'cust-1',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const rows = await seedResources(db as any, 'infra-1', 'cust-1', PLAN)
    expect(rows).toHaveLength(1)
    expect(rows[0].planKey).toBe('foundation/network')
    expect(rows[0].status).toBe('provisioning')
  })
})

describe('reconcileTerminal', () => {
  it('marks every resource ready on success (no run present)', async () => {
    const db = new FakeDb()
    db.queue([]) // getLatestDeployment() → none

    await reconcileTerminal(db as any, 'infra-1', 'succeeded')

    const updAll = db.find(/UPDATE splunk_byol_resource SET status = \$2/)
    expect(updAll).toBeTruthy()
    expect(updAll?.params).toEqual(['infra-1', 'ready'])
  })

  it('does not force resources ready on failure', async () => {
    const db = new FakeDb()
    db.queue([]) // getLatestDeployment() → none

    await reconcileTerminal(db as any, 'infra-1', 'failed')

    expect(db.find(/UPDATE splunk_byol_resource SET status = \$2/)).toBeUndefined()
  })

  it('resets resources to not_started on a successful teardown (never ready)', async () => {
    const db = new FakeDb()
    db.queue([]) // getLatestDeployment() → none

    await reconcileTerminal(db as any, 'infra-1', 'destroyed')

    // A teardown resets resources to 'not_started' — never 'ready' (which the toEqual
    // pins exactly, so a regression to 'ready'/'active' fails here).
    const updAll = db.find(/UPDATE splunk_byol_resource SET status = \$2/)
    expect(updAll?.params).toEqual(['infra-1', 'not_started'])
  })
})

describe('listResources', () => {
  it('orders by sort_order', async () => {
    const db = new FakeDb()
    db.queue([])
    await listResources(db as any, 'infra-1')
    const sel = db.find(/SELECT \* FROM splunk_byol_resource/)
    expect(sel?.sql).toContain('ORDER BY sort_order ASC')
  })
})
