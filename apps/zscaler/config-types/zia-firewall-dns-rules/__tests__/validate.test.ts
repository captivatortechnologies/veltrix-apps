import validate, { extractDnsRuleSpecs, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-firewall-dns-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-firewall-dns-rules',
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

const VALID_RULE_JSON = '{"srcIps":["10.0.0.0/8"],"dnsRuleRequestTypes":["A","AAAA"]}'

describe('ZIA Firewall DNS Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid DNS rule (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'DNS Rule', fields: { name: 'Block Bad DNS' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a DNS rule with all scalars and a JSON body', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'DNS Rule',
          fields: {
            name: 'Redirect Corp DNS',
            order: 2,
            state: 'ENABLED',
            action: 'REDIR_REQ',
            rule_json: VALID_RULE_JSON,
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

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'DNS Guard' } },
        { name: 'b', fields: { name: 'dns guard' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_dns_rule')).toBe(true)
  })

  it('rejects a non-positive / non-integer order', async () => {
    const zero = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R1', order: 0 } }]))
    expect(zero.valid).toBe(false)
    expect(zero.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const fractional = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R2', order: 1.5 } }]))
    expect(fractional.valid).toBe(false)
    expect(fractional.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const nonNumeric = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R3', order: 'abc' } }]))
    expect(nonNumeric.valid).toBe(false)
    expect(nonNumeric.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('accepts a blank order (defaults applied at deploy)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R1', order: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects rule_json that is not a JSON object', async () => {
    const malformed = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'R1', rule_json: '{not json' } }]),
    )
    expect(malformed.valid).toBe(false)
    expect(malformed.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)

    const array = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R2', rule_json: '[1,2,3]' } }]))
    expect(array.valid).toBe(false)
    expect(array.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })
})

describe('extractDnsRuleSpecs', () => {
  it('trims the name, defaults state/action, and drops a blank rule_json', () => {
    const specs = extractDnsRuleSpecs(
      makeCtx([{ name: 'DNS Rule', fields: { name: '  Block Bad DNS  ', rule_json: '   ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Block Bad DNS')
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].action).toBe('ALLOW')
    expect(specs[0].ruleJson).toBeUndefined()
    expect(specs[0].order).toBeUndefined()
  })

  it('parses a numeric string order', () => {
    const specs = extractDnsRuleSpecs(
      makeCtx([{ name: 'DNS Rule', fields: { name: 'R1', order: '3' } }]).canvas,
    )
    expect(specs[0].order).toBe(3)
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
