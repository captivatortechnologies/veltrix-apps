import validate, { parseRuleSpecs, extractRuleGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'custom-ioa-rule-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'custom-ioa-rule-groups',
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

function validGroupFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Suspicious Scripting',
    platform: 'windows',
    enabled: true,
    rules: JSON.stringify([
      {
        name: 'Encoded PowerShell',
        ruletypeId: '5',
        dispositionId: 20,
        patternSeverity: 'high',
        enabled: true,
        fieldValues: [{ name: 'CommandLine', type: 'excludable', values: [{ label: 'include', value: '.*-enc.*' }] }],
      },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike Custom IOA Rule Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule group configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: validGroupFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing rule group name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects unknown platforms', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ platform: 'solaris' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('normalizes platform casing to the API lower case', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ platform: 'Windows' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when an enabled group declares no rules', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ rules: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_rules')).toBe(true)
  })

  it('rejects invalid rules JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ rules: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('rejects duplicate rule group names per platform', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validGroupFields() },
        { name: 'sec2', fields: validGroupFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same group name on different platforms', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validGroupFields() },
        { name: 'sec2', fields: validGroupFields({ platform: 'linux' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('parseRuleSpecs', () => {
  it('accepts a well-formed rule', () => {
    const { rules, errors } = parseRuleSpecs(
      JSON.stringify([
        { name: 'Rule A', ruletypeId: '5', dispositionId: 20, patternSeverity: 'high', enabled: true },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].dispositionId).toBe(20)
    expect(rules[0].fieldValues).toEqual([])
  })

  it('coerces a numeric-string dispositionId and stringifies a numeric ruletypeId', () => {
    const { rules, errors } = parseRuleSpecs(
      JSON.stringify([
        { name: 'Rule A', ruletypeId: 5, dispositionId: '30', patternSeverity: 'critical' },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(rules[0].ruletypeId).toBe('5')
    expect(rules[0].dispositionId).toBe(30)
    expect(rules[0].enabled).toBe(false)
  })

  it('rejects an unknown pattern severity', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([{ name: 'Rule A', ruletypeId: '5', dispositionId: 20, patternSeverity: 'urgent' }]),
    )
    expect(errors.some((e) => e.includes('patternSeverity'))).toBe(true)
  })

  it('rejects a non-integer dispositionId', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([{ name: 'Rule A', ruletypeId: '5', dispositionId: 'block', patternSeverity: 'high' }]),
    )
    expect(errors.some((e) => e.includes('dispositionId'))).toBe(true)
  })

  it('rejects a missing ruletypeId', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([{ name: 'Rule A', dispositionId: 20, patternSeverity: 'high' }]),
    )
    expect(errors.some((e) => e.includes('ruletypeId'))).toBe(true)
  })

  it('rejects fieldValues that are not an array', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([
        { name: 'Rule A', ruletypeId: '5', dispositionId: 20, patternSeverity: 'high', fieldValues: {} },
      ]),
    )
    expect(errors.some((e) => e.includes('fieldValues'))).toBe(true)
  })

  it('rejects duplicate rule names', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([
        { name: 'Rule A', ruletypeId: '5', dispositionId: 20, patternSeverity: 'high' },
        { name: 'Rule A', ruletypeId: '6', dispositionId: 30, patternSeverity: 'low' },
      ]),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('rejects a non-array rules payload', () => {
    const { errors } = parseRuleSpecs(JSON.stringify({ name: 'Rule A' }))
    expect(errors.some((e) => e.includes('must be a JSON array'))).toBe(true)
  })

  it('returns empty rules for empty input', () => {
    expect(parseRuleSpecs(undefined)).toEqual({ rules: [], errors: [] })
  })
})

describe('extractRuleGroupSpecs', () => {
  it('parses fields and normalizes platform casing', () => {
    const specs = extractRuleGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'custom-ioa-rule-groups',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: 'g1', platform: 'MAC', comment: 'audit note' } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('g1')
    expect(specs[0].platform).toBe('mac')
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].comment).toBe('audit note')
  })
})
