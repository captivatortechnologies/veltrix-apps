import validate, { extractMachineTagSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-machine-tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-machine-tags',
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

describe('Defender Machine Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a device-id item and a computer-name item', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { device_type: 'id', device_value: DEVICE_ID, tags: ['prod', 'finance'] } },
        { name: 'b', fields: { device_type: 'name', device_value: 'host1.contoso.com', tags: 'crown-jewel' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a device value', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', tags: ['prod'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a malformed device id when referenced by id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', device_value: 'not-a-hex-id', tags: ['prod'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_device_id')).toBe(true)
  })

  it('allows a free-form value when referenced by computer name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'name', device_value: 'host1.contoso.com', tags: ['prod'] } }]))
    expect(result.valid).toBe(true)
  })

  it('requires at least one tag', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'id', device_value: DEVICE_ID, tags: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns on a tag with a comma or parenthesis', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'name', device_value: 'host1', tags: ['prod, west'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'tag_special_chars')).toBe(true)
  })

  it('warns on an over-long tag', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { device_type: 'name', device_value: 'host1', tags: ['x'.repeat(201)] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'tag_too_long')).toBe(true)
  })

  it('rejects the same device declared twice', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { device_type: 'id', device_value: DEVICE_ID, tags: ['prod'] } },
        { name: 'b', fields: { device_type: 'id', device_value: DEVICE_ID.toUpperCase(), tags: ['finance'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_device')).toBe(true)
  })

  it('extract trims, dedupes tags and defaults device_type to id', () => {
    const specs = extractMachineTagSpecs(
      makeCtx([{ name: 't', fields: { device_value: `  ${DEVICE_ID}  `, tags: 'prod, PROD ,  finance ' } }]).canvas,
    )
    expect(specs[0].deviceType).toBe('id')
    expect(specs[0].deviceValue).toBe(DEVICE_ID)
    expect(specs[0].tags).toEqual(['prod', 'finance'])
  })
})
