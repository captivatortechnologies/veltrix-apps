import validate, {
  parseRuleGroups,
  extractKacPolicySpecs,
  deepEqual,
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
    configTypeId: 'cloud-kac-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-kac-policies',
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
    name: 'Production Clusters',
    enabled: true,
    defaultAction: 'Alert',
    hostGroups: 'group-id-1',
    ruleGroups: JSON.stringify([
      {
        name: 'privileged-workloads',
        namespaces: ['prod-*'],
        default_rules: { privileged_container: 'Prevent' },
      },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike KAC Policies Validate Handler', () => {
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
    const result = await validate(makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects an unknown default action', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ defaultAction: 'Block' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('normalizes default action casing to the API title case', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ defaultAction: 'prevent' }) }]),
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

  it('warns when an enabled policy declares no rule groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ ruleGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_rule_groups')).toBe(true)
  })

  it('rejects invalid rule groups JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ ruleGroups: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_groups')).toBe(true)
  })

  it('rejects duplicate policy names per canvas', async () => {
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

describe('parseRuleGroups', () => {
  it('accepts a well-formed rule group array', () => {
    const { ruleGroups, errors } = parseRuleGroups(
      JSON.stringify([{ name: 'rg-a', namespaces: ['prod-*'] }]),
    )
    expect(errors).toHaveLength(0)
    expect(ruleGroups).toHaveLength(1)
    expect(ruleGroups[0].name).toBe('rg-a')
  })

  it('rejects a non-array rule groups payload', () => {
    const { errors } = parseRuleGroups(JSON.stringify({ name: 'rg-a' }))
    expect(errors.some((e) => e.includes('must be a JSON array'))).toBe(true)
  })

  it('rejects a rule group missing a name', () => {
    const { errors } = parseRuleGroups(JSON.stringify([{ namespaces: ['prod-*'] }]))
    expect(errors.some((e) => e.includes('name'))).toBe(true)
  })

  it('rejects duplicate rule group names', () => {
    const { errors } = parseRuleGroups(
      JSON.stringify([{ name: 'rg-a' }, { name: 'rg-a' }]),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('rejects an entry that is not an object', () => {
    const { errors } = parseRuleGroups(JSON.stringify(['not-an-object']))
    expect(errors.some((e) => e.includes('must be an object'))).toBe(true)
  })

  it('returns empty rule groups for empty input', () => {
    expect(parseRuleGroups(undefined)).toEqual({ ruleGroups: [], errors: [] })
  })
})

describe('extractKacPolicySpecs', () => {
  it('parses fields, normalizes default action, and splits host groups', () => {
    const specs = extractKacPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-kac-policies',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: 'p1', defaultAction: 'PREVENT', hostGroups: 'g1, g2' } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('p1')
    expect(specs[0].defaultAction).toBe('Prevent')
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
  })

  it('defaults the action to Alert when unset', () => {
    const specs = extractKacPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-kac-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'p1' } }],
      snapshot: {},
    })
    expect(specs[0].defaultAction).toBe('Alert')
  })
})

describe('deepEqual', () => {
  it('treats structurally identical rule groups as equal', () => {
    const a = [{ name: 'rg', namespaces: ['prod-*'], default_rules: { privileged_container: 'Prevent' } }]
    const b = [{ name: 'rg', namespaces: ['prod-*'], default_rules: { privileged_container: 'Prevent' } }]
    expect(deepEqual(a, b)).toBe(true)
  })

  it('detects a differing nested action', () => {
    const a = [{ name: 'rg', default_rules: { privileged_container: 'Prevent' } }]
    const b = [{ name: 'rg', default_rules: { privileged_container: 'Alert' } }]
    expect(deepEqual(a, b)).toBe(false)
  })

  it('detects a differing array length', () => {
    expect(deepEqual([{ name: 'a' }], [{ name: 'a' }, { name: 'b' }])).toBe(false)
  })
})
