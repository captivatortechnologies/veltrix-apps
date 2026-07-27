import validate, { parseFirewallRules, extractRuleGroupSpecs } from '../validate'
import {
  buildDiffOperations,
  buildRulePayload,
  canonicalFromLive,
  canonicalFromSpec,
  rulesEqual,
} from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'firewall-rule-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'firewall-rule-groups',
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
    name: 'Baseline Egress',
    platform: 'windows',
    enabled: true,
    rules: JSON.stringify([
      {
        name: 'Allow HTTPS out',
        action: 'ALLOW',
        direction: 'OUT',
        protocol: 'TCP',
        enabled: true,
        remotePorts: [{ start: 443 }],
        addressFamily: 'ANY',
      },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike Firewall Rule Groups Validate Handler', () => {
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
    const result = await validate(makeCtx([{ name: 'sec1', fields: validGroupFields({ name: '' }) }]))
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
    const result = await validate(makeCtx([{ name: 'sec1', fields: validGroupFields({ rules: '' }) }]))
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

describe('parseFirewallRules', () => {
  it('accepts a well-formed rule and maps protocol + address family to wire values', () => {
    const { rules, errors } = parseFirewallRules(
      JSON.stringify([
        { name: 'Allow HTTPS', action: 'allow', direction: 'out', protocol: 'tcp', addressFamily: 'any' },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].action).toBe('ALLOW')
    expect(rules[0].direction).toBe('OUT')
    expect(rules[0].protocolWire).toBe('6')
    expect(rules[0].addressFamily).toBe('NONE')
    expect(rules[0].enabled).toBe(true)
  })

  it('maps ICMP protocol alias to wire "1" and ICMPV6 to "58"', () => {
    const { rules } = parseFirewallRules(
      JSON.stringify([
        { name: 'r1', action: 'DENY', direction: 'IN', protocol: 'ICMP' },
        { name: 'r2', action: 'DENY', direction: 'IN', protocol: 'ICMPV6' },
      ]),
    )
    expect(rules[0].protocolWire).toBe('1')
    expect(rules[1].protocolWire).toBe('58')
  })

  it('normalizes a bare number port to a {start, end:0} range', () => {
    const { rules, errors } = parseFirewallRules(
      JSON.stringify([
        { name: 'r1', action: 'ALLOW', direction: 'OUT', protocol: 'TCP', remotePorts: [443] },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(rules[0].remotePorts).toEqual([{ start: 443, end: 0 }])
  })

  it('rejects an unknown action', () => {
    const { errors } = parseFirewallRules(
      JSON.stringify([{ name: 'r1', action: 'BLOCK', direction: 'OUT', protocol: 'TCP' }]),
    )
    expect(errors.some((e) => e.includes('action'))).toBe(true)
  })

  it('rejects an unknown direction', () => {
    const { errors } = parseFirewallRules(
      JSON.stringify([{ name: 'r1', action: 'ALLOW', direction: 'SIDEWAYS', protocol: 'TCP' }]),
    )
    expect(errors.some((e) => e.includes('direction'))).toBe(true)
  })

  it('rejects an unknown protocol', () => {
    const { errors } = parseFirewallRules(
      JSON.stringify([{ name: 'r1', action: 'ALLOW', direction: 'OUT', protocol: 'CARRIER_PIGEON' }]),
    )
    expect(errors.some((e) => e.includes('protocol'))).toBe(true)
  })

  it('rejects an out-of-range port', () => {
    const { errors } = parseFirewallRules(
      JSON.stringify([
        { name: 'r1', action: 'ALLOW', direction: 'OUT', protocol: 'TCP', localPorts: [70000] },
      ]),
    )
    expect(errors.some((e) => e.includes('localPorts'))).toBe(true)
  })

  it('rejects duplicate rule names', () => {
    const { errors } = parseFirewallRules(
      JSON.stringify([
        { name: 'r1', action: 'ALLOW', direction: 'OUT', protocol: 'TCP' },
        { name: 'r1', action: 'DENY', direction: 'IN', protocol: 'UDP' },
      ]),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('rejects a non-array rules payload', () => {
    const { errors } = parseFirewallRules(JSON.stringify({ name: 'r1' }))
    expect(errors.some((e) => e.includes('must be a JSON array'))).toBe(true)
  })

  it('returns empty rules for empty input', () => {
    expect(parseFirewallRules(undefined)).toEqual({ rules: [], errors: [] })
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
      entityType: 'firewall-rule-groups',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'g1', platform: 'MAC' } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('g1')
    expect(specs[0].platform).toBe('mac')
    expect(specs[0].enabled).toBe(false)
  })
})

describe('firewall rule payload + diff building', () => {
  const ruleJson = JSON.stringify([
    {
      name: 'Allow HTTPS out',
      action: 'ALLOW',
      direction: 'OUT',
      protocol: 'TCP',
      enabled: true,
      remotePorts: [{ start: 443, end: 0 }],
    },
  ])

  it('builds a wire payload with numeric protocol, log:false, and a network_location field', () => {
    const { rules } = parseFirewallRules(ruleJson)
    const payload = buildRulePayload(canonicalFromSpec(rules[0]), 'temp_id:1')
    expect(payload.temp_id).toBe('temp_id:1')
    expect(payload.protocol).toBe('6')
    expect(payload.log).toBe(false)
    expect(payload.action).toBe('ALLOW')
    expect(JSON.stringify(payload.fields)).toContain('network_location')
  })

  it('treats a spec and its round-tripped live rule as equal', () => {
    const { rules } = parseFirewallRules(ruleJson)
    const canon = canonicalFromSpec(rules[0])
    const live = {
      id: 'rule-1',
      name: 'Allow HTTPS out',
      action: 'ALLOW',
      direction: 'OUT',
      protocol: '6',
      address_family: 'NONE',
      enabled: true,
      remote_port: [{ start: 443, end: 0 }],
      fields: [{ name: 'network_location', type: 'set', values: ['ANY'] }],
    }
    expect(rulesEqual(canon, canonicalFromLive(live))).toBe(true)
  })

  it('emits no diff operations when the group already matches the desired state', () => {
    const { rules } = parseFirewallRules(ruleJson)
    const live = {
      id: 'grp-1',
      name: 'Baseline',
      description: '',
      enabled: true,
      tracking: 'tk-1',
      rules: [
        {
          id: 'rule-1',
          name: 'Allow HTTPS out',
          action: 'ALLOW',
          direction: 'OUT',
          protocol: '6',
          address_family: 'NONE',
          enabled: true,
          remote_port: [{ start: 443, end: 0 }],
          fields: [{ name: 'network_location', type: 'set', values: ['ANY'] }],
        },
      ],
    }
    const { diffOps, ruleIds } = buildDiffOperations(
      live,
      { name: 'Baseline', description: '', enabled: true },
      rules.map(canonicalFromSpec),
    )
    expect(diffOps).toHaveLength(0)
    expect(ruleIds).toEqual(['rule-1'])
  })

  it('emits a remove+add pair and a temp id when a rule changed', () => {
    const { rules } = parseFirewallRules(
      JSON.stringify([
        { name: 'Allow HTTPS out', action: 'DENY', direction: 'OUT', protocol: 'TCP', remotePorts: [{ start: 443 }] },
      ]),
    )
    const live = {
      id: 'grp-1',
      name: 'Baseline',
      description: '',
      enabled: true,
      tracking: 'tk-1',
      rules: [
        {
          id: 'rule-1',
          name: 'Allow HTTPS out',
          action: 'ALLOW',
          direction: 'OUT',
          protocol: '6',
          address_family: 'NONE',
          enabled: true,
          remote_port: [{ start: 443, end: 0 }],
          fields: [{ name: 'network_location', type: 'set', values: ['ANY'] }],
        },
      ],
    }
    const { diffOps, ruleIds } = buildDiffOperations(
      live,
      { name: 'Baseline', description: '', enabled: true },
      rules.map(canonicalFromSpec),
    )
    expect(diffOps.some((op) => op.op === 'remove' && op.path === '/rules/0')).toBe(true)
    expect(diffOps.some((op) => op.op === 'add' && op.path === '/rules/-')).toBe(true)
    expect(ruleIds[0]).toMatch(/^temp_id:/)
  })
})
