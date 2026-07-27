import validate, {
  canonicalJson,
  extractIdpRuleSpecs,
  parseConditions,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'idp-policy-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'idp-policy-rules',
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

function validRuleFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Challenge admins over LDAP',
    enabled: true,
    simulationMode: false,
    action: 'MFA',
    ...overrides,
  }
}

describe('CrowdStrike IDP Policy Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validRuleFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a rule with a conditions tree', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule',
          fields: validRuleFields({
            conditions: '{"sourceUser":{"groupMembership":{"include":["Domain Admins"]}}}',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing rule name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validRuleFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown action', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ action: 'quarantine' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('accepts lowercase action input (normalized to uppercase)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ action: 'deny' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate rule names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validRuleFields() },
        { name: 'sec2', fields: validRuleFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ name: 'x'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects conditions that are not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ conditions: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('rejects conditions that are a JSON array instead of an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ conditions: '[1,2,3]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('warns when reserved keys appear inside the conditions JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validRuleFields({ conditions: '{"name":"override","activity":{}}' }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'reserved_condition_keys')).toBe(true)
  })

  it('warns when the conditions JSON has no usable keys', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ conditions: '{}' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_conditions')).toBe(true)
  })

  it('warns when two rules share a precedence value', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validRuleFields({ name: 'A', precedence: '5' }) },
        { name: 'sec2', fields: validRuleFields({ name: 'B', precedence: '5' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_precedence')).toBe(true)
  })

  it('warns when an enforcing rule is enabled but in simulation mode', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validRuleFields({ action: 'DENY', enabled: true, simulationMode: true }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'simulation_no_enforce')).toBe(true)
  })
})

describe('extractIdpRuleSpecs', () => {
  it('normalizes action to uppercase and coerces checkbox/precedence values', () => {
    const specs = extractIdpRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'idp-policy-rules',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: 'Rule A',
            action: 'mfa',
            precedence: '3',
            enabled: 'false',
            simulationMode: 'true',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].action).toBe('MFA')
    expect(specs[0].precedence).toBe(3)
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].simulationMode).toBe(true)
  })

  it('leaves precedence undefined when it is blank or non-numeric', () => {
    const specs = extractIdpRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'idp-policy-rules',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Rule', precedence: 'abc' } }],
      snapshot: {},
    })
    expect(specs[0].precedence).toBeUndefined()
  })
})

describe('parseConditions', () => {
  it('strips reserved keys and keeps condition keys', () => {
    const result = parseConditions('{"name":"x","action":"DENY","activity":{"accessType":{"include":["LDAP"]}}}')
    expect(result.errors).toHaveLength(0)
    expect(result.reservedKeysFound).toContain('name')
    expect(result.reservedKeysFound).toContain('action')
    expect(result.conditions.name).toBeUndefined()
    expect(result.conditions.activity).toBeDefined()
  })

  it('returns an error for invalid JSON', () => {
    const result = parseConditions('nope')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/not valid JSON/)
  })

  it('returns empty conditions for undefined input', () => {
    const result = parseConditions(undefined)
    expect(result.errors).toHaveLength(0)
    expect(Object.keys(result.conditions)).toHaveLength(0)
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively for stable comparison', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}')
  })

  it('is order-insensitive for equal objects', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })
})
