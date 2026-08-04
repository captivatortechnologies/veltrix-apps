import validate, { addressRangeKey, compareIpv4, extractAddressRangeSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'address-ranges',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'address-ranges',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = { name: 'dhcp-pool', ipv4First: '10.0.0.10', ipv4Last: '10.0.0.50' }

describe('Check Point Address Ranges Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a range with an IPv4 pair', async () => {
    const result = await validate(makeCtx([{ name: 'Range', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a range with only an IPv6 pair', async () => {
    const result = await validate(
      makeCtx([{ name: 'Range', fields: { name: 'v6-range', ipv6First: '2001:db8::1', ipv6Last: '2001:db8::ff' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { ipv4First: '10.0.0.1', ipv4Last: '10.0.0.5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires at least one complete pair', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'no-range' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires both endpoints of a declared IPv4 pair', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'incomplete', ipv4First: '10.0.0.1' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_ip' && e.field.includes('ipv4Last'))).toBe(true)
  })

  it('rejects a backwards IPv4 range', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'backwards', ipv4First: '10.0.0.50', ipv4Last: '10.0.0.10' } }]),
    )
    expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('rejects an invalid IPv4 endpoint', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'bad', ipv4First: '999.0.0.1', ipv4Last: '10.0.0.5' } }]),
    )
    expect(result.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'DHCP-Pool' } },
        { name: 'b', fields: { ...validFields, name: 'dhcp-pool' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractAddressRangeSpecs trims fields', () => {
    const specs = extractAddressRangeSpecs(
      makeCtx([{ id: 'i1', name: 'e', fields: { name: '  pool-2  ', ipv4First: ' 10.0.1.1 ', ipv4Last: '10.0.1.9' } }]).canvas,
    )
    expect(specs[0].name).toBe('pool-2')
    expect(specs[0].ipv4First).toBe('10.0.1.1')
    expect(addressRangeKey('  Pool-2 ')).toBe('pool-2')
  })
})

describe('compareIpv4', () => {
  it('orders addresses numerically', () => {
    expect(compareIpv4('10.0.0.1', '10.0.0.2') < 0).toBe(true)
    expect(compareIpv4('10.0.0.2', '10.0.0.1')).toBeGreaterThan(0)
    expect(compareIpv4('10.0.0.1', '10.0.0.1')).toBe(0)
  })
})
