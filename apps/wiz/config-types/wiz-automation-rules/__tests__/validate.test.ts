import validate, {
  extractAutomationRuleSpecs,
  ruleKey,
  readBool,
  strList,
  tryParseJson,
  isJsonObject,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-automation-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-automation-rules',
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
  name: 'Notify Slack on new critical issues',
  trigger_source: 'ISSUES',
  trigger_types: ['CREATED'],
  integration_id: 'int-123',
  action_template_type: 'SLACK',
}

describe('Wiz Automation Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, integration id and action type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { trigger_source: 'ISSUES', trigger_types: ['CREATED'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('integration_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('action_template_type'))).toBe(true)
  })

  it('requires at least one trigger type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, trigger_types: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('trigger_types'))).toBe(true)
  })

  it('rejects an unsupported trigger source', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, trigger_source: 'ALERTS' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_trigger_source')).toBe(true)
  })

  it('rejects an unsupported trigger type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, trigger_types: ['CREATED', 'ARCHIVED'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_trigger_type')).toBe(true)
  })

  it('rejects an unsupported action type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, action_template_type: 'CARRIER_PIGEON' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action_type')).toBe(true)
  })

  it('rejects malformed filters JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, filters: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('filters'))).toBe(true)
  })

  it('rejects non-object action params JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, action_template_params: '"just-a-string"' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action_params')).toBe(true)
  })

  it('accepts a valid filters + action params pair', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { ...validFields, filters: '{"severity":["CRITICAL"]}', action_template_params: '{"slack":{"note":"hi"}}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Notify Ops' } },
        { name: 'b', fields: { ...validFields, name: 'notify ops' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractAutomationRuleSpecs trims, defaults and reads lists', () => {
    const specs = extractAutomationRuleSpecs(
      makeCtx([
        {
          name: 'e',
          fields: {
            name: '  Rule Z  ',
            trigger_types: 'CREATED, UPDATED',
            integration_id: '  int-9  ',
            action_template_type: 'WEBHOOK',
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Rule Z')
    expect(specs[0].triggerSource).toBe('ISSUES')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].triggerTypes).toEqual(['CREATED', 'UPDATED'])
    expect(specs[0].integrationId).toBe('int-9')
    expect(ruleKey('  Rule Z ')).toBe('rule z')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(strList(['a', ' b '])).toEqual(['a', 'b'])
    expect(strList('a,b, ')).toEqual(['a', 'b'])
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('{bad').ok).toBe(false)
    expect(tryParseJson('{"a":1}').value).toEqual({ a: 1 })
    expect(isJsonObject({ a: 1 })).toBe(true)
    expect(isJsonObject([1, 2])).toBe(false)
    expect(isJsonObject('x')).toBe(false)
  })
})
