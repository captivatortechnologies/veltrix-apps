import validate, {
  extractAuthServerSpecs,
  isProtectedServerId,
  nameSuggestsDefault,
  toAudienceList,
} from '../validate'
import { buildAuthServerBody, stripReadOnlyAuthServerFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'authorization-servers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'authorization-servers',
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
    toolType: 'okta-identity',
    entityType: 'authorization-servers',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Okta Authorization Servers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid authorization server', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Server', fields: { name: 'Partner API', audiences: ['api://partner'], status: 'ACTIVE' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a server with an issuer mode and description', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Server',
          fields: {
            name: 'Partner API',
            description: 'For partner integrations',
            audiences: ['api://partner'],
            issuerMode: 'CUSTOM_URL',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { audiences: ['api://x'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 40 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(41), audiences: ['api://x'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a server with no audiences', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Aud' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('audiences'))).toBe(true)
  })

  it('rejects a server with an empty audiences tag list', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Blank Aud', audiences: ['  '] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('audiences'))).toBe(true)
  })

  it('rejects a server with more than one audience', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Two Aud', audiences: ['api://a', 'api://b'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_audiences')).toBe(true)
  })

  it('rejects an unknown issuer mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad Mode', audiences: ['api://x'], issuerMode: 'MAGIC' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_issuer_mode')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad Status', audiences: ['api://x'], status: 'PAUSED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a duplicate server name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Partner API', audiences: ['api://a'] } },
        { name: 'sec2', fields: { name: 'partner api', audiences: ['api://b'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns (but does not error) when the name suggests the Okta default server', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'default', audiences: ['api://default'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.some((w) => w.code === 'default_server')).toBe(true)
  })

  it('warns on the default name case-insensitively', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: '  Default  ', audiences: ['api://default'] } }]),
    )
    expect(result.warnings.some((w) => w.code === 'default_server')).toBe(true)
  })
})

describe('extractAuthServerSpecs', () => {
  it('trims fields, upper-cases the status/issuerMode and drops a blank description', () => {
    const specs = extractAuthServerSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  Partner API  ',
            description: '   ',
            audiences: ['  api://partner  '],
            issuerMode: ' custom_url ',
            status: ' inactive ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('Partner API')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].audiences).toEqual(['api://partner'])
    expect(specs[0].issuerMode).toBe('CUSTOM_URL')
    expect(specs[0].status).toBe('INACTIVE')
  })

  it('defaults status to ACTIVE when unset and leaves issuerMode undefined', () => {
    const specs = extractAuthServerSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'S', audiences: ['api://x'] } }]),
    )
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].issuerMode).toBeUndefined()
  })
})

describe('toAudienceList', () => {
  it('reads a tags array', () => {
    expect(toAudienceList(['api://a', ' api://b '])).toEqual(['api://a', 'api://b'])
  })
  it('splits a comma/newline string', () => {
    expect(toAudienceList('api://a, api://b')).toEqual(['api://a', 'api://b'])
  })
  it('returns an empty list for a non-string, non-array value', () => {
    expect(toAudienceList(undefined)).toHaveLength(0)
  })
})

describe('isProtectedServerId', () => {
  it('matches the id "default" case-insensitively and nothing else', () => {
    expect(isProtectedServerId('default')).toBe(true)
    expect(isProtectedServerId('  DEFAULT  ')).toBe(true)
    expect(isProtectedServerId('aus1abc')).toBe(false)
    expect(isProtectedServerId(undefined)).toBe(false)
  })
})

describe('nameSuggestsDefault', () => {
  it('is true only for the name "default" (case-insensitive)', () => {
    expect(nameSuggestsDefault('default')).toBe(true)
    expect(nameSuggestsDefault('  Default ')).toBe(true)
    expect(nameSuggestsDefault('Partner API')).toBe(false)
  })
})

describe('buildAuthServerBody', () => {
  it('sends name/description/audiences and omits status; includes issuerMode when set', () => {
    const body = buildAuthServerBody({
      sectionName: 's',
      name: 'Partner API',
      description: 'desc',
      audiences: ['api://partner'],
      issuerMode: 'ORG_URL',
      status: 'ACTIVE',
    })
    expect(body).toEqual({
      name: 'Partner API',
      description: 'desc',
      audiences: ['api://partner'],
      issuerMode: 'ORG_URL',
    })
    expect(body.status).toBeUndefined()
  })

  it('defaults a missing description to an empty string and omits a missing issuerMode', () => {
    const body = buildAuthServerBody({
      sectionName: 's',
      name: 'Partner API',
      audiences: ['api://partner'],
      status: 'ACTIVE',
    })
    expect(body.description).toBe('')
    expect(body.issuerMode).toBeUndefined()
  })
})

describe('stripReadOnlyAuthServerFields', () => {
  it('removes id/created/lastUpdated/issuer/credentials/_links/_embedded/status but keeps the body', () => {
    const stripped = stripReadOnlyAuthServerFields({
      id: 'aus1abc',
      name: 'Partner API',
      description: 'desc',
      audiences: ['api://partner'],
      issuerMode: 'ORG_URL',
      status: 'ACTIVE',
      issuer: 'https://org.okta.com/oauth2/aus1abc',
      credentials: { signing: {} },
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
    })
    expect(stripped).toEqual({
      name: 'Partner API',
      description: 'desc',
      audiences: ['api://partner'],
      issuerMode: 'ORG_URL',
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
    expect(stripped.issuer).toBeUndefined()
    expect(stripped.credentials).toBeUndefined()
  })
})
