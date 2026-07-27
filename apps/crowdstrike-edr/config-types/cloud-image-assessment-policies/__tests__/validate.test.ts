import validate, {
  extractImagePolicySpecs,
  parseImagePolicyConditions,
  buildPolicyData,
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
    configTypeId: 'cloud-image-assessment-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-image-assessment-policies',
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

function validPolicyFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Block Critical CVEs',
    description: 'Fail images with critical CVEs',
    action: 'prevent',
    enabled: true,
    rules: JSON.stringify([
      { type: 'cve', value: 'critical' },
      { type: 'malware', value: true },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike Image Assessment Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid policy configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Policy', fields: validPolicyFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing policy name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects the reserved Default policy name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: 'default' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects an invalid action', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ action: 'quarantine' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('normalizes action casing to lowercase', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ action: 'PREVENT' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects rules that are not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ rules: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('rejects rules that are not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ rules: '{"type":"cve"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('warns when a prevent policy has no conditions', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ rules: '[]' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'prevent_without_conditions')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractImagePolicySpecs', () => {
  it('extracts name, action, enabled and rules from a section', () => {
    const specs = extractImagePolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-image-assessment-policies',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: 'P1', action: 'Alert', enabled: false, rules: '[]' } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('P1')
    expect(specs[0].action).toBe('alert')
    expect(specs[0].enabled).toBe(false)
  })

  it('defaults action to alert and enabled to true when unset', () => {
    const specs = extractImagePolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-image-assessment-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'P1' } }],
      snapshot: {},
    })
    expect(specs[0].action).toBe('alert')
    expect(specs[0].enabled).toBe(true)
  })
})

describe('parseImagePolicyConditions', () => {
  it('returns empty for empty input', () => {
    expect(parseImagePolicyConditions(undefined)).toEqual({ conditions: [], errors: [] })
  })

  it('parses an array of condition objects', () => {
    const { conditions, errors } = parseImagePolicyConditions(
      JSON.stringify([{ type: 'cve', value: 'high' }, { type: 'secret', value: true }]),
    )
    expect(errors).toHaveLength(0)
    expect(conditions).toHaveLength(2)
  })

  it('flags non-object entries', () => {
    const { errors } = parseImagePolicyConditions(JSON.stringify(['cve', 42]))
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('buildPolicyData', () => {
  it('wraps the action and conditions into a single rule', () => {
    const data = buildPolicyData('prevent', [{ type: 'malware', value: true }])
    expect(data.rules).toHaveLength(1)
    expect(data.rules[0].action).toBe('prevent')
    expect(data.rules[0].policy_rules_data.conditions).toHaveLength(1)
  })
})
