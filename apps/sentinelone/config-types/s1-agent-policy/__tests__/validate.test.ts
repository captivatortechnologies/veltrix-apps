import validate, { extractPolicySettingSpecs, coerceValue, setNestedPath, getNestedPath } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-agent-policy',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-agent-policy',
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

describe('SentinelOne Agent Policy Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid boolean setting', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy Setting', fields: { setting_key: 'snapshotsOn', value_type: 'boolean', value: 'true' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing key/value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { value_type: 'boolean' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('setting_key'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('value'))).toBe(true)
  })

  it('rejects a non-numeric number value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { setting_key: 'x', value_type: 'number', value: 'abc' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects duplicate keys', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { setting_key: 'snapshotsOn', value_type: 'boolean', value: 'true' } },
        { name: 'b', fields: { setting_key: 'snapshotsOn', value_type: 'boolean', value: 'false' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_setting')).toBe(true)
  })

  it('coerceValue + nested path helpers work', () => {
    expect(coerceValue('true', 'boolean')).toBe(true)
    expect(coerceValue('42', 'number')).toBe(42)
    expect(coerceValue('hi', 'string')).toBe('hi')
    const obj: Record<string, unknown> = {}
    setNestedPath(obj, 'agentUi.agentUiOn', true)
    expect(getNestedPath(obj, 'agentUi.agentUiOn')).toBe(true)
    expect(getNestedPath(obj, 'agentUi.missing')).toBeUndefined()
    const specs = extractPolicySettingSpecs(makeCtx([{ name: 'p', fields: { setting_key: '  snapshotsOn  ', value: 'true' } }]).canvas)
    expect(specs[0].key).toBe('snapshotsOn')
    expect(specs[0].valueType).toBe('boolean')
  })
})
