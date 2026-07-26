import validate, { cidrToIpMask, isValidCidr, extractAddressSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-addresses validate', () => {
  it('accepts a valid ipmask address', () => {
    const r = validate(ctxWith([{ name: 'DMZ', fields: { name: 'DMZ', type: 'ipmask', subnetCidr: '10.0.100.0/24' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid iprange address', () => {
    const r = validate(
      ctxWith([{ name: 'Pool', fields: { name: 'Pool', type: 'iprange', startIp: '10.0.0.1', endIp: '10.0.0.50' } }])
    )
    expect(r.valid).toBe(true)
  })

  it('accepts fqdn and geography addresses', () => {
    const fqdn = validate(ctxWith([{ name: 'Site', fields: { name: 'Site', type: 'fqdn', fqdn: 'www.example.com' } }]))
    expect(fqdn.valid).toBe(true)
    const geo = validate(ctxWith([{ name: 'US', fields: { name: 'US', type: 'geography', country: 'us' } }]))
    expect(geo.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'ipmask', subnetCidr: '10.0.0.0/8' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid CIDR for ipmask', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { name: 'Bad', type: 'ipmask', subnetCidr: '999.0.0.0/24' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('requires a subnet for ipmask', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', type: 'ipmask' } }]))
    expect(r.errors.some((e) => e.code === 'missing_subnet')).toBe(true)
  })

  it('rejects an invalid country for geography', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', type: 'geography', country: 'USA' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_country')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', type: 'wildcard' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'ipmask', subnetCidr: '10.0.0.0/8' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'ipmask', subnetCidr: '10.0.0.0/8' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('cidrToIpMask', () => {
  it('converts CIDR to [ip, dotted-mask]', () => {
    expect(cidrToIpMask('10.0.100.0/24')).toEqual(['10.0.100.0', '255.255.255.0'])
    expect(cidrToIpMask('192.168.1.5/32')).toEqual(['192.168.1.5', '255.255.255.255'])
    expect(cidrToIpMask('10.0.0.0/8')).toEqual(['10.0.0.0', '255.0.0.0'])
    expect(cidrToIpMask('0.0.0.0/0')).toEqual(['0.0.0.0', '0.0.0.0'])
  })
})

describe('isValidCidr', () => {
  it('validates IPv4 CIDR', () => {
    expect(isValidCidr('10.0.0.0/24')).toBe(true)
    expect(isValidCidr('256.0.0.0/24')).toBe(false)
    expect(isValidCidr('10.0.0.0/33')).toBe(false)
    expect(isValidCidr('10.0.0.0')).toBe(false)
  })
})

describe('extractAddressSpecs', () => {
  it('lowercases type and uppercases country', () => {
    const specs = extractAddressSpecs({
      items: [{ id: 'i1', name: 'A', fields: { name: 'A', type: 'GEOGRAPHY', country: 'us' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('geography')
    expect(specs[0].country).toBe('US')
  })
})
