import validate, { isValidIpv6, isValidIpv6Prefix, extractAddress6Specs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-addresses6 validate', () => {
  it('accepts a valid ipprefix address', () => {
    const r = validate(ctxWith([{ name: 'Net', fields: { name: 'Net', type: 'ipprefix', ip6: '2001:db8::/32' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid iprange address', () => {
    const r = validate(ctxWith([{ name: 'Range', fields: { name: 'Range', type: 'iprange', startIp: '2001:db8::1', endIp: '2001:db8::ff' } }]))
    expect(r.valid).toBe(true)
  })

  it('accepts an fqdn address', () => {
    const r = validate(ctxWith([{ name: 'Site', fields: { name: 'Site', type: 'fqdn', fqdn: 'www.example.com' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'ipprefix', ip6: '2001:db8::/32' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid IPv6 prefix', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { name: 'Bad', type: 'ipprefix', ip6: 'nothex::/32' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip6')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', type: 'geography' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'ipprefix', ip6: '2001:db8::/32' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'ipprefix', ip6: '2001:db8:1::/48' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidIpv6 / isValidIpv6Prefix', () => {
  it('validates IPv6 addresses', () => {
    expect(isValidIpv6('2001:db8::1')).toBe(true)
    expect(isValidIpv6('::1')).toBe(true)
    expect(isValidIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true)
    expect(isValidIpv6('2001:db8')).toBe(false)
    expect(isValidIpv6('gggg::1')).toBe(false)
  })
  it('validates IPv6 prefixes', () => {
    expect(isValidIpv6Prefix('2001:db8::/32')).toBe(true)
    expect(isValidIpv6Prefix('2001:db8::/129')).toBe(false)
    expect(isValidIpv6Prefix('2001:db8::')).toBe(false)
  })
})

describe('extractAddress6Specs', () => {
  it('lowercases the type', () => {
    const specs = extractAddress6Specs({
      items: [{ id: 'i1', name: 'A', fields: { name: 'A', type: 'IPRANGE', startIp: '2001:db8::1', endIp: '2001:db8::9' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('iprange')
  })
})
