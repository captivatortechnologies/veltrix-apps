import validate, { extractSslRuleSpecs, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-ssl-inspection-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-ssl-inspection-rules',
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

const DECRYPT_JSON = '{"action":{"type":"DECRYPT"},"srcIps":["10.0.0.0/8"]}'
const NO_ACTION_JSON = '{"srcIps":["10.0.0.0/8"],"urlCategories":["FINANCE"]}'

describe('ZIA SSL Inspection Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid SSL inspection rule (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'SSL Rule', fields: { name: 'Decrypt Corp' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates an SSL rule with an action object in rule_json (no warnings)', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'SSL Rule',
          fields: { name: 'Decrypt Corp', order: 2, state: 'ENABLED', rule_json: DECRYPT_JSON },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns when rule_json lacks an action key (still valid)', async () => {
    const result = await validate(
      makeCtx([{ name: 'SSL Rule', fields: { name: 'No Action', rule_json: NO_ACTION_JSON } }]),
    )
    // A missing action is a non-blocking warning, not a hard error.
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.some((w) => w.code === 'missing_ssl_action')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { state: 'ENABLED' } }]))
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
        { name: 'a', fields: { name: 'Decrypt All' } },
        { name: 'b', fields: { name: 'decrypt all' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ssl_rule')).toBe(true)
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
    expect(malformed.errors.some((e) => e.code === 'invalid_ssl_rule_json')).toBe(true)

    const array = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R2', rule_json: '[1,2,3]' } }]))
    expect(array.valid).toBe(false)
    expect(array.errors.some((e) => e.code === 'invalid_ssl_rule_json')).toBe(true)
  })
})

describe('extractSslRuleSpecs', () => {
  it('trims the name, defaults state, and drops a blank rule_json', () => {
    const specs = extractSslRuleSpecs(
      makeCtx([{ name: 'SSL Rule', fields: { name: '  Decrypt Corp  ', rule_json: '   ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Decrypt Corp')
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].ruleJson).toBeUndefined()
    expect(specs[0].order).toBeUndefined()
  })

  it('parses a numeric string order', () => {
    const specs = extractSslRuleSpecs(
      makeCtx([{ name: 'SSL Rule', fields: { name: 'R1', order: '3' } }]).canvas,
    )
    expect(specs[0].order).toBe(3)
  })
})

describe('parseRuleObject', () => {
  it('parses a JSON object holding an action', () => {
    expect(parseRuleObject('{"action":{"type":"DO_NOT_DECRYPT"}}')).toEqual({
      action: { type: 'DO_NOT_DECRYPT' },
    })
  })
  it('rejects a JSON array', () => {
    expect(parseRuleObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseRuleObject('{nope')).toBe(null)
  })
})
