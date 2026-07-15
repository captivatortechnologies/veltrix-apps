import validate, { extractServiceGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-network-service-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-network-service-groups',
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

describe('ZIA Network Service Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid network service group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Service Group',
          fields: { name: 'Web Traffic', description: 'HTTP + HTTPS', services: 'HTTP\nHTTPS' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { services: 'HTTP' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a group with no member services', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Empty Group', services: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('services'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), services: 'HTTP' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Web Traffic', services: 'HTTP' } },
        { name: 'b', fields: { name: 'web traffic', services: 'HTTPS' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_network_service_group')).toBe(true)
  })

  it('extractServiceGroupSpecs trims fields, drops blanks, and splits service lines', () => {
    const specs = extractServiceGroupSpecs(
      makeCtx([
        {
          name: 'Service Group',
          fields: { name: '  Web Traffic  ', description: '   ', services: 'HTTP\n\n  HTTPS  \n' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Web Traffic')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].services).toEqual(['HTTP', 'HTTPS'])
  })
})
