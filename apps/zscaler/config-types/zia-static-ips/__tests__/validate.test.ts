import validate, { extractStaticIpSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-static-ips',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-static-ips',
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

describe('ZIA Static IPs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid static IP', async () => {
    const result = await validate(
      makeCtx([{ name: 'Static IP', fields: { ip_address: '203.0.113.10', comment: 'HQ egress' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing ip address', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { comment: 'no ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('ip_address'))).toBe(true)
  })

  it('rejects duplicate ip addresses (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ip_address: '203.0.113.10' } },
        { name: 'b', fields: { ip_address: '203.0.113.10' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_static_ip')).toBe(true)
  })

  it('requires latitude and longitude when geo_override is enabled', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ip_address: '203.0.113.10', geo_override: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('latitude'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('longitude'))).toBe(true)
  })

  it('accepts geo_override when latitude and longitude are supplied', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { ip_address: '203.0.113.10', geo_override: true, latitude: 51.5074, longitude: -0.1278 },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects coordinates outside the valid WGS84 range', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { ip_address: '203.0.113.10', geo_override: true, latitude: 120, longitude: 999 },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'out_of_range')).toHaveLength(2)
  })

  it('extractStaticIpSpecs trims, drops blank comment, parses numbers, and applies boolean defaults', () => {
    const specs = extractStaticIpSpecs(
      makeCtx([
        {
          name: 'Static IP',
          fields: { ip_address: '  203.0.113.10  ', comment: '   ', geo_override: 'true', latitude: '12.5' },
        },
      ]).canvas,
    )
    expect(specs[0].ipAddress).toBe('203.0.113.10')
    expect(specs[0].comment).toBeUndefined()
    // geo_override coerced from string; latitude parsed from string.
    expect(specs[0].geoOverride).toBe(true)
    expect(specs[0].latitude).toBe(12.5)
    expect(specs[0].longitude).toBeUndefined()
    // routable_ip defaults true when unset.
    expect(specs[0].routableIp).toBe(true)
  })
})
