import validate, {
  extractCustomUrlCategorySpecs,
  buildCustomUrlCategoryFields,
  customUrlCategoryDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-custom-url-categories',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-custom-url-categories',
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

describe('Panorama Custom URL Categories Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a URL List category', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'blocked-domains', type: 'URL List', list: ['bad.example.com'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a Category Match category', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'high-risk-bundle', type: 'Category Match', list: ['gambling', 'phishing'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', type: 'IP List' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('warns on an empty list', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', type: 'URL List', list: [] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_list')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'cat1', type: 'URL List', list: ['x.com'] } },
        { name: 'b', fields: { name: 'CAT1', type: 'URL List', list: ['y.com'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds REST fields with type + list', () => {
    const spec = extractCustomUrlCategorySpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'Category Match', list: ['gambling'], description: 'test' } }]).canvas,
    )[0]
    const fields = buildCustomUrlCategoryFields(spec)
    expect(fields.type).toBe('Category Match')
    expect(fields.list).toEqual({ member: ['gambling'] })
    expect(fields.description).toBe('test')
  })

  it('detects type and list drift', () => {
    const spec = extractCustomUrlCategorySpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'URL List', list: ['a.com', 'b.com'] } }]).canvas,
    )[0]
    const clean = customUrlCategoryDriftDiffs(spec, { '@name': 'x', type: 'URL List', list: { member: ['b.com', 'a.com'] } })
    expect(clean).toHaveLength(0)
    const drifted = customUrlCategoryDriftDiffs(spec, { '@name': 'x', type: 'Category Match', list: { member: ['a.com'] } })
    expect(drifted.length).toBeGreaterThan(1)
  })
})
