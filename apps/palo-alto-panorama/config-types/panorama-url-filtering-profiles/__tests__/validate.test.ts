import validate, {
  extractUrlFilteringSpecs,
  buildUrlFilteringFields,
  urlFilteringDriftDiffs,
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
    configTypeId: 'panorama-url-filtering-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-url-filtering-profiles',
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

describe('Panorama URL Filtering Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a profile with bucketed categories', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'strict', block: ['malware', 'phishing'], alert: ['social-networking'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a category placed in two buckets', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'strict', block: ['malware'], alert: ['malware'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'category_conflict')).toBe(true)
  })

  it('warns when no categories are bucketed', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'empty' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_categories')).toBe(true)
  })

  it('builds action buckets and enforcement flags', () => {
    const spec = extractUrlFilteringSpecs(
      makeCtx([{ name: 'p', fields: { name: 'strict', block: ['malware', 'phishing'], alert: ['social-networking'], log_container_page_only: true } }]).canvas,
    )[0]
    const fields = buildUrlFilteringFields(spec)
    expect(fields.block).toEqual({ member: ['malware', 'phishing'] })
    expect(fields.alert).toEqual({ member: ['social-networking'] })
    expect(fields['safe-search-enforcement']).toBe('no')
    expect(fields['log-container-page-only']).toBe('yes')
    expect(fields.allow).toBeUndefined()
  })

  it('detects category and flag drift', () => {
    const spec = extractUrlFilteringSpecs(makeCtx([{ name: 'p', fields: { name: 'strict', block: ['malware', 'phishing'] } }]).canvas)[0]
    const clean = urlFilteringDriftDiffs(spec, { '@name': 'strict', block: { member: ['phishing', 'malware'] }, 'safe-search-enforcement': 'no', 'log-container-page-only': 'yes' })
    expect(clean).toHaveLength(0)
    const drifted = urlFilteringDriftDiffs(spec, { '@name': 'strict', block: { member: ['malware'] } })
    expect(drifted.some((d) => d.field.endsWith('.block'))).toBe(true)
  })
})
