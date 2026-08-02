import validate, { buildCategoryBody, categoryKey, extractCategorySpecs, indexCategoriesByName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'categories',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'categories',
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

describe('Jamf Categories Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid category', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Enrollment', priority: 5 } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { priority: 5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a negative priority', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Enrollment', priority: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects a non-integer priority', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Enrollment', priority: 2.5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('defaults priority to 0 when omitted', () => {
    const specs = extractCategorySpecs(makeCtx([{ name: 'sec', fields: { name: 'No Priority' } }]).canvas)
    expect(specs[0].priority).toBe(0)
  })

  it('rejects duplicate category names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Enrollment', priority: 1 } },
        { name: 'b', fields: { name: 'enrollment', priority: 2 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_category')).toBe(true)
  })

  it('categoryKey normalizes case and whitespace', () => {
    expect(categoryKey('  Enrollment ')).toBe('enrollment')
  })

  it('buildCategoryBody maps name and priority', () => {
    const specs = extractCategorySpecs(makeCtx([{ name: 'sec', fields: { name: 'Apps', priority: 9 } }]).canvas)
    expect(buildCategoryBody(specs[0])).toEqual({ name: 'Apps', priority: 9 })
  })

  it('indexCategoriesByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexCategoriesByName([
      { id: '1', name: 'Dup', priority: 1 },
      { id: '2', name: 'dup', priority: 2 },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
