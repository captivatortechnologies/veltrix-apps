import validate, {
  extractConnectionSpecs,
  hasCredential,
  liveRepository,
  liveStatus,
  type ConnectionSpec,
} from '../validate'
import { buildConnectionBody, buildConnectionConfig, findByName } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ngsiem-data-connections',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-data-connections',
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

function validConnectionFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'AWS S3 Prod',
    connectorType: 'aws-s3',
    sourceEndpoint: 'https://s3.us-east-1.amazonaws.com/my-bucket',
    credential: 'super-secret-token',
    targetRepository: 'security-logs',
    parser: 'json',
    enabled: true,
    ...overrides,
  }
}

describe('CrowdStrike NG-SIEM Data Connections Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid connection configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Connection', fields: validConnectionFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validConnectionFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing connector type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validConnectionFields({ connectorType: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('connectorType'))).toBe(
      true,
    )
  })

  it('rejects a missing target repository', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validConnectionFields({ targetRepository: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((e) => e.code === 'required' && e.field.includes('targetRepository')),
    ).toBe(true)
  })

  it('warns when no credential is supplied', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validConnectionFields({ credential: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_credential')).toBe(true)
  })

  it('rejects duplicate connection names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validConnectionFields() },
        { name: 'sec2', fields: validConnectionFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractConnectionSpecs', () => {
  it('captures the secret verbatim and preserves connector-type casing', () => {
    const specs = extractConnectionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-data-connections',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: 'C1',
            connectorType: 'Azure-Event-Hub',
            targetRepository: 'repo',
            credential: '  P@ss  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].connectorType).toBe('Azure-Event-Hub')
    expect(specs[0].credential).toBe('  P@ss  ')
    expect(hasCredential(specs[0])).toBe(true)
  })

  it('defaults enabled to true and leaves optional fields undefined when unset', () => {
    const specs = extractConnectionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-data-connections',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'C1', connectorType: 'aws-s3', targetRepository: 'r' } }],
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].sourceEndpoint).toBeUndefined()
    expect(specs[0].parser).toBeUndefined()
  })
})

describe('buildConnectionConfig', () => {
  function spec(overrides: Partial<ConnectionSpec> = {}): ConnectionSpec {
    return {
      sectionName: 'sec1',
      name: 'AWS S3 Prod',
      connectorType: 'aws-s3',
      sourceEndpoint: 'https://example.com',
      credential: 'super-secret-token',
      targetRepository: 'security-logs',
      parser: 'json',
      enabled: true,
      ...overrides,
    }
  }

  it('includes non-secret params and the secret when supplied', () => {
    const config = buildConnectionConfig(spec())
    expect(config.endpoint).toBe('https://example.com')
    expect(config.repository).toBe('security-logs')
    expect(config.credential).toBe('super-secret-token')
  })

  it('omits the credential when no secret is supplied (non-secret update)', () => {
    const config = buildConnectionConfig(spec({ credential: '' }))
    expect(config.repository).toBe('security-logs')
    expect(config.credential).toBeUndefined()
  })
})

describe('buildConnectionBody', () => {
  function spec(overrides: Partial<ConnectionSpec> = {}): ConnectionSpec {
    return {
      sectionName: 'sec1',
      name: 'AWS S3 Prod',
      connectorType: 'aws-s3',
      sourceEndpoint: 'https://example.com',
      credential: 'super-secret-token',
      targetRepository: 'security-logs',
      parser: 'json',
      enabled: true,
      ...overrides,
    }
  }

  it('sends connector_type on create and nests config', () => {
    const body = buildConnectionBody(spec(), { forUpdate: false }) as Record<string, unknown>
    expect(body.name).toBe('AWS S3 Prod')
    expect(body.connector_type).toBe('aws-s3')
    expect(body.parser).toBe('json')
    const config = body.config as Record<string, unknown>
    expect(config.repository).toBe('security-logs')
    expect(config.credential).toBe('super-secret-token')
  })

  it('omits the immutable connector_type on update', () => {
    const body = buildConnectionBody(spec(), { forUpdate: true }) as Record<string, unknown>
    expect(body.connector_type).toBeUndefined()
    expect(body.name).toBe('AWS S3 Prod')
  })
})

describe('findByName', () => {
  it('matches a connection by its name', () => {
    const found = findByName(
      [
        { id: '1', name: 'Other' },
        { id: '2', name: 'AWS S3 Prod' },
      ],
      'AWS S3 Prod',
    )
    expect(found).toBeDefined()
    expect(found?.id).toBe('2')
  })

  it('returns null when no name matches', () => {
    const found = findByName([{ id: '1', name: 'Other' }], 'Missing')
    expect(found).toBeNull()
  })
})

describe('liveRepository / liveStatus', () => {
  it('reads repository from a top-level field or config, else undefined', () => {
    expect(liveRepository({ repository: 'top' })).toBe('top')
    expect(liveRepository({ config: { repository: 'nested' } })).toBe('nested')
    expect(liveRepository({})).toBeUndefined()
  })

  it('reads status from status then state, else undefined', () => {
    expect(liveStatus({ status: 'enabled' })).toBe('enabled')
    expect(liveStatus({ state: 'disabled' })).toBe('disabled')
    expect(liveStatus({})).toBeUndefined()
  })
})
