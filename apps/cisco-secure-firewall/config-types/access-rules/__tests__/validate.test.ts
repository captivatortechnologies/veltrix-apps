import validate, { extractAccessRuleSpecs, buildAccessRuleFields, accessRuleDriftDiffs, accessRulesPath } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'access-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'access-rules',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cisco-secure-firewall',
    entityType: 'access-rules',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Access Rules validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal rule', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { policy_name: 'corp-policy', name: 'allow-web', action: 'ALLOW' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing policy_name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'allow-web', action: 'ALLOW' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policy_name'))).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { policy_name: 'corp-policy', name: 'r1', action: 'PERMIT' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('allows the same rule name in two different policies', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { policy_name: 'policy-a', name: 'allow-web', action: 'ALLOW' } },
        { name: 'sec2', fields: { policy_name: 'policy-b', name: 'allow-web', action: 'ALLOW' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate rule name within the same policy', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { policy_name: 'corp-policy', name: 'allow-web', action: 'ALLOW' } },
        { name: 'sec2', fields: { policy_name: 'corp-policy', name: 'allow-web', action: 'BLOCK' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('enforces MONITOR logging requirements', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { policy_name: 'corp-policy', name: 'watch', action: 'MONITOR', log_begin: true, log_end: false, send_events_to_fmc: false } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_monitor_logging')).toHaveLength(3)
  })

  it('accepts a MONITOR rule with correct logging', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { policy_name: 'corp-policy', name: 'watch', action: 'MONITOR', log_begin: false, log_end: true, send_events_to_fmc: true } }]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractAccessRuleSpecs / buildAccessRuleFields', () => {
  it('defaults action/section/enabled when blank', () => {
    const specs = extractAccessRuleSpecs(makeCanvas([{ name: 'sec1', fields: { policy_name: 'corp-policy', name: 'allow-web' } }]))
    expect(specs[0].action).toBe('ALLOW')
    expect(specs[0].ruleSection).toBe('mandatory')
    expect(specs[0].enabled).toBe(true)
  })

  it('omits empty match conditions and nests non-empty ones as {objects}', () => {
    const specs = extractAccessRuleSpecs(
      makeCanvas([{ name: 'sec1', fields: { policy_name: 'corp-policy', name: 'allow-web', source_zones: ['inside'] } }]),
    )
    const fields = buildAccessRuleFields(specs[0], {
      sourceZones: [{ id: 'z1', type: 'SecurityZone', name: 'inside' }],
      destinationZones: [],
      sourceNetworks: [],
      destinationNetworks: [],
      sourcePorts: [],
      destinationPorts: [],
    })
    expect(fields.sourceZones).toEqual({ objects: [{ id: 'z1', type: 'SecurityZone' }] })
    expect(fields.destinationZones).toBeUndefined()
    expect(fields.sourceNetworks).toBeUndefined()
  })
})

describe('accessRuleDriftDiffs', () => {
  it('flags a changed action and a changed zone reference set', () => {
    const spec = {
      sectionName: 's',
      policyName: 'corp-policy',
      name: 'allow-web',
      action: 'ALLOW',
      enabled: true,
      ruleSection: 'mandatory',
      sourceZones: ['inside'],
      destinationZones: [],
      sourceNetworks: [],
      destinationNetworks: [],
      sourcePorts: [],
      destinationPorts: [],
      logBegin: false,
      logEnd: false,
      sendEventsToFmc: false,
      description: '',
    }
    const diffs = accessRuleDriftDiffs(
      spec,
      { sourceZones: [{ id: 'z1', type: 'SecurityZone', name: 'inside' }], destinationZones: [], sourceNetworks: [], destinationNetworks: [], sourcePorts: [], destinationPorts: [] },
      { action: 'BLOCK', enabled: true, sourceZones: { objects: [] } },
    )
    expect(diffs.some((d) => d.field === 'allow-web.action')).toBe(true)
    expect(diffs.some((d) => d.field === 'allow-web.source_zones')).toBe(true)
  })
})

describe('accessRulesPath', () => {
  it('builds the per-policy accessrules path', () => {
    expect(accessRulesPath('abc-123')).toBe('/policy/accesspolicies/abc-123/accessrules')
  })
})
