import validate, {
  extractPolicySpecs,
  fileVantageHostGroupIds,
  fileVantageRuleGroupIds,
  sameOrder,
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
    configTypeId: 'filevantage-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'filevantage-policies',
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
    name: 'Production FIM',
    platform: 'Windows',
    enabled: true,
    hostGroups: 'group-id-1',
    ruleGroups: 'rule-group-1',
    ...overrides,
  }
}

describe('CrowdStrike FileVantage Policies Validate Handler', () => {
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

  it('rejects missing policy name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects the reserved platform_default name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: 'platform_default' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects unknown platforms', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ platform: 'Solaris' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('normalizes platform casing to the API title case', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ platform: 'windows' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when an enabled policy has no host groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_host_groups')).toBe(true)
  })

  it('warns when an enabled policy has no rule groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ ruleGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_rule_groups')).toBe(true)
  })

  it('warns when a rule group is listed more than once', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ ruleGroups: 'rg-1, rg-1' }) }]),
    )
    expect(result.warnings.some((w) => w.code === 'duplicate_rule_group')).toBe(true)
  })

  it('rejects duplicate policy names regardless of platform', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields({ platform: 'Linux' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('parses host groups and preserves ordered rule groups', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'filevantage-policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: 'p1',
            platform: 'Mac',
            hostGroups: 'g1, g2',
            ruleGroups: 'rg-2, rg-1',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].ruleGroups).toEqual(['rg-2', 'rg-1'])
    expect(specs[0].platform).toBe('Mac')
    expect(specs[0].enabled).toBe(false)
  })
})

describe('fileVantageHostGroupIds / fileVantageRuleGroupIds', () => {
  it('reads ids from arrays of objects', () => {
    const host = fileVantageHostGroupIds({ host_groups: [{ id: 'h1' }, { id: 'h2' }] })
    const rule = fileVantageRuleGroupIds({ rule_groups: [{ id: 'r1' }, { id: 'r2' }] })
    expect(host).toEqual(['h1', 'h2'])
    expect(rule).toEqual(['r1', 'r2'])
  })

  it('tolerates arrays of id strings', () => {
    expect(fileVantageHostGroupIds({ host_groups: ['h1'] })).toEqual(['h1'])
  })

  it('returns an empty array when groups are missing', () => {
    expect(fileVantageHostGroupIds({})).toEqual([])
    expect(fileVantageRuleGroupIds({})).toEqual([])
  })
})

describe('sameOrder', () => {
  it('is true for identical ordered lists', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
  })

  it('is false when the order differs', () => {
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
  })

  it('is false when the lengths differ', () => {
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
  })
})
