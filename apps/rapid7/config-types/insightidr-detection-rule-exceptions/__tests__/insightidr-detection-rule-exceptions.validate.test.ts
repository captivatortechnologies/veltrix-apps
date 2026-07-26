import validate, { extractExceptionSpecs, exceptionKey, parseConditions } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightidr-detection-rule-exceptions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightidr-detection-rule-exceptions',
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

const simpleFields = (over: Record<string, unknown> = {}) => ({
  rule_name: 'Suspicious Authentication',
  name: 'Backup service account',
  type: 'SIMPLE',
  rule_action: 'OFF',
  key_value_json: '[{"key":"user","value":"svc-backup","operator":"IS"}]',
  ...over,
})

describe('InsightIDR Detection Rule Exceptions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid SIMPLE exception', async () => {
    const result = await validate(makeCtx([{ name: 'Exc', fields: simpleFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid LEQL exception', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Exc',
          fields: {
            rule_name: 'Suspicious Authentication',
            name: 'Scanner host',
            type: 'LEQL',
            rule_action: 'CREATES_INVESTIGATIONS',
            priority_level: 'LOW',
            leql: 'where(source_user_name = "svc-backup")',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing rule_name / name / rule_action', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { type: 'SIMPLE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_action'))).toBe(true)
  })

  it('rejects an unsupported rule action', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: simpleFields({ rule_action: 'NOPE' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_action')).toBe(true)
  })

  it('rejects an unsupported priority', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: simpleFields({ priority_level: 'URGENT' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('requires a LEQL query for a LEQL exception', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { rule_name: 'R', name: 'x', type: 'LEQL', rule_action: 'OFF' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('leql'))).toBe(true)
  })

  it('rejects malformed SIMPLE conditions (not an array)', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: simpleFields({ key_value_json: '{"key":"a"}' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('rejects a SIMPLE condition with an unsupported operator', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: simpleFields({ key_value_json: '[{"key":"u","value":"v","operator":"LIKE"}]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('rejects duplicate (rule, name) case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: simpleFields({ rule_name: 'Rule A', name: 'Dup' }) },
        { name: 'b', fields: simpleFields({ rule_name: 'rule a', name: 'dup' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_exception')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseConditions('  ').error).toBeNull()
    const parsed = parseConditions('[{"key":"user","value":"svc","operator":"is","case_sensitive":false}]')
    expect(parsed.error).toBeNull()
    expect(parsed.value?.[0]).toEqual({ key: 'user', value: 'svc', operator: 'IS', case_sensitive: false })
    const specs = extractExceptionSpecs(makeCtx([{ name: 'e', fields: simpleFields({ rule_name: '  Rule X  ' }) }]).canvas)
    expect(specs[0].ruleName).toBe('Rule X')
    expect(exceptionKey(specs[0])).toBe(exceptionKey({ ruleName: 'rule x', name: 'BACKUP SERVICE ACCOUNT' }))
  })
})
