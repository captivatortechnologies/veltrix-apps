import validate, { buildTagBody, tagKey, extractTagSpecs, indexTagsByName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'kandji',
    customerId: 'cust-1',
    configTypeId: 'tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'kandji',
      entityType: 'tags',
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

describe('Kandji Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid tag', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'contractors' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate tag names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Contractors' } },
        { name: 'b', fields: { name: 'contractors' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_tag')).toBe(true)
  })

  it('tagKey normalizes case and whitespace', () => {
    expect(tagKey('  Contractors ')).toBe('contractors')
  })

  it('buildTagBody maps name', () => {
    const specs = extractTagSpecs(makeCtx([{ name: 'sec', fields: { name: 'VIP' } }]).canvas)
    expect(buildTagBody(specs[0])).toEqual({ name: 'VIP' })
  })

  it('indexTagsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexTagsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
