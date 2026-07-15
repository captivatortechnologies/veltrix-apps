import validate, {
  extractUrlFilteringRuleSpecs,
  parseRuleObject,
  parseOrderValue,
  resolveOrder,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-url-filtering-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-url-filtering-rules',
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

const VALID_RULE_JSON = '{"urlCategories":["OTHER_ADULT_MATERIAL"],"groups":[{"id":45}]}'

describe('ZIA URL Filtering Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule',
          fields: {
            name: 'Block Adult Content',
            order: 1,
            state: 'ENABLED',
            action: 'BLOCK',
            protocols: 'ANY_RULE',
            rule_json: VALID_RULE_JSON,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid rule with no rule_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'Rule', fields: { name: 'Allow Corp', action: 'ALLOW' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'BLOCK' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Block Adult Content' } },
        { name: 'b', fields: { name: 'block adult content' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_url_filtering_rule')).toBe(true)
  })

  it('rejects an invalid rule_json (malformed)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Rule A', rule_json: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('rejects a rule_json that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Rule A', rule_json: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('rejects a non-positive-integer order', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule A', order: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('rejects a fractional order', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule A', order: 1.5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('accepts a numeric-string order', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule A', order: '3' } }]))
    expect(result.valid).toBe(true)
  })
})

describe('extractUrlFilteringRuleSpecs', () => {
  it('trims name, splits protocols, defaults state/action, drops blank rule_json', () => {
    const specs = extractUrlFilteringRuleSpecs(
      makeCtx([
        {
          name: 'Rule',
          fields: {
            name: '  Block Adult Content  ',
            protocols: 'HTTP_RULE\n  HTTPS_RULE  \n\n',
            rule_json: '   ',
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Block Adult Content')
    expect(specs[0].protocols).toEqual(['HTTP_RULE', 'HTTPS_RULE'])
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].action).toBe('BLOCK')
    expect(specs[0].ruleJson).toBeUndefined()
  })

  it('resolveOrder falls back to 1 when unset or invalid', () => {
    const specs = extractUrlFilteringRuleSpecs(
      makeCtx([
        { name: 'a', fields: { name: 'A' } },
        { name: 'b', fields: { name: 'B', order: 5 } },
      ]).canvas,
    )
    expect(resolveOrder(specs[0])).toBe(1)
    expect(resolveOrder(specs[1])).toBe(5)
  })
})

describe('parseRuleObject', () => {
  it('parses a JSON object', () => {
    expect(parseRuleObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseRuleObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseRuleObject('{nope')).toBe(null)
  })
})

describe('parseOrderValue', () => {
  it('accepts a positive integer', () => {
    expect(parseOrderValue(4)).toBe(4)
  })
  it('accepts a positive integer string', () => {
    expect(parseOrderValue('4')).toBe(4)
  })
  it('rejects zero, negatives and fractions', () => {
    expect(parseOrderValue(0)).toBe(null)
    expect(parseOrderValue(-2)).toBe(null)
    expect(parseOrderValue(1.5)).toBe(null)
    expect(parseOrderValue('abc')).toBe(null)
  })
})
