import validate, {
  extractForwardingRuleSpecs,
  isProtectedRuleName,
  parseRuleObject,
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
    configTypeId: 'zia-forwarding-control-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-forwarding-control-rules',
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

describe('ZIA Forwarding Control Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid forwarding rule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Forwarding Rule',
          fields: {
            name: 'Route Branch Traffic To ZPA',
            order: 1,
            state: 'ENABLED',
            type: 'FORWARDING',
            forward_method: 'ZPA',
            rule_json: '{"zpaGateway":{"id":123}}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { forward_method: 'DIRECT' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a predefined/protected rule name', async () => {
    const exact = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'ZPA Pool For Stray Traffic' } }]),
    )
    expect(exact.valid).toBe(false)
    expect(exact.errors.some((e) => e.code === 'protected_rule_name')).toBe(true)

    // Case-insensitive match, since ZIA itself rejects names differing only in case.
    const lower = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'client connector traffic direct' } }]),
    )
    expect(lower.errors.some((e) => e.code === 'protected_rule_name')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Egress Direct' } },
        { name: 'b', fields: { name: 'egress direct' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_forwarding_rule')).toBe(true)
  })

  it('rejects a non-positive / non-integer order', async () => {
    const zero = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: 0 } }]))
    expect(zero.valid).toBe(false)
    expect(zero.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const fractional = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: 1.5 } }]))
    expect(fractional.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const nonNumeric = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: 'abc' } }]))
    expect(nonNumeric.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('rejects an invalid rule type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'R', type: 'NOT_A_TYPE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_type')).toBe(true)
  })

  it('rejects an invalid forward method', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'R', forward_method: 'TELEPORT' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_forward_method')).toBe(true)
  })

  it('rejects rule_json that is not a JSON object', async () => {
    const arr = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', rule_json: '[1,2,3]' } }]))
    expect(arr.valid).toBe(false)
    expect(arr.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)

    const malformed = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', rule_json: '{not json' } }]))
    expect(malformed.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('accepts a blank order and rule_json (both optional)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: '', rule_json: '  ' } }]))
    expect(result.valid).toBe(true)
  })

  it('extractForwardingRuleSpecs trims name, parses order, and applies defaults', () => {
    const specs = extractForwardingRuleSpecs(
      makeCtx([{ name: 'Forwarding Rule', fields: { name: '  Corp Direct  ', order: '5' } }]).canvas,
    )
    expect(specs[0].name).toBe('Corp Direct')
    expect(specs[0].order).toBe(5)
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].type).toBe('FORWARDING')
    expect(specs[0].forwardMethod).toBe('DIRECT')
    expect(specs[0].ruleJson).toBeUndefined()
  })

  it('isProtectedRuleName matches the known predefined rules case-insensitively', () => {
    expect(isProtectedRuleName('ZPA Pool For Stray Traffic')).toBe(true)
    expect(isProtectedRuleName('zia inspected zpa apps')).toBe(true)
    expect(isProtectedRuleName('Fallback mode of ZPA Forwarding')).toBe(true)
    expect(isProtectedRuleName('My Custom Rule')).toBe(false)
  })

  it('parseRuleObject returns objects and rejects arrays/primitives', () => {
    expect(parseRuleObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseRuleObject('[1,2]')).toBeNull()
    expect(parseRuleObject('42')).toBeNull()
    expect(parseRuleObject('nope')).toBeNull()
  })
})
