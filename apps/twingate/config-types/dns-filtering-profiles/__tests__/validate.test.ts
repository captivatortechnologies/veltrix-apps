import validate from '../validate'
import {
  buildContentCategoryConfig,
  buildSecurityCategoryConfig,
  buildPrivacyCategoryConfig,
  extractDnsFilteringProfileSpecs,
  profileKey,
  selectedFlags,
  setSignature,
  CONTENT_CATEGORY_FLAGS,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'twingate',
    entityType: 'dns-filtering-profiles',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'twingate',
    customerId: 'cust-1',
    configTypeId: 'dns-filtering-profiles',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = { name: 'Standard Filtering', priority: 1 }

describe('Twingate DNS Filtering Profiles validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid profile', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { priority: 1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported fallback method', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { ...validFields, fallback_method: 'LOOSE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_fallback_method')).toBe(true)
  })

  it('rejects an unsupported category flag', async () => {
    const result = await validate(
      makeCtx([{ name: 'item1', fields: { ...validFields, content_categories: ['blockEverything'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_category_flag')).toBe(true)
  })

  it('accepts every known content category flag', async () => {
    const result = await validate(
      makeCtx([{ name: 'item1', fields: { ...validFields, content_categories: CONTENT_CATEGORY_FLAGS.map((f) => f.key) } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate profile names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Standard' } },
        { name: 'b', fields: { ...validFields, name: 'standard' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_profile')).toBe(true)
  })
})

describe('Twingate DNS Filtering Profiles shared helpers', () => {
  it('extractDnsFilteringProfileSpecs defaults, trims and reads lists/numbers', () => {
    const specs = extractDnsFilteringProfileSpecs(
      makeCanvas([{ name: 'item1', fields: { name: '  Standard  ', priority: '2', allowed_domains: 'a.com, b.com' } }]),
    )
    expect(specs[0].name).toBe('Standard')
    expect(specs[0].priority).toBe(2)
    expect(specs[0].fallbackMethod).toBe('STRICT')
    expect(specs[0].allowedDomains).toEqual(['a.com', 'b.com'])
    expect(profileKey('  Standard ')).toBe('standard')
  })

  it('buildContentCategoryConfig sets every known flag explicitly (selected true, rest false)', () => {
    const config = buildContentCategoryConfig(['blockGambling', 'enableSafeSearch'])
    expect(config.blockGambling).toBe(true)
    expect(config.enableSafeSearch).toBe(true)
    expect(config.blockDating).toBe(false)
    expect(Object.keys(config)).toHaveLength(CONTENT_CATEGORY_FLAGS.length)
  })

  it('buildSecurityCategoryConfig and buildPrivacyCategoryConfig round-trip through selectedFlags', () => {
    const security = buildSecurityCategoryConfig(['blockCryptojacking', 'blockTyposquatting'])
    expect(selectedFlags(security, [{ key: 'blockCryptojacking' }, { key: 'blockTyposquatting' }, { key: 'blockParkedDomains' }])).toEqual(
      ['blockCryptojacking', 'blockTyposquatting'],
    )
    const privacy = buildPrivacyCategoryConfig([])
    expect(selectedFlags(privacy, [{ key: 'blockAffiliate' }])).toEqual([])
  })

  it('setSignature is order- and case-insensitive and de-duplicates', () => {
    expect(setSignature(['B.com', 'a.com', 'b.com'])).toBe(setSignature(['A.COM', 'b.com']))
  })
})
