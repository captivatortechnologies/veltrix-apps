import validate, { extractWebDlpRuleSpecs, parseRuleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-web-dlp-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-web-dlp-rules',
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

describe('ZIA Web DLP Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid web DLP rule with a JSON escape hatch', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule 1',
          fields: {
            name: 'Block PII Upload',
            order: 1,
            action: 'BLOCK',
            state: 'ENABLED',
            protocols: 'ANY_RULE',
            rule_json: '{"dlpEngines":[{"id":42}],"labels":[{"id":7}]}',
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
        { name: 'a', fields: { name: 'Block Upload' } },
        { name: 'b', fields: { name: 'block upload' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_web_dlp_rule')).toBe(true)
  })

  it('rejects a non-positive / non-integer order', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule', order: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_order')).toBe(true)

    const fractional = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule', order: '2.5' } }]))
    expect(fractional.valid).toBe(false)
    expect(fractional.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('accepts a blank order and a blank rule_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Minimal Rule', order: '', rule_json: '  ' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects rule_json that is not a JSON object', async () => {
    const notObject = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule', rule_json: '[1,2,3]' } }]))
    expect(notObject.valid).toBe(false)
    expect(notObject.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)

    const malformed = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Rule', rule_json: '{not json}' } }]))
    expect(malformed.valid).toBe(false)
    expect(malformed.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('extractWebDlpRuleSpecs applies defaults for order/state/action/protocols', () => {
    const specs = extractWebDlpRuleSpecs(
      makeCtx([{ name: 'Rule 1', fields: { name: '  Block Upload  ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Block Upload')
    expect(specs[0].order).toBeUndefined()
    expect(specs[0].state).toBe('ENABLED')
    expect(specs[0].action).toBe('BLOCK')
    expect(specs[0].protocols).toEqual(['ANY_RULE'])
    expect(specs[0].ruleJson).toBeUndefined()
  })

  it('parseRuleObject accepts objects and rejects arrays/primitives', () => {
    expect(parseRuleObject('{"dlpEngines":[]}')).toEqual({ dlpEngines: [] })
    expect(parseRuleObject('[]')).toBeNull()
    expect(parseRuleObject('42')).toBeNull()
    expect(parseRuleObject('nope')).toBeNull()
  })
})
