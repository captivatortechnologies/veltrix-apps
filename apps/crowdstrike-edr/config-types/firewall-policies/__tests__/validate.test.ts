import validate, { extractFirewallPolicySpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'firewall-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'firewall-policies',
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
    name: 'Corporate Workstations',
    platform: 'Windows',
    enabled: true,
    hostGroups: 'group-id-1',
    ruleGroups: 'rg-1, rg-2',
    defaultInbound: 'DENY',
    defaultOutbound: 'ALLOW',
    enforce: true,
    ...overrides,
  }
}

describe('CrowdStrike Firewall Policies Validate Handler', () => {
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

  it('rejects an invalid default inbound action', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ defaultInbound: 'DROP' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('warns when an enabled policy has no host groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_host_groups')).toBe(true)
  })

  it('warns when test mode is set without enforce', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ enforce: false, testMode: true }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'monitor_requires_enforce')).toBe(true)
  })

  it('rejects duplicate policy names per platform', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same policy name on different platforms', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields({ platform: 'Linux' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractFirewallPolicySpecs', () => {
  it('parses ordered rule groups, host groups, defaults, and toggles', () => {
    const specs = extractFirewallPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'firewall-policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: 'p1',
            platform: 'windows',
            hostGroups: 'h1, h2',
            ruleGroups: 'rg1, rg2, rg3',
            enforce: true,
            localLogging: true,
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].platform).toBe('Windows')
    expect(specs[0].hostGroups).toEqual(['h1', 'h2'])
    expect(specs[0].ruleGroups).toEqual(['rg1', 'rg2', 'rg3'])
    expect(specs[0].defaultInbound).toBe('DENY')
    expect(specs[0].defaultOutbound).toBe('ALLOW')
    expect(specs[0].enforce).toBe(true)
    expect(specs[0].localLogging).toBe(true)
    expect(specs[0].enabled).toBe(false)
  })

  it('uppercases default action values', () => {
    const specs = extractFirewallPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'firewall-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'p1', defaultInbound: 'allow', defaultOutbound: 'deny' } }],
      snapshot: {},
    })
    expect(specs[0].defaultInbound).toBe('ALLOW')
    expect(specs[0].defaultOutbound).toBe('DENY')
  })
})
