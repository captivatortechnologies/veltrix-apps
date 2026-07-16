import validate, { extractTagSpecs, tagKey, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-tags',
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

describe('InsightVM Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid custom tag', async () => {
    const result = await validate(makeCtx([{ name: 'Tag', fields: { name: 'DB Servers', type: 'custom', color: '#F6821F' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name/type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { color: '#000' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', type: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects invalid search_criteria_json (array)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', type: 'custom', search_criteria_json: '[1,2]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate (name,type) case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'DB', type: 'custom' } },
        { name: 'b', fields: { name: 'db', type: 'CUSTOM' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_tag')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseJsonObject('  ').error).toBeNull()
    expect(parseJsonObject('{"match":"all"}').value).toEqual({ match: 'all' })
    const specs = extractTagSpecs(makeCtx([{ name: 't', fields: { name: '  DB  ', type: 'custom', risk_modifier: '2' } }]).canvas)
    expect(specs[0].name).toBe('DB')
    expect(specs[0].riskModifier).toBe(2)
    expect(tagKey(specs[0])).toBe(tagKey({ name: 'db', type: 'CUSTOM' }))
  })
})
