import validate, { extractHostConfigRuleSpecs, readBool, ruleKey, strList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-host-config-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-host-config-rules',
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

const validFields = {
  name: 'CIS - Ensure password expiration is 90 days or less',
  target_platform_ids: ['tech-linux-1'],
  direct_oval: '<oval_definitions>...</oval_definitions>',
}

describe('Wiz Host Configuration Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'R1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, target platforms and OVAL definition', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('target_platform_ids'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('direct_oval'))).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Dup Rule' } },
        { name: 'b', fields: { ...validFields, name: 'dup rule' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractHostConfigRuleSpecs trims and defaults enabled', () => {
    const specs = extractHostConfigRuleSpecs(makeCtx([{ name: 'e', fields: { ...validFields, name: '  Rule X  ' } }]).canvas)
    expect(specs[0].name).toBe('Rule X')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].targetPlatformIds).toEqual(['tech-linux-1'])
    expect(ruleKey('  Rule X ')).toBe('rule x')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(strList('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(strList(['a', ' b '])).toEqual(['a', 'b'])
    expect(strList(undefined)).toEqual([])
  })
})
