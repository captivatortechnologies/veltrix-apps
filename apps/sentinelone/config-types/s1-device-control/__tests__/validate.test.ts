import validate, { extractDeviceRuleSpecs, ruleKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-device-control',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-device-control',
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

const validFields = { rule_name: 'Block Mass Storage', interface: 'USB', action: 'Block', device_class: '08h' }

describe('SentinelOne Device Control Validate Handler', () => {
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

  it('rejects a missing rule name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { interface: 'USB' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_name'))).toBe(true)
  })

  it('rejects unsupported interface/action/access_permission/status', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            rule_name: 'Bad',
            interface: 'Infrared',
            action: 'Warn',
            access_permission: 'Full',
            status: 'Maybe',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_interface')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_access_permission')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('warns when USB fields are set on a Bluetooth rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_name: 'BT Rule', interface: 'Bluetooth', action: 'Block', vendor_id: '1234' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'irrelevant_field')).toBe(true)
  })

  it('warns when Bluetooth Address is set on a USB rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_name: 'USB Rule', interface: 'USB', action: 'Block', bluetooth_address: 'AA:BB:CC:DD:EE:FF' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'irrelevant_field')).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, rule_name: 'Block Storage' } },
        { name: 'b', fields: { ...validFields, rule_name: 'block storage' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractDeviceRuleSpecs defaults and trims', () => {
    const specs = extractDeviceRuleSpecs(makeCtx([{ name: 'r', fields: { rule_name: '  Rule X  ' } }]).canvas)
    expect(specs[0].ruleName).toBe('Rule X')
    expect(specs[0].interfaceType).toBe('USB')
    expect(specs[0].action).toBe('Block')
    expect(specs[0].accessPermission).toBe('Not-Applicable')
    expect(specs[0].status).toBe('Enabled')
    expect(ruleKey('  Rule X ')).toBe('rule x')
  })
})
