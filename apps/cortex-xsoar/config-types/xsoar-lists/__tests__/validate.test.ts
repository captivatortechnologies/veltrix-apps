import validate, { extractListSpecs, toListType } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-lists',
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

describe('Cortex XSOAR Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid list', async () => {
    const result = await validate(makeCtx([{ name: 'L1', fields: { name: 'Allowlist', data: 'a\nb' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { data: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate list name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Allowlist' } },
        { name: 'b', fields: { name: 'Allowlist' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_list')).toBe(true)
  })

  it('rejects invalid JSON for a JSON-typed list', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Cfg', listType: 'JSON', data: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('accepts valid JSON for a JSON-typed list', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Cfg', listType: 'JSON', data: '{"k":1}' } }]))
    expect(result.valid).toBe(true)
  })

  it('warns on empty data', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Empty' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_data')).toBe(true)
  })

  it('extractListSpecs trims the name and defaults the type to plain_text', () => {
    const specs = extractListSpecs(makeCtx([{ name: 's', fields: { name: '  Allowlist  ' } }]).canvas)
    expect(specs[0].name).toBe('Allowlist')
    expect(specs[0].type).toBe('plain_text')
  })

  it('extractListSpecs reads tags from an array or a comma string', () => {
    const asArray = extractListSpecs(makeCtx([{ name: 's', fields: { name: 'A', tags: ['x', 'y'] } }]).canvas)
    const asString = extractListSpecs(makeCtx([{ name: 's', fields: { name: 'B', tags: 'x, y' } }]).canvas)
    expect(asArray[0].tags).toEqual(['x', 'y'])
    expect(asString[0].tags).toEqual(['x', 'y'])
  })

  it('toListType falls back to plain_text for an unknown type', () => {
    expect(toListType('markdown')).toBe('markdown')
    expect(toListType('bogus')).toBe('plain_text')
  })
})
