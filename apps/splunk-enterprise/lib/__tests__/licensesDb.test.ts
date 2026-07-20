import { recordLicense, listLicenses, getLicense, deleteLicense } from '../db/licenses'
import type { ParsedLicense } from '../licenseXml'

interface Captured {
  sql: string
  args: unknown[]
}

/** A db double that records raw-SQL calls and returns one fake license row. */
function fakeDb() {
  const queries: Captured[] = []
  const executes: Captured[] = []
  const row: Record<string, unknown> = {
    id: 'lic-1',
    customer_id: 'cust-1',
    label: 'Acme Prod License',
    license_type: 'enterprise',
    group_id: 'Enterprise',
    stack_id: 'enterprise',
    // BIGINT often round-trips as a string via the raw driver — mapLicense must Number() it.
    quota_bytes: '536870912000',
    window_period: 30,
    max_violations: 5,
    creation_time: new Date('2024-01-01T00:00:00Z'),
    expiration_time: new Date('2099-01-01T00:00:00Z'),
    guid: 'GUID-1',
    features: ['Auth', 'FwdData'],
    raw_xml: '<license/>',
    created_by: 'user-1',
    created_at: new Date(),
    updated_at: new Date(),
  }
  const db = {
    $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
      queries.push({ sql, args })
      return Promise.resolve([row])
    },
    $executeRawUnsafe: (sql: string, ...args: unknown[]) => {
      executes.push({ sql, args })
      return Promise.resolve(1)
    },
  } as any
  return { db, queries, executes }
}

const parsed: ParsedLicense = {
  label: 'Acme Prod License',
  licenseType: 'enterprise',
  groupId: 'Enterprise',
  stackId: 'enterprise',
  quotaBytes: 536870912000,
  windowPeriod: 30,
  maxViolations: 5,
  creationTime: new Date('2024-01-01T00:00:00Z'),
  expirationTime: new Date('2099-01-01T00:00:00Z'),
  guid: 'GUID-1',
  features: ['Auth', 'FwdData'],
}

describe('recordLicense', () => {
  it('upserts on (customer_id, guid) and passes the extracted fields', async () => {
    const { db, queries } = fakeDb()
    await recordLicense(db, 'cust-1', parsed, '<license/>', 'user-1')

    const insert = queries.find((c) => c.sql.includes('INSERT INTO splunk_licenses'))
    expect(insert).toBeTruthy()
    expect(insert!.sql).toMatch(/ON CONFLICT \(customer_id, guid\) DO UPDATE/)
    expect(insert!.args).toContain('GUID-1')
    expect(insert!.args).toContain(536870912000)
    expect(insert!.args).toContain(JSON.stringify(['Auth', 'FwdData']))
    expect(insert!.args).toContain('<license/>')
    expect(insert!.args).toContain('cust-1')
  })

  it('maps the returned row (Number-coercing the BIGINT quota) and derives status', async () => {
    const { db } = fakeDb()
    const dto = await recordLicense(db, 'cust-1', parsed, '<license/>', 'user-1')
    expect(dto.quotaBytes).toBe(536870912000)
    expect(dto.features).toEqual(['Auth', 'FwdData'])
    expect(dto.status).toBe('active') // far-future expiration
  })
})

describe('listLicenses', () => {
  it('scopes to the customer and orders by expiration', async () => {
    const { db, queries } = fakeDb()
    const rows = await listLicenses(db, 'cust-1')
    expect(rows).toHaveLength(1)
    const q = queries[0]
    expect(q.sql).toMatch(/FROM splunk_licenses WHERE customer_id = \$1::uuid/)
    expect(q.sql).toMatch(/ORDER BY expiration_time/)
    expect(q.args).toContain('cust-1')
  })
})

describe('getLicense', () => {
  it('looks up by id scoped to the customer', async () => {
    const { db, queries } = fakeDb()
    const dto = await getLicense(db, 'lic-1', 'cust-1')
    expect(dto).toBeTruthy()
    expect(queries[0].sql).toMatch(/WHERE id = \$1::uuid AND customer_id = \$2::uuid/)
    expect(queries[0].args).toEqual(['lic-1', 'cust-1'])
  })
})

describe('deleteLicense', () => {
  it('deletes scoped to the customer', async () => {
    const { db, executes } = fakeDb()
    await deleteLicense(db, 'lic-1', 'cust-1')
    expect(executes[0].sql).toMatch(/DELETE FROM splunk_licenses WHERE id = \$1::uuid AND customer_id = \$2::uuid/)
    expect(executes[0].args).toEqual(['lic-1', 'cust-1'])
  })
})
