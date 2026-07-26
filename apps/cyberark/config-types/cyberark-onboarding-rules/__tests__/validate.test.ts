import validate, { extractOnboardingRuleSpecs, ruleKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-onboarding-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-onboarding-rules',
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
  rule_name: 'Onboard Windows Servers',
  target_platform_id: 'WinServerLocal',
  target_safe_name: 'Discovered-Windows',
  system_type_filter: 'Windows',
}

describe('CyberArk Onboarding Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'R', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires rule name, target platform and target safe', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { system_type_filter: 'Unix' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('target_platform_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('target_safe_name'))).toBe(true)
  })

  it('rejects an unsupported system type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, system_type_filter: 'macOS' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_system_type')).toBe(true)
  })

  it('rejects an unsupported machine type and match method', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, machine_type_filter: 'Phone', address_method: 'Contains' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_machine_type')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_match_method')).toBe(true)
  })

  it('rejects a rule name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, rule_name: 'A'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'rule_name_too_long')).toBe(true)
  })

  it('rejects duplicate rule names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, rule_name: 'Rule-A' } },
        { name: 'b', fields: { ...validFields, rule_name: 'rule-a' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extracts specs with defaults + helpers', () => {
    const specs = extractOnboardingRuleSpecs(
      makeCtx([
        {
          name: 'r',
          fields: {
            rule_name: '  Onboard Unix  ',
            target_platform_id: 'UnixSSH',
            target_safe_name: 'Discovered-Unix',
            system_type_filter: 'Unix',
            is_admin_id_filter: 'true',
            user_name_filter: '  root  ',
            user_name_method: 'Begins',
          },
        },
      ]).canvas,
    )
    expect(specs[0].ruleName).toBe('Onboard Unix')
    expect(specs[0].systemTypeFilter).toBe('Unix')
    expect(specs[0].machineTypeFilter).toBe('Any')
    expect(specs[0].accountCategoryFilter).toBe('Any')
    expect(specs[0].isAdminIdFilter).toBe(true)
    expect(specs[0].userNameFilter).toBe('root')
    expect(specs[0].userNameMethod).toBe('Begins')
    expect(specs[0].addressMethod).toBe('Equals')
    expect(ruleKey(specs[0])).toBe(ruleKey({ ruleName: 'onboard unix' }))
  })
})
