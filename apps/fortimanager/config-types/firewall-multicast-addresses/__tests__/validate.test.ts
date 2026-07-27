import validate, { isValidIpv4, cidrToIpMask, extractMulticastAddressSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-multicast-addresses validate', () => {
  it('accepts a valid multicastrange address', () => {
    const r = validate(ctxWith([{ name: 'Mcast', fields: { name: 'Mcast', type: 'multicastrange', startIp: '239.0.0.1', endIp: '239.0.0.10' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid broadcastmask address', () => {
    const r = validate(ctxWith([{ name: 'Bcast', fields: { name: 'Bcast', type: 'broadcastmask', subnetCidr: '10.0.0.0/24' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'multicastrange', startIp: '239.0.0.1', endIp: '239.0.0.2' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', type: 'anycast' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid range IP', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', type: 'multicastrange', startIp: '999.0.0.1', endIp: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects an invalid broadcastmask CIDR', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', type: 'broadcastmask', subnetCidr: '10.0.0.0/40' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'multicastrange', startIp: '239.0.0.1', endIp: '239.0.0.2' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'multicastrange', startIp: '239.0.0.3', endIp: '239.0.0.4' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidIpv4 / cidrToIpMask', () => {
  it('validates IPv4 addresses', () => {
    expect(isValidIpv4('239.0.0.1')).toBe(true)
    expect(isValidIpv4('256.0.0.1')).toBe(false)
  })
  it('converts CIDR to [ip, mask]', () => {
    expect(cidrToIpMask('10.0.0.0/24')).toEqual(['10.0.0.0', '255.255.255.0'])
  })
})

describe('extractMulticastAddressSpecs', () => {
  it('defaults and lowercases the type', () => {
    const specs = extractMulticastAddressSpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', type: 'BROADCASTMASK', subnetCidr: '10.0.0.0/24' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('broadcastmask')
  })
})
