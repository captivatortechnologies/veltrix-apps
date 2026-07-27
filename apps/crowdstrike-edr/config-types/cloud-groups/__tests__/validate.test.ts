import validate, {
  extractCloudGroupSpecs,
  parseScoping,
} from '../validate'
import { buildGroupBody } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-groups',
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
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'crowdstrike-edr',
    entityType: 'cloud-groups',
    items: [],
    sections,
    snapshot: {},
  }
}

const AWS_SCOPE = JSON.stringify({
  aws: { accountIds: ['111122223333'], regions: ['us-east-1'], tags: ['env:prod'] },
})

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Production Assets',
    description: 'All production cloud assets',
    businessImpact: 'high',
    businessUnit: 'Platform',
    environment: 'prod',
    owners: 'alice@example.com, bob@example.com',
    scoping: AWS_SCOPE,
    ...overrides,
  }
}

describe('CrowdStrike Cloud Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid cloud group configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing group name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown business impact', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ businessImpact: 'extreme' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_business_impact')).toBe(true)
  })

  it('rejects an unknown environment', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ environment: 'sandbox' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_environment')).toBe(true)
  })

  it('rejects scoping that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ scoping: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scoping')).toBe(true)
  })

  it('rejects tag filters in a GCP scoping block', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({
            scoping: JSON.stringify({ gcp: { accountIds: ['my-project'], tags: ['x'] } }),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'gcp_tags_unsupported')).toBe(true)
  })

  it('rejects an image scope entry without a registry', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ scoping: JSON.stringify({ images: [{ repositories: ['acme/app'] }] }) }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_image')).toBe(true)
  })

  it('rejects duplicate group names per canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('accepts a metadata-only group with no scoping', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ scoping: '' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts full aws/azure/gcp/images scoping', async () => {
    const scoping = JSON.stringify({
      aws: { accountIds: ['111122223333'], regions: ['us-east-1'] },
      azure: { accountIds: ['sub-guid'], regions: ['eastus'], tags: ['env:prod'] },
      gcp: { accountIds: ['my-project'], regions: ['us-central1'] },
      images: [{ registry: 'https://index.docker.io', repositories: ['acme/app'], tags: ['latest'] }],
    })
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ scoping }) }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('parseScoping', () => {
  it('normalizes an aws block into the API selector shape', () => {
    const { selectors } = parseScoping(AWS_SCOPE)
    expect(selectors).toEqual({
      cloud_resources: [
        {
          cloud_provider: 'aws',
          account_ids: ['111122223333'],
          filters: { region: ['us-east-1'], tags: ['env:prod'] },
        },
      ],
    })
  })

  it('drops GCP tag filters and flags them', () => {
    const { selectors, gcpTagsDeclared } = parseScoping(
      JSON.stringify({ gcp: { accountIds: ['p'], regions: ['us-central1'], tags: ['x'] } }),
    )
    expect(gcpTagsDeclared).toBe(true)
    expect(selectors).toEqual({
      cloud_resources: [
        { cloud_provider: 'gcp', account_ids: ['p'], filters: { region: ['us-central1'] } },
      ],
    })
  })

  it('flags an image entry missing its registry', () => {
    const result = parseScoping(JSON.stringify({ images: [{ repositories: ['a'] }] }))
    expect(result.imageMissingRegistry).toBe(true)
    expect(result.selectors).toBeUndefined()
  })

  it('normalizes an image entry into singular filter keys', () => {
    const { selectors } = parseScoping(
      JSON.stringify({ images: [{ registry: 'https://reg', repositories: ['acme/app'], tags: ['v1'] }] }),
    )
    expect(selectors).toEqual({
      images: [{ registry: 'https://reg', filters: { repository: ['acme/app'], tag: ['v1'] } }],
    })
  })

  it('returns an error for malformed JSON', () => {
    const { error } = parseScoping('{not json')
    expect(error).toBeDefined()
    expect(error).toMatch(/JSON/)
  })

  it('returns an empty result for empty input', () => {
    expect(parseScoping('')).toEqual({})
  })
})

describe('extractCloudGroupSpecs', () => {
  it('parses owners, classification, and raw scoping from a section', () => {
    const specs = extractCloudGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ owners: ['x@y.com', 'z@y.com'] }) }]),
    )
    expect(specs).toHaveLength(1)
    expect(specs[0].name).toBe('Production Assets')
    expect(specs[0].businessImpact).toBe('high')
    expect(specs[0].environment).toBe('prod')
    expect(specs[0].owners).toEqual(['x@y.com', 'z@y.com'])
    expect(specs[0].scopingRaw).toBe(AWS_SCOPE)
  })
})

describe('buildGroupBody', () => {
  it('assembles the managed create/update body with normalized selectors', () => {
    const [spec] = extractCloudGroupSpecs(makeCanvas([{ name: 'sec1', fields: validFields() }]))
    const body = buildGroupBody(spec)
    expect(body.name).toBe('Production Assets')
    expect(body.business_impact).toBe('high')
    expect(body.environment).toBe('prod')
    expect(body.business_unit).toBe('Platform')
    expect(body.owners).toEqual(['alice@example.com', 'bob@example.com'])
    expect(body.selectors).toEqual({
      cloud_resources: [
        {
          cloud_provider: 'aws',
          account_ids: ['111122223333'],
          filters: { region: ['us-east-1'], tags: ['env:prod'] },
        },
      ],
    })
  })

  it('omits scope-free optional fields for a metadata-only group', () => {
    const [spec] = extractCloudGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ scoping: '', description: '', businessUnit: '' }) }]),
    )
    const body = buildGroupBody(spec)
    expect(body.selectors).toBeUndefined()
    expect(body.description).toBeUndefined()
    expect(body.business_unit).toBeUndefined()
  })
})
