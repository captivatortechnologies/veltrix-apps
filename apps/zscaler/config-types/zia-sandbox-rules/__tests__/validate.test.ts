import validate, { extractSandboxRuleSpecs, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-sandbox-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-sandbox-rules',
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

/** A rule whose rule_json carries a ba_rule_action, so no missing_action warning. */
function ruleFields(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, rule_json: '{"ba_rule_action": "BLOCK"}', ...extra }
}

describe('ZIA Sandbox Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid sandbox rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Sandbox Rule', fields: ruleFields('Block Malware', { order: 1, state: 'ENABLED' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { rule_json: '{}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: ruleFields('Sandbox') },
        { name: 'b', fields: ruleFields('sandbox') },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_sandbox_rule')).toBe(true)
  })

  it('rejects a non-positive / non-integer order', async () => {
    const zero = await validate(makeCtx([{ name: 'sec1', fields: ruleFields('R1', { order: 0 }) }]))
    expect(zero.valid).toBe(false)
    expect(zero.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const fractional = await validate(makeCtx([{ name: 'sec2', fields: ruleFields('R2', { order: '2.5' }) }]))
    expect(fractional.valid).toBe(false)
    expect(fractional.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('rejects rule_json that is not a JSON object', async () => {
    const malformed = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R1', rule_json: '{not json' } }]))
    expect(malformed.valid).toBe(false)
    expect(malformed.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)

    const array = await validate(makeCtx([{ name: 'sec2', fields: { name: 'R2', rule_json: '[1,2,3]' } }]))
    expect(array.valid).toBe(false)
    expect(array.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('warns (but stays valid) when rule_json omits ba_rule_action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R1', rule_json: '{"order": 1}' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_action')).toBe(true)
  })

  it('extractSandboxRuleSpecs applies defaults and parses the escape hatch', () => {
    const specs = extractSandboxRuleSpecs(
      makeCtx([
        { name: 'Sandbox Rule', fields: { name: '  Block  ', rule_json: '{"ba_rule_action": "BLOCK"}' } },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Block')
    expect(specs[0].order).toBe(1) // default when unset
    expect(specs[0].state).toBe('ENABLED') // default when unset
    expect(specs[0].ruleJson).toEqual({ ba_rule_action: 'BLOCK' })
    expect(specs[0].ruleJsonInvalid).toBe(false)
  })

  it('parseRuleObject distinguishes blank, valid object, and invalid input', () => {
    expect(parseRuleObject('')).toEqual({ present: false, invalid: false })
    expect(parseRuleObject('   ')).toEqual({ present: false, invalid: false })
    expect(parseRuleObject('{"a":1}')).toEqual({ present: true, invalid: false, value: { a: 1 } })
    expect(parseRuleObject('nope').invalid).toBe(true)
    expect(parseRuleObject('42').invalid).toBe(true)
  })
})
