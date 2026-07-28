import validate, { deviceKey, extractDeviceValueSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-device-values',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-device-values',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    platform: stubPlatform,
  }
}

const DEVICE_ID = '1e5bc9d7e413ddd7902c2932e418702b84d0cc07'

describe('Defender Device Values Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a device-id item and a computer-name item', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { device_type: 'id', device: DEVICE_ID, criticality: 'High' } },
        { name: 'b', fields: { device_type: 'name', device: 'host1.contoso.com', criticality: 'Low' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('defaults device_type to id when omitted', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device: DEVICE_ID, criticality: 'Normal' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires a device value', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', criticality: 'High' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a criticality', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', device: DEVICE_ID } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid criticality', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', device: DEVICE_ID, criticality: 'Critical' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_criticality')).toBe(true)
  })

  it('rejects an unsupported device reference type', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'serial', device: DEVICE_ID, criticality: 'High' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_device_type')).toBe(true)
  })

  it('rejects a malformed device id when referenced by id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', device: 'not-a-hex-id', criticality: 'High' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_device_id')).toBe(true)
  })

  it('allows a free-form value when referenced by computer name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'name', device: 'host1.contoso.com', criticality: 'High' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects the same device declared twice', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { device_type: 'id', device: DEVICE_ID, criticality: 'High' } },
        { name: 'b', fields: { device_type: 'id', device: DEVICE_ID.toUpperCase(), criticality: 'Low' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_device')).toBe(true)
  })

  it('extract trims fields and defaults device_type to id', () => {
    const specs = extractDeviceValueSpecs(
      makeCtx([{ name: 't', fields: { device: `  ${DEVICE_ID}  `, criticality: 'High' } }]).canvas,
    )
    expect(specs[0].deviceType).toBe('id')
    expect(specs[0].device).toBe(DEVICE_ID)
    expect(specs[0].criticality).toBe('High')
  })

  it('deviceKey is case-insensitive on the device string', () => {
    expect(deviceKey('id', DEVICE_ID)).toBe(deviceKey('id', DEVICE_ID.toUpperCase()))
  })
})
