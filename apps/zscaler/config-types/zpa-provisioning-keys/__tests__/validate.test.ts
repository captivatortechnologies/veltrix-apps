import validate, {
  DEFAULT_MAX_USAGE,
  extractProvisioningKeySpecs,
  readBool,
  readNumber,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zpa-provisioning-keys',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zpa-provisioning-keys',
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

/** A fully-valid provisioning key item, overridable per test. */
function validKey(overrides: Record<string, unknown> = {}): { name: string; fields: Record<string, unknown> } {
  return {
    name: 'Key Section',
    fields: {
      name: 'HQ Connector Key',
      association_type: 'CONNECTOR_GRP',
      max_usage: 10,
      component_group_name: 'HQ Connectors',
      enrollment_cert_name: 'Connector',
      enabled: true,
      ...overrides,
    },
  }
}

describe('ZPA Provisioning Keys Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully-specified provisioning key', async () => {
    const result = await validate(makeCtx([validKey()]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([validKey({ name: '' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing enrollment cert name', async () => {
    const result = await validate(makeCtx([validKey({ enrollment_cert_name: '' })]))
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((e) => e.code === 'required' && e.field.includes('enrollment_cert_name')),
    ).toBe(true)
  })

  it('rejects a missing component group name', async () => {
    const result = await validate(makeCtx([validKey({ component_group_name: '' })]))
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((e) => e.code === 'required' && e.field.includes('component_group_name')),
    ).toBe(true)
  })

  it('rejects an invalid association type', async () => {
    const result = await validate(makeCtx([validKey({ association_type: 'SOMETHING_ELSE' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_association_type')).toBe(true)
  })

  it('rejects a missing max usage', async () => {
    const result = await validate(makeCtx([validKey({ max_usage: '' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('max_usage'))).toBe(true)
  })

  it('rejects a non-positive / non-integer max usage', async () => {
    const zero = await validate(makeCtx([validKey({ max_usage: 0 })]))
    expect(zero.errors.some((e) => e.code === 'invalid_max_usage')).toBe(true)

    const fractional = await validate(makeCtx([validKey({ max_usage: 2.5 })]))
    expect(fractional.errors.some((e) => e.code === 'invalid_max_usage')).toBe(true)
  })

  it('rejects a duplicate (association_type, name) pair', async () => {
    const result = await validate(
      makeCtx([
        validKey({ name: 'Shared Key' }),
        { name: 'Section B', fields: { ...validKey({ name: 'shared key' }).fields } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_provisioning_key')).toBe(true)
  })

  it('allows the same name under different association types', async () => {
    const result = await validate(
      makeCtx([
        validKey({ name: 'Enroll Key', association_type: 'CONNECTOR_GRP' }),
        { name: 'Section B', fields: { ...validKey({ name: 'Enroll Key', association_type: 'SERVICE_EDGE_GRP' }).fields } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors.some((e) => e.code === 'duplicate_provisioning_key')).toBe(false)
  })

  it('extracts specs, defaulting enabled to true and parsing numbers', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readNumber('12')).toBe(12)
    expect(readNumber('')).toBeUndefined()
    expect(DEFAULT_MAX_USAGE).toBe(10)

    const specs = extractProvisioningKeySpecs(makeCtx([validKey({ enabled: undefined })]).canvas)
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].associationType).toBe('CONNECTOR_GRP')
    expect(specs[0].maxUsage).toBe(10)
  })
})
