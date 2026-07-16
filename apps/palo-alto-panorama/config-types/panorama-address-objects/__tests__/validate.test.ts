import validate, { extractAddressSpecs, buildAddressFields, addressDriftDiffs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-address-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-address-objects',
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

describe('Panorama Address Objects Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid ip-netmask address', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'web', type: 'ip-netmask', value: '10.0.0.0/24' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires name and value', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { type: 'fqdn' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'required').length).toBeGreaterThan(1)
  })

  it('rejects an ip-range without a dash', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'r', type: 'ip-range', value: '10.0.0.1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'web', type: 'fqdn', value: 'a.com' } },
        { name: 'b', fields: { name: 'WEB', type: 'fqdn', value: 'b.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds fields (one value type + tags) and detects drift', () => {
    const spec = extractAddressSpecs(
      makeCtx([{ name: 'a', fields: { name: 'web', type: 'fqdn', value: 'docs.example.com', tags: ['blue'] } }]).canvas,
    )[0]
    expect(buildAddressFields(spec)).toEqual({ fqdn: 'docs.example.com', tag: { member: ['blue'] } })
    expect(addressDriftDiffs(spec, { '@name': 'web', fqdn: 'docs.example.com' })).toHaveLength(0)
    expect(addressDriftDiffs(spec, { '@name': 'web', fqdn: 'other.example.com' }).length).toBeGreaterThan(0)
  })
})
