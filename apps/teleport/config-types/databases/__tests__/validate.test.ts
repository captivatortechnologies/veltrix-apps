import validate, { extractDatabaseSpecs, labelsFromKeyValue } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'teleport',
    customerId: 'cust-1',
    configTypeId: 'databases',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'teleport',
      entityType: 'databases',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'teleport',
    entityType: 'databases',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Teleport Databases Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal database', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'orders-db', protocol: 'postgres', uri: 'db.internal:5432' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing protocol', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'orders-db', uri: 'db.internal:5432' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('protocol'))).toBe(true)
  })

  it('rejects an invalid protocol', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'orders-db', protocol: 'Postgres SQL!', uri: 'db.internal:5432' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_protocol')).toBe(true)
  })

  it('rejects a duplicate database name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'orders-db', protocol: 'postgres', uri: 'a:5432' } },
        { name: 'sec2', fields: { name: 'orders-db', protocol: 'mysql', uri: 'b:3306' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_database')).toBe(true)
  })

  it('rejects a partial AWS RDS block', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'orders-db', protocol: 'postgres', uri: 'a:5432', awsAccountId: '123456789012' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'incomplete_aws_rds').length).toBeGreaterThan(0)
  })

  it('accepts a complete AWS RDS block', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'orders-db',
            protocol: 'postgres',
            uri: 'a:5432',
            awsAccountId: '123456789012',
            awsResourceId: 'db-ABCDEF',
            awsVpcId: 'vpc-123',
            awsSubnets: ['subnet-1'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('labelsFromKeyValue', () => {
  it('converts a keyvalue object into a Label array', () => {
    expect(labelsFromKeyValue({ env: 'production', team: 'payments' })).toEqual([
      { name: 'env', value: 'production' },
      { name: 'team', value: 'payments' },
    ])
  })

  it('returns an empty array for non-object input', () => {
    expect(labelsFromKeyValue(undefined)).toEqual([])
  })
})

describe('extractDatabaseSpecs', () => {
  it('lowercases the protocol and builds awsRds only when a field is set', () => {
    const specs = extractDatabaseSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'orders-db', protocol: 'POSTGRES', uri: 'a:5432' } }]),
    )
    expect(specs[0].protocol).toBe('postgres')
    expect(specs[0].awsRds).toBeNull()
  })
})
