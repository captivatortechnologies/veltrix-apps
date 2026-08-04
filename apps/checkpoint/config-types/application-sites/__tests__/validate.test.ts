import validate, { applicationSiteKey, extractApplicationSiteSpecs, livePrimaryCategoryName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'application-sites',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'application-sites',
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

describe('Check Point Application Sites Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('accepts a site with URL patterns', async () => {
    const result = await validate(makeCtx([{ name: 'Site', fields: { name: 'internal-wiki', urlList: ['*.wiki.example.com'] } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires at least one URL pattern', async () => {
    const result = await validate(makeCtx([{ name: 'Site', fields: { name: 'no-urls' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('urlList'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { urlList: ['*.example.com'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate site names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Internal-Wiki', urlList: ['*.wiki.example.com'] } },
        { name: 'b', fields: { name: 'internal-wiki', urlList: ['*.wiki.example.com'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractApplicationSiteSpecs trims fields and defaults the regex flag', () => {
    const specs = extractApplicationSiteSpecs(
      makeCtx([{ id: 'i1', name: 'e', fields: { name: '  site-2  ', urlList: [' *.example.com '] } }]).canvas,
    )
    expect(specs[0].name).toBe('site-2')
    expect(specs[0].urlList).toEqual(['*.example.com'])
    expect(specs[0].urlsDefinedAsRegex).toBe(false)
    expect(applicationSiteKey('  Site-2 ')).toBe('site-2')
  })
})

describe('livePrimaryCategoryName', () => {
  it('reads a plain string or an object summary', () => {
    expect(livePrimaryCategoryName('Business')).toBe('Business')
    expect(livePrimaryCategoryName({ name: 'Business' })).toBe('Business')
    expect(livePrimaryCategoryName(undefined)).toBe('')
  })
})
