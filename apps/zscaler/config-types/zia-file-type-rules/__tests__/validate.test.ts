import validate, { extractFileTypeRuleSpecs, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-file-type-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-file-type-rules',
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

describe('ZIA File Type Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a rule with an action and a rule_json body', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'File Type Control Rule',
          fields: {
            name: 'Block Executables',
            order: 1,
            state: 'ENABLED',
            action: 'BLOCK',
            rule_json: '{"fileTypes":["FTCATEGORY_WINDOWS_EXECUTABLES"]}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'BLOCK' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Block PDF' } },
        { name: 'b', fields: { name: 'block pdf' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_file_type_rule')).toBe(true)
  })

  it('rejects a non-positive / non-integer order', async () => {
    const zero = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R1', order: 0 } }]))
    expect(zero.valid).toBe(false)
    expect(zero.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const fractional = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R2', order: '1.5' } }]))
    expect(fractional.valid).toBe(false)
    expect(fractional.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('rejects rule_json that is not a JSON object', async () => {
    const array = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R1', rule_json: '["a","b"]' } }]))
    expect(array.valid).toBe(false)
    expect(array.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)

    const malformed = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R2', rule_json: '{not json}' } }]))
    expect(malformed.valid).toBe(false)
    expect(malformed.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('accepts a rule with no order and no rule_json (deploy defaults apply)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Simple Rule' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('extractFileTypeRuleSpecs parses order, defaults scalars and the JSON body', () => {
    const specs = extractFileTypeRuleSpecs(
      makeCtx([
        {
          name: 'File Type Control Rule',
          fields: { name: '  Block Docs  ', order: '3', rule_json: '{"fileTypes":["FTCATEGORY_MS_WORD"]}' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Block Docs')
    expect(specs[0].order).toBe(3)
    // Unset selects fall back to their documented defaults.
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].action).toBe('BLOCK')
    expect(specs[0].ruleJson).toEqual({ fileTypes: ['FTCATEGORY_MS_WORD'] })
  })

  it('parseRuleObject rejects arrays and primitives but accepts objects', () => {
    expect(parseRuleObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseRuleObject('[1,2]')).toBeNull()
    expect(parseRuleObject('"str"')).toBeNull()
    expect(parseRuleObject('   ')).toBeNull()
    expect(parseRuleObject('nope')).toBeNull()
  })
})
