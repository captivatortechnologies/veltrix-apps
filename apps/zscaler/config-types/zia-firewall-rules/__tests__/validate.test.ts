import validate, { extractFirewallRuleSpecs, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-firewall-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-firewall-rules',
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

describe('ZIA Firewall Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid firewall rule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Firewall Rule',
          fields: {
            name: 'Block Bad Nets',
            order: 1,
            state: 'ENABLED',
            action: 'BLOCK_DROP',
            rule_json: '{"srcIpGroups":[{"id":123}]}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'ALLOW' } }]))
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
        { name: 'a', fields: { name: 'Egress Block' } },
        { name: 'b', fields: { name: 'egress block' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_firewall_rule')).toBe(true)
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

  it('extractFirewallRuleSpecs trims name, parses order, and applies state/action defaults', () => {
    const specs = extractFirewallRuleSpecs(
      makeCtx([{ name: 'Firewall Rule', fields: { name: '  Corp Egress  ', order: '5' } }]).canvas,
    )
    expect(specs[0].name).toBe('Corp Egress')
    expect(specs[0].order).toBe(5)
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].action).toBe('BLOCK_DROP')
    expect(specs[0].ruleJson).toBeUndefined()
  })

  it('parseRuleObject returns objects and rejects arrays/primitives', () => {
    expect(parseRuleObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseRuleObject('[1,2]')).toBeNull()
    expect(parseRuleObject('42')).toBeNull()
    expect(parseRuleObject('nope')).toBeNull()
  })
})
