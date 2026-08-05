import validate, { extractFirewallRuleSpecs, ruleKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-firewall-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-firewall-rules',
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

const validFields = { name: 'Block Telnet', action: 'Blocked', direction: 'outbound', os_type: 'windows', protocol: 'TCP' }

describe('SentinelOne Firewall Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'Allow' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects unsupported action/direction/os/status', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'Bad', action: 'Deny', direction: 'sideways', os_type: 'plan9', status: 'Maybe' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_direction')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_os')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('warns on an unscoped (catch-all) rule', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Catch All', action: 'Blocked' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unscoped_rule')).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Block RDP' } },
        { name: 'b', fields: { ...validFields, name: 'block rdp' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractFirewallRuleSpecs defaults and trims', () => {
    const specs = extractFirewallRuleSpecs(makeCtx([{ name: 'r', fields: { name: '  Rule X  ' } }]).canvas)
    expect(specs[0].name).toBe('Rule X')
    expect(specs[0].action).toBe('Allow')
    expect(specs[0].direction).toBe('any')
    expect(specs[0].osType).toBe('windows')
    expect(specs[0].status).toBe('Enabled')
    expect(ruleKey('  Rule X ')).toBe('rule x')
  })
})
