import validate, { extractAttributeSpecs, ATTRIBUTE_NAME_PATTERN } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'asset-attributes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'asset-attributes',
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

describe('Tenable Asset Attributes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid attribute with only a name', async () => {
    const result = await validate(makeCtx([{ name: 'Attribute', fields: { name: 'Owner' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid attribute with a name and description', async () => {
    const result = await validate(
      makeCtx([{ name: 'Attribute', fields: { name: 'cost_center', description: 'Billing owner' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('allows names with spaces, underscores and hyphens', async () => {
    const result = await validate(
      makeCtx([{ name: 'Attribute', fields: { name: 'Cost Center-2_test' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name with disallowed characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'owner@corp!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a name with a comma', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'a,b' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a duplicate attribute name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Owner' } },
        { name: 'sec2', fields: { name: 'Owner' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_attribute')).toBe(true)
  })

  it('treats names differing only in case as distinct', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Owner' } },
        { name: 'sec2', fields: { name: 'owner' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractAttributeSpecs', () => {
  it('trims fields and drops an empty description', () => {
    const specs = extractAttributeSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'asset-attributes',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Owner  ',
            description: '  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Owner')
    expect(specs[0].description).toBeUndefined()
  })
})

describe('ATTRIBUTE_NAME_PATTERN', () => {
  it('accepts letters, numbers, spaces, underscores and hyphens', () => {
    expect(ATTRIBUTE_NAME_PATTERN.test('Cost Center_2-a')).toBe(true)
  })
  it('rejects other punctuation', () => {
    expect(ATTRIBUTE_NAME_PATTERN.test('bad@name')).toBe(false)
  })
})
