import validate, {
  extractPolicyRuleSpecs,
  isDefaultRule,
  parsePolicyConditions,
  readNumber,
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
    configTypeId: 'zpa-policy-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zpa-policy-rules',
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

describe('ZPA Policy Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid access-policy rule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule 1',
          fields: {
            name: 'Allow Corp Apps',
            policy_type: 'ACCESS_POLICY',
            action: 'ALLOW',
            conditions_json: '[{"operator":"OR","operands":[{"objectType":"APP","lhs":"id","rhs":"1"}]}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { policy_type: 'ACCESS_POLICY' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an invalid policy_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'R', policy_type: 'BOGUS_POLICY' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_type')).toBe(true)
  })

  it('rejects a missing policy_type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'R' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policy_type'))).toBe(true)
  })

  it('rejects a duplicate (policy_type, name) pair (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Allow Apps', policy_type: 'ACCESS_POLICY' } },
        { name: 'b', fields: { name: 'allow apps', policy_type: 'ACCESS_POLICY' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy_rule')).toBe(true)
  })

  it('allows the same name under two different policy types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Shared Name', policy_type: 'ACCESS_POLICY' } },
        { name: 'b', fields: { name: 'Shared Name', policy_type: 'TIMEOUT_POLICY' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects conditions_json that is an object, not an array', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: {
            name: 'Bad Conditions',
            policy_type: 'ACCESS_POLICY',
            conditions_json: '{"operator":"OR"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('rejects conditions_json that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: { name: 'Broken JSON', policy_type: 'ACCESS_POLICY', conditions_json: 'not json' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('parses conditions, defaults rule_order, and detects default rules', () => {
    // Blank conditions => empty array; a valid array passes through.
    expect(parsePolicyConditions('')).toEqual([])
    expect(parsePolicyConditions('[{"operator":"OR"}]')).toEqual([{ operator: 'OR' }])
    // rule_order defaults to 1 when unset.
    expect(readNumber(undefined, 1)).toBe(1)
    expect(readNumber('5', 1)).toBe(5)
    const specs = extractPolicyRuleSpecs(
      makeCtx([{ name: 'g', fields: { name: 'X', policy_type: 'ACCESS_POLICY' } }]).canvas,
    )
    expect(specs[0].ruleOrder).toBe(1)
    expect(specs[0].policyType).toBe('ACCESS_POLICY')
    // Default/catch-all rule detection guards deploy from touching it.
    expect(isDefaultRule({ defaultRule: true })).toBe(true)
    expect(isDefaultRule({ isDefault: true })).toBe(true)
    expect(isDefaultRule({ name: 'Regular' })).toBe(false)
  })
})
