import validate, { extractSecurityFrameworkSpecs, frameworkKey, readBool, tryParseJson } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-security-frameworks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-security-frameworks',
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

const validCategories = JSON.stringify([
  { name: 'Access Control', subCategories: [{ title: 'MFA', description: 'Enforce MFA everywhere' }] },
])

const validFields = {
  name: 'Internal Baseline',
  categories: validCategories,
}

describe('Wiz Security Frameworks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid framework', async () => {
    const result = await validate(makeCtx([{ name: 'FW', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name and categories', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('categories'))).toBe(true)
  })

  it('rejects malformed categories JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, categories: '[not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects categories that are not a non-empty array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, categories: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_categories')).toBe(true)
  })

  it('requires each category to have a name and sub-categories', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, categories: JSON.stringify([{ subCategories: [] }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('.name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_categories' && e.field.includes('subCategories'))).toBe(true)
  })

  it('requires each sub-category to have a title and description', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { ...validFields, categories: JSON.stringify([{ name: 'C1', subCategories: [{ title: 'only-title' }] }]) },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('description'))).toBe(true)
  })

  it('rejects duplicate framework names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'PCI Local' } },
        { name: 'b', fields: { ...validFields, name: 'pci local' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_framework')).toBe(true)
  })

  it('extractSecurityFrameworkSpecs trims, defaults enabled and parses categories', () => {
    const specs = extractSecurityFrameworkSpecs(
      makeCtx([{ name: 'e', fields: { name: '  FW X  ', categories: validCategories } }]).canvas,
    )
    expect(specs[0].name).toBe('FW X')
    expect(specs[0].enabled).toBe(true)
    expect(Array.isArray(specs[0].categories)).toBe(true)
    expect(frameworkKey('  FW X ')).toBe('fw x')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('[bad').ok).toBe(false)
    expect(tryParseJson('[{"a":1}]').value).toEqual([{ a: 1 }])
  })
})
