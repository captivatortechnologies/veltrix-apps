import validate, { extractAccessGroupSpecs, parseJsonArray } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-access-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-access-groups',
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

const INCLUDE = '[{"email":{"email":"user@example.com"}}]'

describe('Cloudflare Access Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid Access group', async () => {
    const result = await validate(
      makeCtx([{ name: 'Engineers', fields: { name: 'Engineers', include_json: INCLUDE } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { include_json: INCLUDE } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects missing include rules', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Engineers' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('include_json'))).toBe(true)
  })

  it('rejects include rules that are not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Engineers', include_json: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('include_json'))).toBe(true)
  })

  it('rejects include rules that parse to an empty array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Engineers', include_json: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('include_json'))).toBe(true)
  })

  it('rejects include rules that parse to a non-array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineers', include_json: '{"email":{"email":"x@y.com"}}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('include_json'))).toBe(true)
  })

  it('rejects duplicate group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Engineers', include_json: INCLUDE } },
        { name: 'b', fields: { name: 'Engineers', include_json: INCLUDE } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('rejects an invalid optional exclude array but accepts a valid one', async () => {
    const bad = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineers', include_json: INCLUDE, exclude_json: 'nope' } }]),
    )
    expect(bad.valid).toBe(false)
    expect(bad.errors.some((e) => e.code === 'invalid_json' && e.field.includes('exclude_json'))).toBe(true)

    const good = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'Engineers', include_json: INCLUDE, exclude_json: '[{"ip":{"ip":"203.0.113.0/24"}}]', require_json: '[{"geo":{"country_code":"US"}}]' },
        },
      ]),
    )
    expect(good.valid).toBe(true)
  })

  it('parseJsonArray reports errors and extractAccessGroupSpecs trims the name', () => {
    expect(parseJsonArray('[1,2]').value).toEqual([1, 2])
    expect(parseJsonArray('{}').error).toBeTruthy()
    expect(parseJsonArray('  ').value).toEqual([])
    const specs = extractAccessGroupSpecs(makeCtx([{ name: 'g', fields: { name: '  Engineers  ', include_json: INCLUDE } }]).canvas)
    expect(specs[0].name).toBe('Engineers')
    expect(specs[0].includeJson).toBe(INCLUDE)
  })
})
