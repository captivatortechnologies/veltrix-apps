import validate, {
  extractTrustedOriginSpecs,
  isValidOrigin,
  liveScopeTypes,
} from '../validate'
import { buildTrustedOriginBody, stripReadOnlyTrustedOriginFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'trusted-origins',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'trusted-origins',
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
    entityType: 'trusted-origins',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Okta Trusted Origins Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid single-scope trusted origin', async () => {
    const result = await validate(
      makeCtx([
        { name: 'TO', fields: { name: 'App CORS', origin: 'https://app.example.com', scopes: ['CORS'], status: 'ACTIVE' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid multi-scope trusted origin', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'TO',
          fields: { name: 'App All', origin: 'https://app.example.com', scopes: ['CORS', 'REDIRECT', 'IFRAME_EMBED'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts an http localhost origin with a port', async () => {
    const result = await validate(
      makeCtx([{ name: 'TO', fields: { name: 'Local', origin: 'http://localhost:3000', scopes: ['REDIRECT'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { origin: 'https://app.example.com', scopes: ['CORS'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), origin: 'https://app.example.com', scopes: ['CORS'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing origin', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Origin', scopes: ['CORS'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('origin'))).toBe(true)
  })

  it('rejects an origin that is not a URL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad', origin: 'not a url', scopes: ['CORS'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_origin')).toBe(true)
  })

  it('rejects an origin that carries a path', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Pathy', origin: 'https://app.example.com/login', scopes: ['CORS'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_origin')).toBe(true)
  })

  it('rejects an origin with a non-http scheme', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'FTP', origin: 'ftp://files.example.com', scopes: ['CORS'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_origin')).toBe(true)
  })

  it('rejects an origin with no scopes', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'No Scopes', origin: 'https://app.example.com', scopes: [] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'scopes_required')).toBe(true)
  })

  it('rejects an unknown scope type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad Scope', origin: 'https://app.example.com', scopes: ['CORS', 'MAGIC'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scope')).toBe(true)
  })

  it('rejects a duplicate scope', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Dup Scope', origin: 'https://app.example.com', scopes: ['CORS', 'CORS'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_scope')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Bad Status', origin: 'https://app.example.com', scopes: ['CORS'], status: 'PAUSED' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a duplicate trusted origin name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Portal', origin: 'https://a.example.com', scopes: ['CORS'] } },
        { name: 'sec2', fields: { name: 'portal', origin: 'https://b.example.com', scopes: ['REDIRECT'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('accepts a lower-case scope entry (normalised to upper-case)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Lower', origin: 'https://app.example.com', scopes: ['cors', 'redirect'] } }]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractTrustedOriginSpecs', () => {
  it('trims fields, upper-cases scopes/status and strips a trailing slash from the origin', () => {
    const specs = extractTrustedOriginSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { name: '  App  ', origin: '  https://app.example.com/  ', scopes: [' cors ', 'redirect'], status: ' inactive ' },
        },
      ]),
    )
    expect(specs[0].name).toBe('App')
    expect(specs[0].origin).toBe('https://app.example.com')
    expect(specs[0].scopes).toEqual(['CORS', 'REDIRECT'])
    expect(specs[0].status).toBe('INACTIVE')
  })

  it('defaults status to ACTIVE when unset', () => {
    const specs = extractTrustedOriginSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'App', origin: 'https://app.example.com', scopes: ['CORS'] } }]),
    )
    expect(specs[0].status).toBe('ACTIVE')
  })

  it('parses a comma-separated scopes string', () => {
    const specs = extractTrustedOriginSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'App', origin: 'https://app.example.com', scopes: 'CORS, REDIRECT' } }]),
    )
    expect(specs[0].scopes).toEqual(['CORS', 'REDIRECT'])
  })
})

describe('isValidOrigin', () => {
  it('accepts scheme://host and scheme://host:port', () => {
    expect(isValidOrigin('https://app.example.com')).toBe(true)
    expect(isValidOrigin('http://localhost:3000')).toBe(true)
  })
  it('rejects a non-URL, a path, a query and a non-http scheme', () => {
    expect(isValidOrigin('not a url')).toBe(false)
    expect(isValidOrigin('https://app.example.com/login')).toBe(false)
    expect(isValidOrigin('https://app.example.com?a=1')).toBe(false)
    expect(isValidOrigin('ftp://files.example.com')).toBe(false)
  })
})

describe('liveScopeTypes', () => {
  it('returns the sorted upper-cased scope types', () => {
    expect(liveScopeTypes({ scopes: [{ type: 'REDIRECT' }, { type: 'cors' }] })).toEqual(['CORS', 'REDIRECT'])
  })
  it('returns an empty array when scopes are absent', () => {
    expect(liveScopeTypes({})).toEqual([])
  })
})

describe('buildTrustedOriginBody', () => {
  it('expands the scope types into the API [{type}] shape and omits status', () => {
    const body = buildTrustedOriginBody({
      sectionName: 's',
      name: 'App',
      origin: 'https://app.example.com',
      scopes: ['CORS', 'REDIRECT'],
      status: 'ACTIVE',
    })
    expect(body).toEqual({
      name: 'App',
      origin: 'https://app.example.com',
      scopes: [{ type: 'CORS' }, { type: 'REDIRECT' }],
    })
    expect(body.status).toBeUndefined()
  })
})

describe('stripReadOnlyTrustedOriginFields', () => {
  it('removes id/created/lastUpdated/status/_links/_embedded but keeps origin and scopes', () => {
    const stripped = stripReadOnlyTrustedOriginFields({
      id: 'tos123',
      name: 'App',
      origin: 'https://app.example.com',
      scopes: [{ type: 'CORS' }],
      status: 'ACTIVE',
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      createdBy: 'admin',
      lastUpdatedBy: 'admin',
      _links: { self: {} },
      _embedded: {},
    })
    expect(stripped).toEqual({
      name: 'App',
      origin: 'https://app.example.com',
      scopes: [{ type: 'CORS' }],
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})
