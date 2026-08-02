import validate, {
  extractNetworkSpecs,
  isValidIpv4Cidr,
  isValidIpv6Cidr,
  networkKey,
  parseIpv4Cidr,
  parseIpv6Cidr,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'network-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'network-objects',
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

const validFields = { name: 'dmz-net', subnetCidr: '10.0.100.0/24' }

describe('Check Point Network Objects Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a network with an IPv4 subnet', async () => {
    const result = await validate(makeCtx([{ name: 'Net', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a network with only an IPv6 subnet', async () => {
    const result = await validate(makeCtx([{ name: 'Net', fields: { name: 'v6-net', subnet6Cidr: '2001:db8::/32' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { subnetCidr: '10.0.0.0/24' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires at least one subnet', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'no-subnet' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('subnetCidr'))).toBe(true)
  })

  it('rejects an invalid IPv4 CIDR', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad', subnetCidr: '10.0.0.0/33' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_cidr' && e.field.includes('subnetCidr'))).toBe(true)
  })

  it('rejects an invalid IPv6 CIDR', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad', subnet6Cidr: 'not-a-cidr' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_cidr' && e.field.includes('subnet6Cidr'))).toBe(true)
  })

  it('rejects duplicate network names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'DMZ-Net' } },
        { name: 'b', fields: { ...validFields, name: 'dmz-net' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractNetworkSpecs trims fields', () => {
    const specs = extractNetworkSpecs(makeCtx([{ name: 'e', fields: { name: '  dmz-2  ', subnetCidr: ' 10.0.2.0/24 ' } }]).canvas)
    expect(specs[0].name).toBe('dmz-2')
    expect(specs[0].subnetCidr).toBe('10.0.2.0/24')
    expect(networkKey('  DMZ-2 ')).toBe('dmz-2')
  })
})

describe('isValidIpv4Cidr', () => {
  it('accepts valid CIDRs', () => {
    expect(isValidIpv4Cidr('10.0.0.0/24')).toBe(true)
    expect(isValidIpv4Cidr('0.0.0.0/0')).toBe(true)
  })

  it('rejects invalid CIDRs', () => {
    expect(isValidIpv4Cidr('10.0.0.0/33')).toBe(false)
    expect(isValidIpv4Cidr('256.0.0.0/24')).toBe(false)
    expect(isValidIpv4Cidr('10.0.0.0')).toBe(false)
  })
})

describe('parseIpv4Cidr', () => {
  it('splits into subnet4 + maskLength4', () => {
    expect(parseIpv4Cidr('10.0.100.0/24')).toEqual({ subnet4: '10.0.100.0', maskLength4: 24 })
  })

  it('returns null for an invalid CIDR', () => {
    expect(parseIpv4Cidr('not-a-cidr')).toBeNull()
  })
})

describe('isValidIpv6Cidr', () => {
  it('accepts valid CIDRs', () => {
    expect(isValidIpv6Cidr('2001:db8::/32')).toBe(true)
    expect(isValidIpv6Cidr('::/0')).toBe(true)
  })

  it('rejects invalid CIDRs', () => {
    expect(isValidIpv6Cidr('2001:db8::/129')).toBe(false)
    expect(isValidIpv6Cidr('not-a-cidr')).toBe(false)
    expect(isValidIpv6Cidr('2001:db8::')).toBe(false)
  })
})

describe('parseIpv6Cidr', () => {
  it('splits into subnet6 + maskLength6', () => {
    expect(parseIpv6Cidr('2001:db8::/32')).toEqual({ subnet6: '2001:db8::', maskLength6: 32 })
  })

  it('returns null for an invalid CIDR', () => {
    expect(parseIpv6Cidr('not-a-cidr')).toBeNull()
  })
})
