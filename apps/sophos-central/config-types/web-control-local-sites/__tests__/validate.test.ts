import validate from '../validate'
import { buildLocalSiteBody, extractLocalSiteSpecs, localSiteKey, localSiteMatches } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sophos-central',
    customerId: 'cust-1',
    configTypeId: 'web-control-local-sites',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'web-control-local-sites',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = { url: 'https://intranet.example.com', categoryId: 50, tags: [], comment: 'Internal site' }

describe('Sophos Central Web Control Local Sites Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed local site with a categoryId', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
  })

  it('validates a well-formed local site with tags instead of a categoryId', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: { url: 'https://x.example.com', tags: ['internal'], comment: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires a url', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { categoryId: 50 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.endsWith('.url'))).toBe(true)
  })

  it('requires either categoryId or tags', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { url: 'https://x.example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.endsWith('.categoryId'))).toBe(true)
  })

  it('rejects a categoryId out of range', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, categoryId: 200 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CATEGORY_ID')).toBe(true)
  })

  it('warns on a duplicate url', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_URL')).toBe(true)
  })
})

describe('Sophos Central Web Control Local Sites shared helpers', () => {
  it('localSiteKey trims and lower-cases', () => {
    expect(localSiteKey('  HTTPS://Example.com  ')).toBe('https://example.com')
  })

  it('extractLocalSiteSpecs reads categoryId as a number and splits tags', () => {
    const specs = extractLocalSiteSpecs(
      makeCtx([{ name: 'e', fields: { url: 'https://x.com', categoryId: '50', tags: 'a,b', comment: '' } }]).canvas,
    )
    expect(specs[0].categoryId).toBe(50)
    expect(specs[0].tags).toEqual(['a', 'b'])
  })

  it('buildLocalSiteBody omits categoryId/tags/comment when absent', () => {
    expect(buildLocalSiteBody({ itemName: 'x', url: 'https://x.com', tags: [], comment: '' })).toEqual({ url: 'https://x.com' })
  })

  it('localSiteMatches compares categoryId/tags/comment order-insensitively for tags', () => {
    const spec = { itemName: 'x', url: 'https://x.com', categoryId: 50, tags: ['b', 'a'], comment: 'ok' }
    expect(localSiteMatches(spec, { url: 'https://x.com', categoryId: 50, tags: ['a', 'b'], comment: 'ok' })).toBe(true)
    expect(localSiteMatches(spec, { url: 'https://x.com', categoryId: 51, tags: ['a', 'b'], comment: 'ok' })).toBe(false)
  })
})
