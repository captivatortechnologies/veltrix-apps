import validate, { extractIpsRuleSpecs, parsePositiveInt, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-firewall-ips-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-firewall-ips-rules',
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

const VALID_RULE_JSON = '{"srcIps":["10.0.0.0/8"],"destCountries":["COUNTRY_CN"],"nwServices":[{"id":774002}]}'

describe('ZIA Firewall IPS Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal rule (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: { name: 'Block Malware C2' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a full rule with order, state, action and advanced JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule',
          fields: {
            name: 'Inspect Outbound',
            order: 2,
            state: 'ENABLED',
            action: 'BLOCK_DROP',
            rule_json: VALID_RULE_JSON,
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
        { name: 'a', fields: { name: 'Egress' } },
        { name: 'b', fields: { name: 'egress' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ips_rule')).toBe(true)
  })

  it('rejects a non-positive-integer order', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('rejects a fractional order', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: '1.5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('accepts a blank order (defaults later to 1)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R', order: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects malformed advanced rule JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'R', rule_json: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('rejects advanced rule JSON that is an array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'R', rule_json: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })
})

describe('extractIpsRuleSpecs', () => {
  it('trims the name, defaults state/action, and drops blank rule JSON', () => {
    const specs = extractIpsRuleSpecs(
      makeCtx([{ name: 'Rule', fields: { name: '  Block C2  ', rule_json: '   ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Block C2')
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].action).toBe('ALLOW')
    expect(specs[0].ruleJson).toBeUndefined()
  })

  it('normalizes state/action to upper case and reads a numeric order', () => {
    const specs = extractIpsRuleSpecs(
      makeCtx([
        { name: 'Rule', fields: { name: 'R', order: 3, state: 'disabled', action: 'bypass_ips' } },
      ]).canvas,
    )
    expect(specs[0].order).toBe('3')
    expect(specs[0].state).toBe('DISABLED')
    expect(specs[0].action).toBe('BYPASS_IPS')
  })
})

describe('parsePositiveInt', () => {
  it('parses a positive integer', () => {
    expect(parsePositiveInt('5')).toBe(5)
  })
  it('rejects zero, negatives and fractions', () => {
    expect(parsePositiveInt('0')).toBe(null)
    expect(parsePositiveInt('-1')).toBe(null)
    expect(parsePositiveInt('2.5')).toBe(null)
  })
  it('treats blank as unset', () => {
    expect(parsePositiveInt('')).toBe(null)
  })
})

describe('parseRuleObject', () => {
  it('parses a JSON object', () => {
    expect(parseRuleObject('{"srcIps":["10.0.0.0/8"]}')).toEqual({ srcIps: ['10.0.0.0/8'] })
  })
  it('rejects a JSON array', () => {
    expect(parseRuleObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseRuleObject('{nope')).toBe(null)
  })
})
