import validate, { isValidIpv6, extractIpPool6Specs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-ippools6 validate', () => {
  it('accepts a valid IPv6 pool', () => {
    const r = validate(ctxWith([{ name: 'Nat6', fields: { name: 'Nat6', startIp: '2001:db8::1', endIp: '2001:db8::ffff' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { startIp: '2001:db8::1', endIp: '2001:db8::2' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid start or end IPv6', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', startIp: 'not-an-ip', endIp: '203.0.113.1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', startIp: '2001:db8::1', endIp: '2001:db8::2' } },
        { name: 'Dup', fields: { name: 'Dup', startIp: '2001:db8::3', endIp: '2001:db8::4' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidIpv6', () => {
  it('validates IPv6 addresses', () => {
    expect(isValidIpv6('2001:db8::1')).toBe(true)
    expect(isValidIpv6('::1')).toBe(true)
    expect(isValidIpv6('203.0.113.1')).toBe(false)
    expect(isValidIpv6('nope')).toBe(false)
  })
})

describe('extractIpPool6Specs', () => {
  it('trims fields', () => {
    const specs = extractIpPool6Specs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', startIp: '  2001:db8::1  ', endIp: '2001:db8::2' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].startIp).toBe('2001:db8::1')
  })
})
