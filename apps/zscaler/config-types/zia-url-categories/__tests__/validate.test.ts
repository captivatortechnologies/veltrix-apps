import validate, { extractUrlCategorySpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-url-categories',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-url-categories',
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

describe('ZIA URL Categories Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid URL category', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'URL Category',
          fields: {
            configured_name: 'Corp Blocklist',
            description: 'Blocked corporate sites',
            super_category: 'USER_DEFINED',
            type: 'URL_CATEGORY',
            urls: 'bad.example.com\nmalware.example.net',
            keywords: 'phish',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing configured_name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { super_category: 'USER_DEFINED', urls: 'a.example.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('configured_name'))).toBe(true)
  })

  it('rejects a missing super_category', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { configured_name: 'Corp', super_category: '   ', urls: 'a.example.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('super_category'))).toBe(true)
  })

  it('rejects a category with no URLs', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { configured_name: 'Corp', super_category: 'USER_DEFINED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'urls_required')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { configured_name: 'Blocklist', super_category: 'USER_DEFINED', urls: 'a.example.com' } },
        { name: 'b', fields: { configured_name: 'blocklist', super_category: 'USER_DEFINED', urls: 'b.example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_url_category')).toBe(true)
  })

  it('rejects a configured_name longer than 31 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { configured_name: 'x'.repeat(32), super_category: 'USER_DEFINED', urls: 'a.example.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('extractUrlCategorySpecs trims, splits lines and applies defaults', () => {
    const specs = extractUrlCategorySpecs(
      makeCtx([
        {
          name: 'URL Category',
          fields: { configured_name: '  Corp  ', super_category: ' USER_DEFINED ', urls: ' a.example.com \n\n b.example.com ', keywords: 'phish\n', description: '   ' },
        },
      ]).canvas,
    )
    expect(specs[0].configuredName).toBe('Corp')
    expect(specs[0].urls).toEqual(['a.example.com', 'b.example.com'])
    expect(specs[0].keywords).toEqual(['phish'])
    expect(specs[0].superCategory).toBe('USER_DEFINED')
    // type is optional, so it is backfilled to the default when unset.
    expect(specs[0].type).toBe('URL_CATEGORY')
    expect(specs[0].description).toBeUndefined()
  })
})
