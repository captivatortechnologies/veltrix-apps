import validate, { extractTagSpecs, parseFilterObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
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

const VALID_FILTER = '{"asset":{"and":[{"field":"ipv4","operator":"eq","value":"10.0.0.0/8"}]}}'

describe('Tenable Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid static tag', async () => {
    const result = await validate(
      makeCtx([{ name: 'Tag', fields: { category: 'Environment', value: 'Production' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid dynamic tag with a JSON asset filter', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Tag', fields: { category: 'Environment', value: 'Production', filters: VALID_FILTER } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing category', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { value: 'Production' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('category'))).toBe(true)
  })

  it('rejects a missing value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { category: 'Environment' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('value'))).toBe(true)
  })

  it('rejects a value longer than 50 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { category: 'Environment', value: 'x'.repeat(51) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a value containing a comma', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { category: 'Environment', value: 'Prod,Staging' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects an invalid JSON asset filter', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { category: 'Environment', value: 'Production', filters: '{not json' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filters')).toBe(true)
  })

  it('rejects an asset filter that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { category: 'Environment', value: 'Production', filters: '[1,2,3]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filters')).toBe(true)
  })

  it('rejects a duplicate (category, value) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { category: 'Environment', value: 'Production' } },
        { name: 'sec2', fields: { category: 'Environment', value: 'Production' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_tag')).toBe(true)
  })

  it('allows the same value under different categories', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { category: 'Environment', value: 'Production' } },
        { name: 'sec2', fields: { category: 'Tier', value: 'Production' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractTagSpecs', () => {
  it('trims fields and drops empty optional values', () => {
    const specs = extractTagSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'tags',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            category: '  Environment  ',
            value: '  Production  ',
            description: '  ',
            filters: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].category).toBe('Environment')
    expect(specs[0].value).toBe('Production')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].filters).toBeUndefined()
  })
})

describe('parseFilterObject', () => {
  it('parses a JSON object', () => {
    expect(parseFilterObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseFilterObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseFilterObject('{nope')).toBe(null)
  })
})
